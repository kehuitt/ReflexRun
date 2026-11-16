import type { RunTimings } from './types.js';

type Component = 'observationMs' | 'checkMs' | 'compileMs' | 'persistMs';

/** Per-run, exclusive component timings; model/tool waits are not inferred as local work. */
export class RunTiming {
  readonly started = performance.now();
  readonly values: RunTimings = { observationMs: 0, checkMs: 0, compileMs: 0, persistMs: 0 };
  private total() {
    return (
      this.values.observationMs +
      this.values.checkMs +
      this.values.compileMs +
      this.values.persistMs
    );
  }
  async measure<T>(component: Component, run: () => Promise<T>): Promise<T> {
    const at = performance.now(),
      before = this.total();
    try {
      return await run();
    } finally {
      this.values[component] += Math.max(0, performance.now() - at - (this.total() - before));
    }
  }
  sync<T>(component: Component, run: () => T): T {
    const at = performance.now(),
      before = this.total();
    try {
      return run();
    } finally {
      this.values[component] += Math.max(0, performance.now() - at - (this.total() - before));
    }
  }
  elapsed() {
    return performance.now() - this.started;
  }
  snapshot(): RunTimings {
    return { ...this.values };
  }
}
