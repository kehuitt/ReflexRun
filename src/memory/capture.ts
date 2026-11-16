import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FileJournal } from '../journal.js';
import { archiveTrace, compileExperience } from './compiler.js';
import { candidateHints, taskGuards } from './program.js';
import { ActionExecution, UncertainEffect } from './execution.js';
import { ExperienceStore } from './store.js';
import type {
  Action,
  Check,
  Host,
  LearningDetails,
  Observation,
  Task,
  TraceStep,
} from './types.js';

/** Tool-call middleware, safe across host RPC turns: no pending background UI continuation. */
export class TaskCapture {
  readonly trace: TraceStep[] = [];
  private initial?: Observation;
  private execution?: ActionExecution;
  private closed = false;
  constructor(
    readonly host: Host,
    readonly store: ExperienceStore,
    readonly task: Task,
  ) {
    if (!task.key || !task.job)
      throw new Error('A semantic task key and stable job ID are required');
    if (task.batch) throw new Error('Use BatchBridge for batch capture and final promotion');
    taskGuards(task.inputs, task.guardInputs);
    if (task.verification === 'readback' && !task.readback)
      throw new Error('Readback verification requires an independent host reader before any write');
  }
  async observe(options?: { fresh?: boolean }) {
    const state = await this.host.observe(options);
    this.initial ??= state;
    this.execution ??= new ActionExecution(this.host, this.task, state, this.trace);
    this.execution.state = state;
    this.execution.allowed(state);
    return state;
  }
  async act(input: Action) {
    if (this.closed) throw new Error('Task capture is closed');
    if (this.trace.length >= (this.task.maxActions ?? 200))
      throw new Error('Task action budget reached');
    const { journal, release } = await FileJournal.openLocked(
      join(this.store.directory, 'intents.jsonl'),
    );
    try {
      await this.observe();
      return await this.execution!.perform(input, journal);
    } finally {
      await release();
    }
  }
  async complete(goal: Check, details: LearningDetails = {}) {
    if (this.closed) throw new Error('Task capture is closed');
    if (this.execution?.uncertain)
      throw new Error('An uncertain effect must be reconciled; do not promote this path');
    try {
      const result = await learnFromTrace({
        host: this.host,
        store: this.store,
        task: this.task,
        trace: this.trace,
        goal,
        ...details,
      });
      this.closed = true;
      return result;
    } catch (error) {
      if (error instanceof UncertainEffect && this.execution) this.execution.uncertain = true;
      throw error;
    }
  }
  /** Call from the original agent's unsuccessful-task hook. Never promotes a partial path. */
  async abort() {
    if (this.closed) return;
    this.closed = true;
    await this.store.saveEpisode({
      format: 2,
      id: randomUUID(),
      key: this.task.key,
      scope: this.initial?.scope ?? this.host.id,
      createdAt: new Date().toISOString(),
      inputNames: Object.keys(this.task.inputs),
      trace: archiveTrace(this.trace, this.task.inputs),
      success: false,
      source: 'explore',
    });
  }
}

/** Import the original host's existing action log; verify live completion before promotion. */
export async function learnFromTrace(
  args: {
    host: Host;
    store: ExperienceStore;
    task: Task;
    trace: TraceStep[];
    goal: Check;
  } & LearningDetails,
) {
  if (args.task.batch) throw new Error('Use BatchBridge for batch capture and final promotion');
  const state = await args.host.observe();
  const scope = args.trace[0]?.before.scope ?? state.scope;
  const allowed = args.task.allowedScopes ?? [scope];
  if (
    [
      state,
      ...args.trace.flatMap((step) => (step.after ? [step.before, step.after] : [step.before])),
    ].some((state) => !allowed.includes(state.scope))
  )
    throw new Error('Trace left the authorized scope');
  if (args.trace.some((step) => !args.host.capabilities.includes(step.action.kind)))
    throw new Error('Trace includes an unsupported host action');
  const execution = new ActionExecution(args.host, args.task, state, args.trace);
  const { goal, verified, readback } = await execution.complete(args.goal, 'explore');
  if (!verified) {
    const message = 'Independent readback did not confirm the captured task';
    throw readback?.status === 'unknown' ? new UncertainEffect(message) : new Error(message);
  }
  const id = randomUUID();
  const episode = {
    format: 2 as const,
    id,
    key: args.task.key,
    scope,
    createdAt: new Date().toISOString(),
    inputNames: Object.keys(args.task.inputs),
    trace: archiveTrace(args.trace, args.task.inputs),
    verified: true,
    parameterCandidates: candidateHints(args.trace, args.parameterCandidates),
    source: 'explore' as const,
  };
  let success = false;
  try {
    const memory = compileExperience({
      key: args.task.key,
      scope,
      trace: args.trace,
      inputs: args.task.inputs,
      goal,
      episode: id,
      entryUrl: args.trace[0]?.before.url,
      constraints: args.task.constraints,
      factPlan: args.factPlan ?? args.task.factPlan,
      applicability: args.applicability,
      host: args.host,
      guards: taskGuards(args.task.inputs, args.task.guardInputs),
    });
    await args.store.save(memory);
    success = true;
    return memory;
  } finally {
    await args.store.saveEpisode({ ...episode, success }, args.task.inputs);
  }
}
