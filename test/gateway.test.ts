import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge, BatchBridge } from '../src/memory/gateway.js';
import { ExperienceStore } from '../src/memory/store.js';
import { Reflex } from '../src/memory/session.js';
import { observation } from '../src/memory/compiler.js';
import type { Host } from '../src/memory/types.js';

async function fixture(
  run: (
    store: ExperienceStore,
    host: Host,
    state: { writes: number; renamed: boolean; text: string },
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-bridge-'));
  const state = { writes: 0, renamed: false, text: 'Ready' };
  const host: Host = {
    id: 'bridge-test',
    capabilities: ['click'],
    observe: async () =>
      observation({
        surface: 'tool',
        scope: 'fixture',
        title: '',
        text: state.text,
        elements: [
          {
            ref: 'save',
            role: 'button',
            name: state.renamed ? 'Confirm' : 'Save',
            locator: { role: 'button', name: state.renamed ? 'Confirm' : 'Save' },
          },
        ],
      }),
    act: async () => {
      state.writes++;
      state.text = 'Saved';
    },
  };
  try {
    await run(new ExperienceStore(directory), host, state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('An already canceled agent task never enters exploration or dispatches a write', async () => {
  await fixture(async (store, host, state) => {
    const controller = new AbortController();
    controller.abort();
    const bridge = new AgentBridge(host, store, {
      key: 'save',
      job: 'canceled',
      inputs: {},
      signal: controller.signal,
    });
    try {
      const notice = await bridge.start();
      assert.equal(notice.mode, 'done');
      if (notice.mode === 'done') assert.equal(notice.result.status, 'skipped');
      assert.equal(state.writes, 0);
    } finally {
      await bridge.stop();
    }
  });
});

test('Caller cancellation releases a pending exploration and prevents further actions', async () => {
  await fixture(async (store, host, state) => {
    const controller = new AbortController();
    const bridge = new AgentBridge(host, store, {
      key: 'save',
      job: 'exploring',
      inputs: {},
      signal: controller.signal,
    });
    try {
      assert.equal((await bridge.start()).mode, 'explore');
      controller.abort();
      await assert.rejects(bridge.act({ kind: 'click', target: { ref: 'save' } }));
      assert.equal(state.writes, 0);
    } finally {
      await bridge.stop();
    }
  });
});

test('Cancellation while the host is observing cannot leave exploration waiting', async () => {
  await fixture(async (store, host, state) => {
    let enter!: () => void,
      resume!: () => void,
      reads = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const observe = host.observe;
    host.observe = async (options) => {
      if (++reads === 2) {
        enter();
        await resumed;
      }
      return observe(options);
    };
    const controller = new AbortController();
    const bridge = new AgentBridge(host, store, {
      key: 'save',
      job: 'observing',
      inputs: {},
      signal: controller.signal,
    });
    try {
      const pending = bridge.start();
      await entered;
      controller.abort();
      resume();
      assert.equal((await pending).mode, 'done');
      assert.equal(state.writes, 0);
    } finally {
      await bridge.stop();
    }
  });
});

async function seed(store: ExperienceStore, host: Host) {
  const result = await new Reflex({
    host,
    store,
    explore: async ({ tools }) => {
      await tools.act({ kind: 'click', target: { ref: 'save' } });
      return { goal: { text: 'Saved' } };
    },
  }).run({ key: 'save', job: 'seed', inputs: {} });
  assert.equal(result.status, 'completed', result.error);
}

test('Caller cancellation releases a pending repair without applying its patch', async () => {
  await fixture(async (store, host, state) => {
    await seed(store, host);
    state.writes = 0;
    state.text = 'Ready';
    state.renamed = true;
    const controller = new AbortController();
    const bridge = new AgentBridge(host, store, {
      key: 'save',
      job: 'repair',
      inputs: {},
      signal: controller.signal,
    });
    try {
      assert.equal((await bridge.start()).mode, 'repair');
      controller.abort();
      await assert.rejects(bridge.patch([{ kind: 'click', target: { ref: 'save' } }]));
      assert.equal(state.writes, 0);
    } finally {
      await bridge.stop();
    }
  });
});

test('An already canceled batch preserves the caller signal and dispatches no items', async () => {
  await fixture(async (store, host, state) => {
    await seed(store, host);
    state.writes = 0;
    state.text = 'Ready';
    const controller = new AbortController();
    controller.abort();
    const bridge = new BatchBridge(host, store, {
      id: 'canceled-batch',
      operation: 'save',
      items: [{ id: 'one', label: 'One', facts: {}, inputs: {} }],
      policy: () => ({ revision: 1, rules: [] }),
      verification: 'attempt',
      signal: controller.signal,
    });
    const notice = await bridge.start();
    assert.equal(notice.mode, 'done');
    if (notice.mode === 'done') {
      assert.equal(notice.batch?.coverage, 'canceled');
      assert.deepEqual(notice.batch?.rows, []);
    }
    assert.equal(state.writes, 0);
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const ending of ['cancel', 'complete'] as const)
  test(`${ending} waits for the full in-flight action before ending exploration`, async () => {
    await fixture(async (store, host, state) => {
      const entered = gate(),
        resume = gate();
      const act = host.act;
      host.act = async (action) => {
        entered.release();
        await resume.promise;
        await act(action);
      };
      const bridge = new AgentBridge(host, store, {
        key: 'save',
        job: 'in-flight-' + ending,
        inputs: {},
      });
      assert.equal((await bridge.start()).mode, 'explore');
      const action = bridge.act({ kind: 'click', target: { ref: 'save' } });
      try {
        await entered.promise;
        const ended = ending === 'cancel' ? bridge.stop() : bridge.complete({ text: 'Saved' });
        let settled = false;
        const completion = ended.then((result) => {
          settled = true;
          return result;
        });
        await delay(30);
        assert.equal(settled, false, 'Ending must not release a still-running UI action');
        await access(join(store.directory, 'intents.jsonl.lock'));
        assert.equal(state.writes, 0);
        assert.equal((await store.list()).length, 0);
        await assert.rejects(bridge.act({ kind: 'click', target: { ref: 'save' } }));
        resume.release();
        await action;
        await completion;
        const result = await bridge.waitForLearning();
        assert.equal(state.writes, 1);
        assert.equal(result.status, ending === 'cancel' ? 'uncertain' : 'completed');
        assert.equal(result.actions, 1);
        if (ending === 'complete') assert.equal(result.learning, 'ready');
        else assert.equal((await store.list()).length, 0);
      } finally {
        resume.release();
        await action;
        await bridge.stop();
      }
    });
  });

test('Exploration rejects a concurrent action before reserving another effect', async () => {
  await fixture(async (store, host, state) => {
    const entered = gate(),
      resume = gate();
    const act = host.act;
    host.act = async (action) => {
      entered.release();
      await resume.promise;
      await act(action);
    };
    const bridge = new AgentBridge(host, store, { key: 'save', job: 'serial', inputs: {} });
    assert.equal((await bridge.start()).mode, 'explore');
    const first = bridge.act({ kind: 'click', target: { ref: 'save' } });
    try {
      await entered.promise;
      await assert.rejects(
        bridge.act({ kind: 'click', target: { ref: 'save' } }),
        /Await the previous action/,
      );
      assert.equal(state.writes, 0);
      resume.release();
      await first;
      const done = await bridge.complete({ text: 'Saved' });
      assert.equal(done.mode, 'done');
      assert.equal(state.writes, 1);
      assert.equal((await bridge.waitForLearning()).actions, 1);
    } finally {
      resume.release();
      await first;
      await bridge.stop();
    }
  });
});

test('A canceled batch remains pending until its final queue state is persisted', async () => {
  await fixture(async (store, host, state) => {
    const entered = gate(),
      resume = gate();
    const saveBatch = store.saveBatch.bind(store);
    store.saveBatch = async (id, value) => {
      entered.release();
      await resume.promise;
      await saveBatch(id, value);
    };
    const controller = new AbortController();
    controller.abort();
    const bridge = new BatchBridge(host, store, {
      id: 'cancel-before-shutdown',
      operation: 'save',
      items: [],
      policy: () => ({ revision: 1, rules: [] }),
      verification: 'attempt',
      signal: controller.signal,
    });
    const started = bridge.start();
    try {
      await entered.promise;
      bridge.cancel();
      let settled = false;
      const completion = bridge.waitForCompletion().then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      assert.equal(settled, false, 'Shutdown must wait for the pending queue write');
      resume.release();
      assert.equal((await completion)?.coverage, 'canceled');
      assert.equal((await started).mode, 'done');
      assert.equal(state.writes, 0);
    } finally {
      resume.release();
      await bridge.waitForCompletion();
    }
  });
});

test(
  'Task completion precedes local persistence, and cancel after success does not discard learning',
  { timeout: 5_000 },
  async () => {
    await fixture(async (store, host, state) => {
      const entered = gate(),
        resume = gate();
      const save = store.save.bind(store);
      store.save = async (memory) => {
        entered.release();
        await resume.promise;
        await save(memory);
      };
      let reads = 0;
      const observe = host.observe;
      host.observe = async (options) => {
        reads++;
        return observe(options);
      };
      const bridge = new AgentBridge(host, store, { key: 'save', job: 'deferred', inputs: {} });
      try {
        assert.equal((await bridge.start()).mode, 'explore');
        await bridge.act({ kind: 'click', target: { ref: 'save' } });
        const ready = await bridge.complete({ text: 'Saved' });
        assert.equal(ready.mode, 'done');
        if (ready.mode !== 'done') throw new Error('Expected successful task completion');
        assert.equal(ready.result.status, 'completed');
        assert.equal(ready.result.learning, 'pending');
        assert.equal(ready.result.timings?.memoryReadyMs, undefined);
        assert.ok(ready.result.timings?.taskReadyMs !== undefined);
        await entered.promise;
        let settled = false;
        const final = bridge.waitForLearning().then((result) => {
          settled = true;
          return result;
        });
        await Promise.resolve();
        assert.equal(
          settled,
          false,
          'Learning must not claim readiness while the write is blocked',
        );
        const readsAtReady = reads;
        bridge.cancel();
        resume.release();
        const result = await final;
        assert.equal(result.status, 'completed');
        assert.equal(result.learning, 'ready');
        assert.ok(result.timings!.memoryReadyMs! >= result.timings!.taskReadyMs!);
        assert.ok(result.timings!.persistMs > 0);
        assert.equal(reads, readsAtReady, 'Only local memory work is allowed after taskReady');
        assert.equal(state.writes, 1);
        assert.equal((await store.list()).length, 1);
        assert.equal(
          ready.result.learning,
          'pending',
          'The earlier response is an immutable status snapshot',
        );
      } finally {
        resume.release();
        await bridge.stop();
      }
    });
  },
);

for (const stage of ['save', 'episode'] as const)
  test(`A ${stage} failure reports learning failure without changing completed business work`, async () => {
    await fixture(async (store, host, state) => {
      if (stage === 'save')
        store.save = async () => {
          throw new Error('Memory disk unavailable');
        };
      else
        store.saveEpisode = async () => {
          throw new Error('Episode disk unavailable');
        };
      const bridge = new AgentBridge(host, store, { key: 'save', job: stage, inputs: {} });
      try {
        assert.equal((await bridge.start()).mode, 'explore');
        await bridge.act({ kind: 'click', target: { ref: 'save' } });
        const notice = await bridge.complete({ text: 'Saved' });
        assert.equal(notice.mode, 'done');
        if (notice.mode === 'done') assert.equal(notice.result.learning, 'pending');
        const final = await bridge.waitForLearning();
        assert.equal(final.status, 'completed');
        assert.equal(final.learning, 'failed');
        assert.match(final.learningError!, /disk unavailable/);
        assert.equal(final.timings?.memoryReadyMs, undefined);
        assert.equal(state.writes, 1);
      } finally {
        await bridge.stop();
      }
    });
  });

test('Rejected completion never publishes an early success or promotes an experience', async () => {
  await fixture(async (store, host, state) => {
    const bridge = new AgentBridge(host, store, {
      key: 'save',
      job: 'rejected',
      inputs: {},
      verification: 'readback',
      readback: async () => ({ status: 'rejected', source: 'Independent fixture record' }),
    });
    try {
      assert.equal((await bridge.start()).mode, 'explore');
      await bridge.act({ kind: 'click', target: { ref: 'save' } });
      const notice = await bridge.complete({ text: 'Saved' });
      assert.equal(notice.mode, 'done');
      if (notice.mode === 'done') {
        assert.equal(notice.result.status, 'failed');
        assert.equal(notice.result.learning, undefined);
        assert.equal(notice.result.timings?.taskReadyMs, undefined);
      }
      assert.equal(state.writes, 1);
      assert.equal((await store.list()).length, 0);
    } finally {
      await bridge.stop();
    }
  });
});
