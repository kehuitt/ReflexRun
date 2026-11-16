import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskCapture, learnFromTrace } from '../src/memory/capture.js';
import { RunTiming } from '../src/memory/timing.js';
import { MemoryJournal } from '../src/journal.js';
import { observation } from '../src/memory/compiler.js';
import { Reflex } from '../src/memory/session.js';
import { ActionExecution } from '../src/memory/execution.js';
import { ExperienceStore } from '../src/memory/store.js';
import type { Action, Host, MemoryResult, Readback, Task } from '../src/memory/types.js';

const element = (ref: string, role: string, name: string) => ({
  ref,
  role,
  name,
  locator: { role, name },
});
const state = (text: string, elements = [element('save', 'button', 'Save')]) =>
  observation({ surface: 'tool', scope: 'fixture', title: '', text, elements });

async function directory(run: (store: ExperienceStore) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'reflex-execution-'));
  try {
    await run(new ExperienceStore(path));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

test('A non-effect replay input cannot follow a same-scope route change while waiting', async () => {
  const original = { ...state('Ready', []), url: 'https://fixture.example.test/original' };
  const other = {
    ...state('Ready', [element('details', 'textbox', 'Details')]),
    url: 'https://fixture.example.test/other',
  };
  let writes = 0;
  const host: Host = {
    id: 'replay-fixture',
    capabilities: ['fill'],
    observe: async () => original,
    observeUntil: async (ready) => {
      assert.equal(ready(original), false);
      ready(other);
      return other;
    },
    act: async () => {
      writes++;
    },
  };
  const execution = new ActionExecution(host, { key: 'edit', job: 'replay', inputs: {} }, original);
  await assert.rejects(
    execution.perform(
      { kind: 'fill', target: { role: 'textbox', name: 'Details' }, value: 'Draft', effect: false },
      new MemoryJournal(),
      { replay: true },
    ),
    /source page changed before dispatch/,
  );
  assert.equal(writes, 0);
});

for (const drift of ['invalid', 'binding'] as const) {
  test(`Both execution entry points recheck ${drift} against fresh effect state`, async () => {
    for (const mode of ['run', 'capture'])
      await directory(async (store) => {
        let writes = 0;
        const original = state('Ready', [
          element('save', 'button', 'Save'),
          element('name', 'textbox', 'Name'),
        ]);
        const fresh =
          drift === 'invalid'
            ? {
                ...original,
                elements: [
                  ...original.elements,
                  { ...element('required', 'textbox', 'Required'), invalid: true },
                ],
              }
            : { ...original, elements: [element('save', 'button', 'Save')] };
        const host: Host = {
          id: 'fresh-fixture',
          capabilities: ['click', 'tool'],
          observe: async (options) => (options?.fresh ? fresh : original),
          act: async () => {
            writes++;
          },
        };
        const action: Action =
          drift === 'binding'
            ? { kind: 'tool', tool: 'save', bindings: { name: { ref: 'name' } } }
            : { kind: 'click', target: { ref: 'save' } };
        const task: Task = { key: 'save', job: mode, inputs: {} };
        if (mode === 'run') {
          const result = await new Reflex({
            host,
            store,
            explore: async ({ tools }) => {
              await tools.act(action);
              return { goal: { text: 'Done' } };
            },
          }).run(task);
          assert.equal(result.status, 'failed');
        } else {
          const capture = new TaskCapture(host, store, task);
          await assert.rejects(
            capture.act(action),
            drift === 'invalid' ? /invalid|field/ : /argument target/,
          );
        }
        assert.equal(writes, 0, `${mode} must stop before dispatch`);
        assert.equal((await store.list()).length, 0);
      });
  });
}

for (const status of ['confirmed', 'rejected', 'unknown'] as const) {
  test(`Independent ${status} readback governs both entry points after a toast disappears`, async () => {
    for (const mode of ['run', 'capture'])
      await directory(async (store) => {
        let writes = 0;
        const host: Host = {
          id: 'readback-fixture',
          capabilities: ['click'],
          observe: async () => state('Ready'),
          act: async () => {
            writes++;
          },
        };
        const task: Task = {
          key: 'save',
          job: mode,
          inputs: {},
          verification: 'readback',
          readback: async (): Promise<Readback> => ({
            status,
            source: 'Independent fixture record',
          }),
        };
        const action: Action = { kind: 'click', target: { ref: 'save' } };
        if (mode === 'run') {
          const result = await new Reflex({
            host,
            store,
            explore: async ({ tools }) => {
              await tools.act(action);
              return { goal: { text: 'Temporary saved toast' } };
            },
          }).run(task);
          assert.equal(
            result.status,
            status === 'confirmed' ? 'completed' : status === 'rejected' ? 'failed' : 'uncertain',
          );
          assert.equal(result.evidence, 'readback');
        } else {
          const capture = new TaskCapture(host, store, task);
          await capture.act(action);
          if (status === 'confirmed') await capture.complete({ text: 'Temporary saved toast' });
          else
            await assert.rejects(
              capture.complete({ text: 'Temporary saved toast' }),
              /Independent readback/,
            );
        }
        assert.equal(writes, 1);
        assert.equal((await store.list()).length, status === 'confirmed' ? 1 : 0);
      });
  });
}

test('Tool capture and trace import cannot bypass final batch promotion', async () => {
  await directory(async (store) => {
    const host: Host = {
      id: 'fixture',
      capabilities: ['click'],
      observe: async () => state('Done'),
      act: async () => {},
    };
    const task: Task = {
      key: 'save',
      job: 'batch-item',
      batch: 'batch',
      verification: 'batch',
      inputs: {},
    };
    assert.throws(() => new TaskCapture(host, store, task), /BatchBridge/);
    await assert.rejects(
      learnFromTrace({
        host,
        store,
        task,
        goal: { text: 'Done' },
        trace: [
          {
            action: { kind: 'click', target: { role: 'button', name: 'Save' } },
            before: state('Ready'),
            after: state('Done'),
            dispatched: true,
            durationMs: 1,
          },
        ],
      }),
      /BatchBridge/,
    );
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.provisional('batch')).length, 0);
  });
});

test('Readback can retain an observed completion target after that target disappears', async () => {
  for (const mode of ['run', 'capture'])
    await directory(async (store) => {
      let writes = 0,
        shown = false;
      const host: Host = {
        id: 'transient-fixture',
        capabilities: ['click'],
        observe: async () => {
          if (writes && !shown) {
            shown = true;
            return state('Saved', [element('toast', 'status', 'Saved')]);
          }
          return state('Ready');
        },
        act: async () => {
          writes++;
        },
      };
      const task: Task = {
        key: 'save',
        job: mode,
        inputs: {},
        verification: 'readback',
        readback: async () => ({ status: 'confirmed', source: 'Independent fixture record' }),
      };
      const action: Action = { kind: 'click', target: { ref: 'save' } };
      if (mode === 'run') {
        const result = await new Reflex({
          host,
          store,
          explore: async ({ tools }) => {
            await tools.act(action);
            return { goal: { target: { ref: 'toast' } } };
          },
        }).run(task);
        assert.equal(result.status, 'completed', result.error);
      } else {
        const capture = new TaskCapture(host, store, task);
        await capture.act(action);
        const memory = await capture.complete({ target: { ref: 'toast' } });
        assert.deepEqual(memory.goal, { target: { role: 'status', name: 'Saved' } });
      }
      assert.equal((await store.list()).length, 1);
    });
});

test('Readback binds a submitted target from the last pre-dispatch observation', async () => {
  for (const mode of ['run', 'capture'])
    await directory(async (store) => {
      let submitted = false;
      const host: Host = {
        id: 'removed-form',
        capabilities: ['click'],
        observe: async () => state('Ready', submitted ? [] : undefined),
        act: async () => {
          submitted = true;
        },
      };
      const task: Task = {
        key: 'save',
        job: mode,
        inputs: {},
        verification: 'readback',
        readback: async () => ({ status: 'confirmed', source: 'Independent fixture record' }),
      };
      const action: Action = { kind: 'click', target: { ref: 'save' } };
      if (mode === 'run') {
        const result = await new Reflex({
          host,
          store,
          explore: async ({ tools }) => {
            await tools.act(action);
            return { goal: { target: { ref: 'save' } } };
          },
        }).run(task);
        assert.equal(result.status, 'completed', result.error);
      } else {
        const capture = new TaskCapture(host, store, task);
        await capture.act(action);
        const memory = await capture.complete({ target: { ref: 'save' } });
        assert.deepEqual(memory.goal, { target: { role: 'button', name: 'Save' } });
      }
      assert.equal((await store.list()).length, 1);
    });
});

test('A reused completion ref cannot bind two different historical identities', async () => {
  await directory(async (store) => {
    const host: Host = {
      id: 'reused-refs',
      capabilities: ['click'],
      observe: async () => state('Ready', []),
      act: async () => {},
    };
    const task: Task = {
      key: 'save',
      job: 'ambiguous',
      inputs: {},
      verification: 'readback',
      readback: async () => ({ status: 'confirmed', source: 'Independent fixture record' }),
    };
    await assert.rejects(
      learnFromTrace({
        host,
        store,
        task,
        goal: { target: { ref: 'same' } },
        trace: [
          {
            action: { kind: 'click', target: { role: 'button', name: 'Save' } },
            before: state('Ready', [element('same', 'button', 'Save')]),
            after: state('Saved', [element('same', 'status', 'Saved')]),
            dispatched: true,
            durationMs: 1,
          },
        ],
      }),
      /reference is ambiguous/,
    );
    assert.equal((await store.list()).length, 0);
  });
});

for (const mode of ['task', 'unknown', 'missing-source', 'unavailable'] as const) {
  test(`An uncertain ${mode} completion blocks further captured writes`, async () => {
    await directory(async (store) => {
      let writes = 0;
      const host: Host = {
        id: 'uncertain-completion',
        capabilities: ['click'],
        observe: async () => state('Ready'),
        act: async () => {
          writes++;
        },
      };
      const capture = new TaskCapture(host, store, {
        key: 'save',
        job: mode,
        inputs: {},
        verification: mode === 'task' ? 'task' : 'readback',
        readback: async () => {
          if (mode === 'unavailable') throw new Error('Reader offline');
          return {
            status: mode === 'unknown' ? 'unknown' : 'confirmed',
            source: mode === 'missing-source' ? '' : 'Independent fixture record',
          };
        },
      });
      const action: Action = { kind: 'click', target: { ref: 'save' } };
      await capture.act(action);
      await assert.rejects(capture.complete({ text: 'Missing completion' }));
      await assert.rejects(capture.act(action), /earlier effect|uncertain|reconciliation/);
      assert.equal(writes, 1);
      assert.equal((await store.list()).length, 0);
    });
  });
}

test('Component timings exclude nested observations and leave unmeasured waits unattributed', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timing = new RunTiming();
  now += 100; // A model wait must not be relabeled as local work.
  await timing.measure('checkMs', async () => {
    now += 2;
    await timing.measure('observationMs', async () => {
      now += 10;
    });
    now += 3;
  });
  timing.sync('compileMs', () => {
    now += 7;
  });
  await timing.measure('persistMs', async () => {
    now += 11;
  });
  assert.deepEqual(timing.snapshot(), {
    observationMs: 10,
    checkMs: 5,
    compileMs: 7,
    persistMs: 11,
  });
  assert.equal(timing.elapsed(), 133);
});

test('Journal release failure preserves verified task completion and fences subsequent writes', async () => {
  await directory(async (store) => {
    class RetainedLockJournal extends MemoryJournal {
      override async acquire() {
        await super.acquire();
        return async () => {
          throw new Error('Lock release unavailable');
        };
      }
    }
    let writes = 0,
      announceReady!: (result: MemoryResult) => void;
    const ready = new Promise<MemoryResult>((resolve) => {
      announceReady = resolve;
    });
    const host: Host = {
      id: 'cleanup-fixture',
      capabilities: ['click'],
      observe: async () => state(writes ? 'Saved' : 'Ready'),
      act: async () => {
        writes++;
      },
    };
    const reflex = new Reflex({
      host,
      store,
      journal: new RetainedLockJournal(),
      onTaskComplete: announceReady,
      explore: async ({ tools }) => {
        await tools.act({ kind: 'click', target: { ref: 'save' } });
        return { goal: { text: 'Saved' } };
      },
    });
    const pending = reflex.run({ key: 'save', job: 'first', inputs: {} });
    const initial = await ready;
    assert.equal(initial.status, 'completed');
    assert.equal(initial.learning, 'pending');
    const final = await pending;
    assert.equal(final.status, 'completed');
    assert.equal(final.evidence, 'ui-postcondition');
    assert.equal(final.learning, 'failed');
    assert.match(final.learningError!, /Journal cleanup failed: Lock release unavailable/);
    assert.ok(final.timings?.taskReadyMs !== undefined);
    assert.equal(final.timings?.memoryReadyMs, undefined);
    assert.ok(final.timings!.persistMs > 0);
    assert.equal((await store.list()).length, 1);
    await assert.rejects(reflex.run({ key: 'save', job: 'later', inputs: {} }), /active writer/);
    assert.equal(writes, 1, 'An unreleased lock must fence further business writes');
  });
});
