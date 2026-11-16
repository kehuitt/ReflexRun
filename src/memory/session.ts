import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { RunTiming } from './timing.js';
import { join } from 'node:path';
import { FileJournal } from '../journal.js';
import type { Journal } from '../types.js';
import { ExperienceStore } from './store.js';
import { executeComposition } from './composition.js';
import { archiveTrace, check, compileExperience, decode, isEffect } from './compiler.js';
import { candidateHints, replayActions, sameRoute, taskGuards } from './program.js';
import { ActionExecution, PolicyFence, UncertainEffect } from './execution.js';
import type {
  Action,
  AgentTools,
  Check,
  Experience,
  Explorer,
  FactPlan,
  Host,
  MemoryEvent,
  MemoryResult,
  ParameterCandidate,
  Repairer,
  Task,
} from './types.js';

export type ReflexOptions = {
  store: ExperienceStore;
  host: Host;
  explore?: Explorer;
  repair?: Repairer;
  journal?: Journal;
  onEvent?: (event: MemoryEvent) => void;
  /** Called after successful business verification, before local learning. Must not throw. */
  onTaskComplete?: (result: MemoryResult) => void;
};

/** The original agent is the slow path. This layer owns memory and replay, not reasoning. */
export class Reflex {
  constructor(readonly options: ReflexOptions) {}
  async run(task: Task): Promise<MemoryResult> {
    if (!task.key || !task.job)
      throw new Error('A semantic task key and stable job ID are required');
    const injected = this.options.journal;
    const { journal, release } = injected
      ? { journal: injected, release: await injected.acquire() }
      : await FileJournal.openLocked(join(this.options.store.directory, 'intents.jsonl'));
    let result: MemoryResult | undefined;
    try {
      result = await this.execute(task, journal);
      return result;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!result) throw error;
        result.learning = 'failed';
        const cleanup = `Journal cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        result.learningError = [result.learningError, cleanup].filter(Boolean).join('; ');
        if (result.timings) delete result.timings.memoryReadyMs;
      }
    }
  }
  private async execute(task: Task, journal: Journal): Promise<MemoryResult> {
    const { host, store } = this.options;
    const timing = new RunTiming();
    const started = timing.started;
    const execution = new ActionExecution(
      host,
      task,
      await timing.measure('observationMs', () => host.observe()),
      [],
      this.options.onEvent,
      timing,
    );
    const startScope = execution.scope;
    let entryUrl = execution.state.url;
    const emit = (event: MemoryEvent) => this.options.onEvent?.(event);
    let delegations = 0,
      repairs = 0;
    let source: MemoryResult['source'] = 'memory';
    let memory: Experience | undefined;
    let applicability: Check | undefined;
    const verification = task.verification ?? 'task';
    const trace = execution.trace;
    const perform = (action: Action) => execution.perform(action, journal);
    const tools: AgentTools = {
      observe: (options) => execution.observe(options),
      act: (action) => perform(action),
    };
    let goal: Check | undefined;
    let saved: string | undefined;
    const episodeId = randomUUID();
    let archive = false;
    let verified = false;
    let parameterCandidates: ParameterCandidate[] | undefined;
    let parts: Experience['parts'];
    let completed: MemoryResult | undefined;
    try {
      execution.alive();
      execution.allowed(execution.state);
      if (verification === 'readback' && !task.readback)
        throw new Error(
          'Readback verification requires an independent host reader before any write',
        );
      const guards = taskGuards(task.inputs, task.guardInputs);
      if (task.learn && (task.batch || task.experience))
        throw new Error('Collect another example as a standalone exploration');
      let candidates = (
        await store.recall(task.key, startScope, task.inputs, task.constraints, task.batch)
      ).flatMap((memory) => {
        if (
          (task.experience && task.experience !== memory.id) ||
          Object.keys(guards).some((key) => !Object.hasOwn(memory.when ?? {}, key))
        )
          return [];
        const actions = replayActions(memory, host, task.inputs);
        return actions ? [{ memory, actions }] : [];
      });
      const entry = candidates[0]?.memory.entryUrl;
      if (entry && host.capabilities.includes('navigate')) {
        const url = String(decode(entry, task.inputs));
        if (
          !task.learn &&
          execution.state.url !== url &&
          candidates.every(({ memory: m }) => m.entryUrl && decode(m.entryUrl, task.inputs) === url)
        ) {
          execution.alive();
          execution.allowed(execution.state, { kind: 'navigate', url });
          execution.actions++;
          await host.act({ kind: 'navigate', url, effect: false });
          await execution.observe();
        }
      }
      candidates = candidates.filter(
        ({ memory: m }) =>
          !m.applicability || check(execution.state, decode(m.applicability, task.inputs) as Check),
      );
      const local = candidates.filter((c) => c.memory.adapter === host.id);
      const pool = local.length ? local : candidates;
      const first = pool[0];
      const ambiguous =
        !!first?.memory.adapter &&
        pool.some(({ memory: m }) => m.adapter && !sameRoute(first.memory, m));
      const selected = task.learn || ambiguous ? undefined : first;
      memory = selected?.memory;
      emit({
        type: 'recall',
        message: memory
          ? 'Reusable experience found'
          : ambiguous
            ? 'Successful routes overlap; the original agent must resolve this input'
            : 'No applicable experience; use a supplied composition or the original agent',
        data: { experience: memory?.id },
      });
      if (!memory) {
        if (task.compose) {
          source = 'composition';
          archive = true;
          parts = await executeComposition(tools, task, task.compose, store, host);
          goal = task.compose.goal;
        } else {
          if (task.batch)
            throw new Error(
              ambiguous
                ? 'Learned branches overlap for this input; resolve the route with the original agent'
                : 'No applicable healthy experience for this batch item',
            );
          if (!this.options.explore)
            throw new Error(
              'No memory hit. Supply the original Computer Use agent as explore(), or use the observe/act MCP tools.',
            );
          source = 'explore';
          delegations++;
          archive = true;
          emit({ type: 'explore', message: 'Original agent controls its first execution' });
          const learned = await this.options.explore({
            task,
            tools,
            memories: candidates.map((c) => c.memory),
          });
          goal = learned.goal;
          execution.factPlan ??= learned.factPlan;
          applicability = learned.applicability;
          parameterCandidates = learned.parameterCandidates;
        }
      } else {
        execution.factPlan ??= memory.factPlan
          ? (decode(memory.factPlan, task.inputs) as FactPlan)
          : undefined;
        applicability = memory.applicability
          ? (decode(memory.applicability, task.inputs) as Check)
          : undefined;
        if (memory.entryUrl && host.capabilities.includes('navigate')) {
          const url = String(decode(memory.entryUrl, task.inputs));
          if (execution.state.url !== url) {
            execution.alive();
            execution.allowed(execution.state, { kind: 'navigate', url });
            execution.actions++;
            await host.act({ kind: 'navigate', url, effect: false });
            await execution.observe();
          }
          entryUrl = url;
        }
        goal = decode(memory.goal, task.inputs) as Check;
        if (applicability && !check(execution.state, applicability))
          throw new Error('Experience applicability condition does not hold');
        for (let i = 0; i < memory.steps.length; i++) {
          const step = memory.steps[i];
          const action = selected!.actions[i];
          // Input-only chunks avoid a full observation between every field. Hosts retain
          // their own fresh locator/actionability checks; boundary actions still observe.
          const next = memory.steps[i + 1];
          const nextAction = selected!.actions[i + 1];
          const chunk =
            ['fill', 'select', 'check'].includes(action.kind) &&
            !step.effect &&
            nextAction &&
            ['fill', 'select', 'check'].includes(nextAction.kind) &&
            !next!.effect;
          const finalAttempt = i === memory.steps.length - 1 && verification === 'attempt';
          // Check this action's outcome first. The next step can prepare from that same
          // live observation when it has no snapshot reference to ground.
          const shareAfter =
            !!host.observeUntil &&
            nextAction?.effect &&
            [nextAction.target, nextAction.to, ...Object.values(nextAction.bindings ?? {})].every(
              (target) => !target?.ref,
            );
          try {
            await execution.perform(action, journal, {
              observeAfter: !chunk && !finalAttempt,
              replay: true,
              shareAfter,
            });
          } catch (e) {
            if (e instanceof PolicyFence || e instanceof UncertainEffect) throw e;
            if (!memory.adapter || memory.adapter === host.id) {
              const reason = e instanceof Error ? e.message : String(e);
              for (const { memory: peer } of pool) {
                if (
                  peer.id === memory.id ||
                  (peer.adapter === memory.adapter && sameRoute(peer, memory))
                )
                  await store.quarantine(peer.id, reason);
              }
            }
            if (!this.options.repair || repairs >= (task.maxRepairs ?? 2)) throw e;
            await execution.observe();
            repairs++;
            delegations++;
            archive = true;
            source = 'repair';
            emit({
              type: 'repair',
              message: 'Changed UI delegated to the original agent',
              data: { step: i },
            });
            const replacement = await this.options.repair({
              task,
              observation: execution.state,
              failed: action,
              error: e instanceof Error ? e.message : String(e),
              experience: memory,
              step: i,
            });
            if (!replacement) throw e;
            if (replacement.length > 20)
              throw new Error('Repair patch exceeds its bounded action budget');
            const effectCount = replacement.filter((a) => isEffect(a, execution.state)).length;
            if (effectCount > (step.effect ? 1 : 0))
              throw new PolicyFence('Repair attempted to expand the authorized effect boundary');
            for (const a of replacement) await perform(a);
          }
        }
      }
      const completion = await execution.complete(goal, source);
      const { goal: boundGoal, checkUI, readback } = completion;
      verified = completion.verified;
      const shouldLearn = archive && (verified || (task.batch && !readback));
      const result: MemoryResult = (completed = {
        status: readback
          ? readback.status === 'confirmed'
            ? 'completed'
            : readback.status === 'rejected'
              ? 'failed'
              : 'uncertain'
          : (verification === 'batch' || verification === 'attempt') && source !== 'explore'
            ? 'attempted'
            : 'completed',
        evidence: readback ? 'readback' : checkUI ? 'ui-postcondition' : 'none',
        verification,
        ...(readback ? { outcome: readback.status, readbackSource: readback.source } : {}),
        source,
        experience: memory?.id,
        actions: execution.actions,
        hostDelegations: delegations,
        repairs,
        effectAttempts: execution.effectAttempts,
        ...(shouldLearn ? { learning: 'pending' as const } : {}),
        elapsedMs: timing.elapsed(),
      });
      if (verified) timing.values.taskReadyMs = timing.elapsed();
      result.timings = timing.snapshot();
      if (verified && source === 'explore') {
        this.options.onTaskComplete?.({ ...result, timings: timing.snapshot() });
        // Yield the tool response before compiling. No more UI calls occur on this path.
        if (this.options.onTaskComplete) await setImmediate();
      }
      if (shouldLearn) {
        try {
          parameterCandidates = timing.sync('compileMs', () =>
            candidateHints(trace, parameterCandidates),
          );
          const experience = timing.sync('compileMs', () =>
            compileExperience({
              key: task.key,
              scope: startScope,
              inputs: task.inputs,
              trace,
              goal: boundGoal,
              episode: episodeId,
              parent: memory?.id,
              entryUrl,
              constraints: task.constraints,
              factPlan: execution.factPlan,
              applicability,
              host,
              guards: { ...memory?.when, ...guards },
            }),
          );
          if (parts) experience.parts = parts;
          await timing.measure('persistMs', () =>
            task.batch
              ? store.stage(
                  task.batch,
                  experience,
                  task.job,
                  readback ? 'readback' : checkUI ? 'ui-postcondition' : 'attempt',
                )
              : store.save(experience),
          );
          saved = experience.id;
          result.experience = saved;
          emit({
            type: 'learned',
            message: task.batch
              ? 'Repair staged for immediate reuse in this batch; final audit gates promotion'
              : 'Successful path persisted; exploration retained separately',
            data: {
              id: saved,
              steps: experience.steps.length,
              pruned: experience.eliminatedActions,
            },
          });
        } catch (error) {
          result.learning = 'failed';
          result.learningError = error instanceof Error ? error.message : String(error);
        }
      }
      if (memory)
        await timing.measure('persistMs', () => store.feedback(memory!.id, result, task.inputs));
      emit({
        type: 'reused',
        message: result.status,
        data: { source, actions: execution.actions, hostDelegations: delegations },
      });
      return result;
    } catch (e) {
      if (completed) {
        completed.learning = 'failed';
        completed.learningError = e instanceof Error ? e.message : String(e);
        return completed;
      }
      const result: MemoryResult = {
        status:
          execution.uncertain ||
          e instanceof UncertainEffect ||
          (e instanceof PolicyFence && execution.effectAttempts > 0)
            ? 'uncertain'
            : e instanceof PolicyFence
              ? 'skipped'
              : 'failed',
        evidence: 'none',
        source,
        experience: memory?.id,
        actions: execution.actions,
        repairs,
        hostDelegations: delegations,
        effectAttempts: execution.effectAttempts,
        elapsedMs: Math.round(performance.now() - started),
        error: e instanceof Error ? e.message : String(e),
      };
      if (memory) await store.feedback(memory.id, result);
      emit({ type: 'interrupted', message: result.error! });
      return result;
    } finally {
      if (archive) {
        try {
          const episode = timing.sync('compileMs', () => ({
            format: 2 as const,
            id: episodeId,
            key: task.key,
            scope: startScope,
            createdAt: new Date().toISOString(),
            inputNames: Object.keys(task.inputs),
            trace: archiveTrace(trace, task.inputs),
            success: !!saved,
            verified,
            parameterCandidates,
            source:
              source === 'repair'
                ? ('repair' as const)
                : source === 'composition'
                  ? ('composition' as const)
                  : ('explore' as const),
          }));
          await timing.measure('persistMs', () => store.saveEpisode(episode, task.inputs));
        } catch (error) {
          if (!completed) throw error;
          completed.learning = 'failed';
          completed.learningError = error instanceof Error ? error.message : String(error);
        }
      }
      if (completed) {
        if (saved && completed.learning !== 'failed') {
          completed.learning = 'ready';
          timing.values.memoryReadyMs = timing.elapsed();
        }
        completed.timings = timing.snapshot();
        completed.elapsedMs = timing.elapsed();
      }
    }
  }
}
