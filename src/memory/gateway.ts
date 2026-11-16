import { Reflex } from './session.js';
import { ExperienceStore } from './store.js';
import type {
  Action,
  AgentTools,
  Check,
  Host,
  LearningDetails,
  MemoryResult,
  Observation,
  Repairer,
  Task,
} from './types.js';
import { runMemoryBatch, type BatchOptions, type BatchState } from './batch.js';

class Notices<T> {
  private queued: T[] = [];
  private waiting?: (notice: T) => void;
  publish(notice: T) {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(notice);
    } else this.queued.push(notice);
  }
  next(): Promise<T> {
    const notice = this.queued.shift();
    return notice
      ? Promise.resolve(notice)
      : new Promise((resolve) => {
          this.waiting = resolve;
        });
  }
}

function followAbort(signal: AbortSignal | undefined, cancel: () => void) {
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return () => signal?.removeEventListener('abort', cancel);
}

export type Notice =
  | { mode: 'explore'; observation: Observation }
  | { mode: 'repair'; observation: Observation; failed: Action; step: number; error: string }
  | { mode: 'done'; result: MemoryResult };

/** A tool-proxy session: the existing agent explores only on a miss and patches only on drift. */
export class AgentBridge {
  private tools?: AgentTools;
  private finishExploration?: (result: { goal: Check } & LearningDetails) => void;
  private finishRepair?: (actions: Action[] | null) => void;
  private notices = new Notices<Notice>();
  private controller = new AbortController();
  private result?: Promise<MemoryResult>;
  private activeAction?: Promise<Observation>;
  private taskReady = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly host: Host,
    readonly store: ExperienceStore,
    readonly task: Task,
  ) {}
  async start(): Promise<Notice> {
    if (this.result) throw new Error('Task already started');
    const repair: Repairer = async (context) =>
      new Promise((resolve) => {
        this.finishRepair = resolve;
        this.notices.publish({
          mode: 'repair',
          observation: context.observation,
          failed: context.failed,
          step: context.step,
          error: context.error,
        });
      });
    const reflex = new Reflex({
      host: this.host,
      store: this.store,
      onTaskComplete: (result) => {
        this.taskReady = true;
        this.notices.publish({ mode: 'done', result });
      },
      explore: async ({ tools }) => {
        this.tools = tools;
        const state = await tools.observe();
        if (this.controller.signal.aborted) return { goal: { text: '__canceled_reflex_task__' } };
        return new Promise((resolve) => {
          this.finishExploration = resolve;
          this.notices.publish({ mode: 'explore', observation: state });
        });
      },
      repair,
    });
    this.timer = setTimeout(() => this.cancel(), 300_000);
    this.timer.unref();
    const unfollow = followAbort(this.task.signal, () => this.cancel());
    this.result = reflex.run({ ...this.task, signal: this.controller.signal }).catch((error) => ({
      status: 'failed',
      evidence: 'none',
      source: 'memory',
      actions: 0,
      hostDelegations: 0,
      repairs: 0,
      elapsedMs: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    void this.result.then((result) => {
      clearTimeout(this.timer);
      unfollow();
      if (!this.taskReady) this.notices.publish({ mode: 'done', result });
    });
    return this.notices.next();
  }
  /** Waits for local learning only; successful task completion has already been reported. */
  async waitForLearning() {
    if (!this.result) throw new Error('No task started');
    return this.result;
  }
  async observe() {
    return this.tools ? this.tools.observe() : this.host.observe();
  }
  async act(action: Action) {
    if (!this.finishExploration || !this.tools)
      throw new Error(
        'Direct actions are allowed only while the original agent is exploring. Submit a bounded patch during repair.',
      );
    if (this.activeAction) throw new Error('Await the previous action before dispatching another');
    const pending = this.tools.act(action);
    this.activeAction = pending;
    try {
      return await pending;
    } finally {
      this.activeAction = undefined;
    }
  }
  private async endExploration(result: { goal: Check } & LearningDetails) {
    const resolve = this.finishExploration;
    if (!resolve) return false;
    this.finishExploration = undefined;
    // The original tool call owns the UI action. Do not release its journal lock
    // until the action, post-observation and intent write have all settled.
    await this.activeAction?.catch(() => {});
    resolve(result);
    return true;
  }
  async complete(goal: Check, details: LearningDetails = {}): Promise<Notice> {
    if (!(await this.endExploration({ goal, ...details })))
      throw new Error('No exploration is awaiting completion');
    return this.notices.next();
  }
  async patch(actions: Action[] | null): Promise<Notice> {
    if (!this.finishRepair) throw new Error('No changed step is awaiting a patch');
    const resolve = this.finishRepair;
    this.finishRepair = undefined;
    resolve(actions);
    return this.notices.next();
  }
  cancel() {
    this.controller.abort();
    this.finishRepair?.(null);
    this.finishRepair = undefined;
    void this.endExploration({ goal: { text: '__canceled_reflex_task__' } });
  }
  async stop() {
    this.cancel();
    return this.result;
  }
}

export type BatchNotice =
  | Exclude<Notice, { mode: 'done' } | { mode: 'explore' }>
  | { mode: 'done'; batch?: BatchState; error?: string };

/** Pauses one representative item for the original agent, then resumes the same durable queue. */
export class BatchBridge {
  private controller = new AbortController();
  private result?: Promise<BatchState>;
  private finishRepair?: (actions: Action[] | null) => void;
  private notices = new Notices<BatchNotice>();
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly host: Host,
    readonly store: ExperienceStore,
    readonly options: BatchOptions,
  ) {}
  async start() {
    if (this.running) throw new Error('Batch already started');
    this.running = true;
    const reflex = new Reflex({
      host: this.host,
      store: this.store,
      repair: async (context) =>
        new Promise((resolve) => {
          this.finishRepair = resolve;
          this.notices.publish({
            mode: 'repair',
            observation: context.observation,
            failed: context.failed,
            step: context.step,
            error: context.error,
          });
        }),
    });
    this.timer = setTimeout(() => this.cancel(), this.options.timeoutMs ?? 180_000);
    this.timer.unref();
    const unfollow = followAbort(this.options.signal, () => this.cancel());
    this.result = runMemoryBatch(reflex, { ...this.options, signal: this.controller.signal });
    void this.result
      .then(
        (batch) => this.notices.publish({ mode: 'done', batch }),
        (error) => this.notices.publish({ mode: 'done', error: String(error) }),
      )
      .finally(() => {
        clearTimeout(this.timer);
        unfollow();
      });
    return this.notices.next();
  }
  /** Wait for cancellation and the final queue writes before closing the host. */
  async waitForCompletion() {
    return this.result;
  }
  async patch(actions: Action[] | null) {
    if (!this.finishRepair) throw new Error('No batch repair is pending');
    const resolve = this.finishRepair;
    this.finishRepair = undefined;
    resolve(actions);
    return this.notices.next();
  }
  cancel() {
    this.controller.abort();
    this.finishRepair?.(null);
    this.finishRepair = undefined;
  }
}
