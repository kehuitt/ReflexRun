import { AgentBridge, type Notice } from '../memory/gateway.js';
import { ExperienceStore } from '../memory/store.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Check, Task, Action, LearningDetails } from '../memory/types.js';
import {
  PlaywrightMcpHost,
  type NativeCall,
  type ToolPort,
  type Authorize,
  type ProxyOptions,
} from './playwright.js';

/** Only task boundaries are added. The agent keeps calling its original browser tools. */
export class ToolProxy {
  readonly host: PlaywrightMcpHost;
  private bridge?: AgentBridge;
  private mode?: Notice['mode'];
  private unsupported?: string;
  private captured: Action[] = [];
  private pendingCalls = new Set<Promise<CallToolResult>>();
  private cancellation?: Promise<void>;
  private starting?: Promise<Notice>;
  private generation = 0;
  constructor(
    port: ToolPort,
    readonly store: ExperienceStore,
    authorize?: Authorize,
    options?: ProxyOptions,
  ) {
    this.host = new PlaywrightMcpHost(port, authorize, options);
  }
  async begin(task: Task) {
    this.assertStarting(task, this.generation);
    if (this.bridge?.task.signal?.aborted) this.cancel();
    const generation = this.generation,
      priorCancellation = this.cancellation;
    const abort = () => {
      void this.cancel();
    };
    task.signal?.addEventListener('abort', abort, { once: true });
    let pending: Promise<Notice> | undefined;
    try {
      if (this.starting) {
        if (!priorCancellation) throw new Error('Another task is starting; await it first');
        await priorCancellation;
      }
      this.assertStarting(task, generation);
      if (this.starting) throw new Error('Another task is starting; await it first');
      pending = this.beginTask(task, generation, priorCancellation);
      this.starting = pending;
      return await pending;
    } finally {
      if (this.starting === pending) this.starting = undefined;
      task.signal?.removeEventListener('abort', abort);
    }
  }
  private assertStarting(task: Task, generation: number) {
    if (task.signal?.aborted || generation !== this.generation)
      throw new Error('Task was canceled before starting');
  }
  private async beginTask(
    task: Task,
    generation: number,
    priorCancellation: Promise<void> | undefined,
  ) {
    // Snapshot the earlier cancellation: a new cancel waits for this start too.
    await priorCancellation;
    this.assertStarting(task, generation);
    if (this.bridge && this.mode !== 'done')
      throw new Error('Complete or cancel the current task first');
    await Promise.allSettled([...this.pendingCalls]);
    this.assertStarting(task, generation);
    const previous = await this.bridge?.waitForLearning();
    this.assertStarting(task, generation);
    if (previous?.learning === 'failed') {
      this.bridge = undefined;
      throw new Error(
        `Previous task completed, but its experience was not ready: ${previous.learningError}. Retry the task to explore again.`,
      );
    }
    this.host.reset();
    this.cancellation = undefined;
    this.host.phase = 'replay';
    this.unsupported = undefined;
    this.captured = [];
    const state = await this.host.observe({ fresh: true });
    this.assertStarting(task, generation);
    this.bridge = new AgentBridge(this.host, this.store, {
      ...task,
      allowedScopes: task.allowedScopes ?? [state.scope, 'about:blank'],
      beforeEffect: async (action, observation, plan) =>
        (!task.beforeEffect || (await task.beforeEffect(action, observation, plan))) &&
        (await this.host.authorizeEffect(action)),
    });
    return this.notice(await this.bridge.start());
  }
  private notice(notice: Notice) {
    this.mode = notice.mode;
    this.host.phase = notice.mode === 'explore' ? 'capture' : 'replay';
    return notice;
  }
  async call(call: NativeCall) {
    const pending = this.cancellation
      ? this.cancellation.then(() => this.dispatch(call))
      : this.dispatch(call);
    this.pendingCalls.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingCalls.delete(pending);
    }
  }
  private async dispatch(call: NativeCall) {
    const bridge = this.bridge;
    if (!bridge || this.mode === 'done' || this.unsupported || this.host.isReadOnly(call))
      return this.host.forward(call);
    if (this.mode !== 'explore')
      throw new Error(
        'A replay is paused for a bounded repair; submit reflex_patch instead of a direct write',
      );
    let action: Action;
    try {
      action = await this.host.translate(call);
    } catch (e) {
      if (this.cancellation || this.bridge !== bridge)
        throw new Error('Native call was canceled before dispatch');
      this.unsupported = e instanceof Error ? e.message : String(e);
      await bridge.stop();
      return this.host.forward(call); // Full upstream protocol still works; this episode cannot be promoted.
    }
    if (this.cancellation || this.bridge !== bridge)
      throw new Error('Native call was canceled before dispatch');
    action.argInputs = {};
    this.captured.push(action);
    const previous = this.host.lastResult;
    try {
      await bridge.act(action);
    } catch (e) {
      if (this.host.lastResult !== previous && this.host.lastResult?.isError)
        return this.host.lastResult;
      throw e;
    }
    return this.host.lastResult!;
  }
  async finish(
    goal: Check,
    bindings: Record<string, Record<string, string>> = {},
    details?: LearningDetails,
  ) {
    const bridge = this.bridge;
    if (!bridge) throw new Error('No task is active');
    await Promise.allSettled([...this.pendingCalls]);
    if (this.cancellation || this.bridge !== bridge)
      throw new Error('The task was canceled before completion');
    if (this.unsupported) {
      this.mode = 'done';
      return { mode: 'unlearned', reason: this.unsupported };
    }
    for (const [step, paths] of Object.entries(bindings)) {
      const action = this.captured[Number(step)];
      if (!action) throw new Error('Unknown captured step');
      Object.assign(action.argInputs!, paths);
    }
    const notice = await bridge.complete(goal, details);
    return this.bridge === bridge ? this.notice(notice) : notice;
  }
  async patch(calls: NativeCall[] | null) {
    const bridge = this.bridge;
    if (!bridge) throw new Error('No task is active');
    const actions = calls
      ? await Promise.all(calls.map((call) => this.host.translate(call)))
      : null;
    if (this.cancellation || this.bridge !== bridge)
      throw new Error('The task was canceled before patching');
    const notice = await bridge.patch(actions);
    return this.bridge === bridge ? this.notice(notice) : notice;
  }
  /** Explicit final learning status; no task is represented by undefined. */
  async waitForLearning() {
    await this.cancellation;
    return this.bridge?.waitForLearning();
  }
  cancel() {
    this.generation++;
    const priorCancellation = this.cancellation;
    const bridge = this.bridge;
    bridge?.cancel();
    this.cancellation = Promise.allSettled([
      priorCancellation,
      this.starting,
      ...this.pendingCalls,
      bridge?.waitForLearning(),
    ]).then(() => {
      if (this.bridge === bridge) this.mode = 'done';
    });
    return this.cancellation;
  }
}
export { PlaywrightMcpHost, fromPlaywrightSnapshot } from './playwright.js';
export type { NativeCall, ToolPort, Authorize, ProxyOptions, ProxyTiming } from './playwright.js';
