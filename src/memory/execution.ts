import { createHash } from 'node:crypto';
import { RunTiming } from './timing.js';
import type { Entry, Journal } from '../types.js';
import { bindInput, check, elementFor, ground, isEffect } from './compiler.js';
import type {
  Action,
  Check,
  FactPlan,
  Host,
  Intent,
  MemoryEvent,
  MemoryResult,
  Observation,
  Target,
  Task,
  TraceStep,
} from './types.js';

export class UncertainEffect extends Error {}
export class PolicyFence extends Error {}

/** Shared dispatch rules; callers retain their whole-task or per-RPC journal lock. */
export class ActionExecution {
  readonly scope: string;
  readonly scopes: string[];
  factPlan?: FactPlan;
  actions: number;
  effects: number;
  effectAttempts: number;
  uncertain: boolean;
  private sharedObservation?: Observation;
  constructor(
    readonly host: Host,
    readonly task: Task,
    public state: Observation,
    readonly trace: TraceStep[] = [],
    private readonly emit?: (event: MemoryEvent) => void,
    readonly timing = new RunTiming(),
  ) {
    this.scope = trace[0]?.before.scope ?? state.scope;
    this.scopes = task.allowedScopes ?? [this.scope];
    this.factPlan = task.factPlan;
    this.actions = trace.filter((s) => s.dispatched).length;
    this.effects = trace.filter(
      (s) => s.dispatched && !s.error && isEffect(s.action, s.before),
    ).length;
    this.effectAttempts = trace.filter((s) => s.dispatched && isEffect(s.action, s.before)).length;
    this.uncertain = trace.some((s) => s.dispatched && s.error && isEffect(s.action, s.before));
  }
  alive() {
    if (this.task.signal?.aborted) throw new PolicyFence('Task canceled');
    if (this.actions >= (this.task.maxActions ?? 200))
      throw new PolicyFence('Task action budget reached');
  }
  allowed(state: Observation, action?: Action) {
    if (!this.scopes.includes(state.scope)) throw new PolicyFence('Host left the authorized scope');
    if (
      action?.url &&
      /^https?:/.test(action.url) &&
      !this.scopes.includes(new URL(action.url).origin)
    )
      throw new PolicyFence('Navigation leaves the authorized scope');
  }
  async observe(options?: { fresh?: boolean }) {
    this.state = await this.timing.measure('observationMs', () => this.host.observe(options));
    this.allowed(this.state);
    return this.state;
  }
  async perform(
    input: Action,
    journal: Journal,
    { observeAfter = true, replay = false, shareAfter = false } = {},
  ) {
    this.alive();
    let before = this.state;
    const shared = replay && this.sharedObservation === before ? before : undefined;
    this.sharedObservation = undefined;
    let action = input,
      dispatched = false;
    let reservation: Entry | undefined;
    const at = performance.now();
    try {
      action = bindInput(ground(input, before), this.task.inputs);
      if (!this.host.capabilities.includes(action.kind))
        throw new Error(`Host does not support ${action.kind}`);
      if (action.submit && (action.kind !== 'fill' || !this.host.acceptsIntent?.(action as Intent)))
        throw new Error('Host does not support a combined fill and submit action');
      action.effect = isEffect(action, before);
      this.allowed(before, action);
      const targets = [action.target, action.to, ...Object.values(action.bindings ?? {})].filter(
        (target): target is Target => !!target,
      );
      const waitForTarget =
        replay &&
        this.host.observeUntil &&
        (targets.length > 0 || shared) &&
        targets.every((t) => !t.ref);
      if (waitForTarget) {
        const ready = (state: Observation) => {
          this.allowed(state, action);
          this.alive();
          if (!action.effect && state.url !== before.url)
            throw new PolicyFence('Replay source page changed before dispatch');
          return targets.every((target) => {
            const element = elementFor(target, state);
            return element && !element.disabled;
          });
        };
        this.state = await this.timing.measure('observationMs', () =>
          this.host.observeUntil!(ready, action, shared),
        );
        if (!ready(this.state)) throw new Error('Replay target is not ready before dispatch');
      } else if (action.effect) await this.observe({ fresh: true });
      if (replay && (action.effect || waitForTarget)) before = this.state;
      if (action.effect) {
        this.allowed(this.state, action);
        if (action.target && !elementFor(action.target, this.state))
          throw new Error('Commit target changed or is ambiguous before dispatch');
        if (Object.values(action.bindings ?? {}).some((target) => !elementFor(target, this.state)))
          throw new Error('A tool argument target changed or is ambiguous before dispatch');
        if (this.state.elements.some((element) => element.invalid && !element.disabled))
          throw new Error(
            'The form has an invalid or newly required field; repair before dispatch',
          );
        if (this.uncertain) throw new UncertainEffect('An earlier effect needs reconciliation');
        if (
          this.task.beforeEffect &&
          !(await this.task.beforeEffect(action, this.state, this.factPlan))
        )
          throw new PolicyFence('Current batch policy or live facts revoked this effect');
        this.alive();
        const key = createHash('sha256')
          .update(`${this.scope}\0${this.task.key}\0${this.task.job}\0${this.effects}`)
          .digest('hex');
        const prior = journal.get(key);
        if (prior) {
          this.uncertain = true;
          throw new UncertainEffect(
            `Effect ${this.effects} already has an intent (${prior.state}); reconcile instead of replaying`,
          );
        }
        reservation = {
          key,
          id: `${this.task.job}:${this.effects}`,
          label: this.task.key,
          state: 'reserved',
          revision: 1,
          at: new Date().toISOString(),
        };
        await journal.put(reservation);
        this.alive();
        if (
          this.task.beforeEffect &&
          !(await this.task.beforeEffect(action, this.state, this.factPlan))
        )
          throw new PolicyFence('Policy changed while intent was persisted');
      }
      this.actions++;
      this.emit?.({
        type: 'action',
        message: action.kind,
        data: { index: this.actions, effect: !!action.effect },
      });
      // An error after invoking the host cannot establish that no write occurred.
      dispatched = true;
      if (action.effect) this.effectAttempts++;
      await this.host.act(action);
      if (reservation) {
        this.effects++;
        await journal.put({ ...reservation, state: 'attempted' });
      }
      if (observeAfter) {
        await this.observe();
        if (shareAfter) this.sharedObservation = this.state;
      }
      this.trace.push({
        action,
        before,
        after: observeAfter ? this.state : undefined,
        dispatched,
        durationMs: performance.now() - at,
      });
      return this.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reservation) {
        await journal.put({ ...reservation, state: 'unknown', note: message });
        if (dispatched) {
          this.uncertain = true;
          error = new UncertainEffect(message);
        }
      }
      this.trace.push({
        action,
        before,
        error: message,
        dispatched,
        durationMs: performance.now() - at,
      });
      throw error;
    }
  }
  async complete(goal: Check | undefined, source: MemoryResult['source']) {
    return this.timing.measure('checkMs', () => this.verify(goal, source));
  }
  private async verify(goal: Check | undefined, source: MemoryResult['source']) {
    if (this.uncertain)
      throw new UncertainEffect('Reconcile the uncertain effect before declaring success');
    if (this.task.signal?.aborted) throw new PolicyFence('Task canceled');
    if (!goal) throw new Error('The original agent must return an observable completion condition');
    const verification = this.task.verification ?? 'task';
    let goalState = this.state;
    if (verification === 'readback' && goal.target?.ref) {
      const observed = [
        ...this.trace.flatMap((step) => (step.after ? [step.before, step.after] : [step.before])),
        this.state,
      ].filter((state) => elementFor(goal.target, state));
      if (
        new Set(observed.map((state) => JSON.stringify(elementFor(goal.target, state)!.locator)))
          .size > 1
      )
        throw new Error(
          'Completion reference is ambiguous across observations; use a semantic condition',
        );
      goalState = observed.at(-1) ?? this.state;
    }
    const boundGoal = goal.target?.ref
      ? { ...goal, target: ground({ kind: 'wait', target: goal.target }, goalState).target }
      : goal;
    const checkUI =
      verification !== 'readback' &&
      (verification === 'task' ||
        source === 'explore' ||
        (source === 'repair' && verification === 'batch'));
    if (checkUI) {
      await this.observe({ fresh: true });
      if (!check(this.state, boundGoal))
        throw this.effects
          ? new UncertainEffect(
              'Completion condition did not hold after dispatch; reconcile before retry',
            )
          : new Error('Completion condition did not hold; no new experience was promoted');
    }
    let readback: Awaited<ReturnType<NonNullable<Task['readback']>>> | undefined;
    if (verification === 'readback') {
      if (!this.task.readback)
        throw new Error(
          'Readback verification requires an independent host reader before any write',
        );
      try {
        readback = await this.task.readback();
      } catch (error) {
        throw new UncertainEffect(
          `Independent readback unavailable after dispatch: ${String(error)}`,
        );
      }
    }
    if (readback && !readback.source.trim())
      throw this.effects
        ? new UncertainEffect('Readback must name its evidence source')
        : new Error('Readback must name its evidence source');
    return {
      goal: boundGoal,
      checkUI,
      readback,
      verified: readback ? readback.status === 'confirmed' : checkUI,
    };
  }
}
