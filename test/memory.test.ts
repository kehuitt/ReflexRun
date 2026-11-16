import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { unmappedApp } from './fixtures/unmapped.js';
import { Reflex } from '../src/memory/session.js';
import { BrowserHost } from '../src/memory/browser.js';
import { ExperienceStore } from '../src/memory/store.js';
import { observation, compileExperience, decode, successfulPath } from '../src/memory/compiler.js';
import { CallbackHost } from '../src/memory/callback.js';
import { CuaAppHost } from '../src/memory/cua.js';
import { runMemoryBatch, settleMemoryBatch } from '../src/memory/batch.js';
import { TaskCapture, learnFromTrace } from '../src/memory/capture.js';
import type { AgentTools, Inputs } from '../src/memory/types.js';

let browser: Browser, app: Awaited<ReturnType<typeof unmappedApp>>;
let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'reflex-memory-'));
  app = await unmappedApp();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
});

async function fillObserved(tools: AgentTools, inputs: Inputs, probe = false) {
  let view = await tools.observe();
  if (probe) {
    await assert.rejects(tools.act({ kind: 'click', target: { ref: 'not-a-live-target' } }));
    const help = view.elements.find((e) => e.name === 'Help')!;
    await tools.act({ kind: 'click', target: { ref: help.ref } });
    await tools.act({ kind: 'navigate', url: app.origin + '/intake' });
  }
  const fields: [string, string][] = [
    ['Full name', 'name'],
    ['Contact email', 'email'],
    ['Access code', 'access'],
  ];
  for (const [label, key] of fields) {
    view = await tools.observe();
    const e = view.elements.find((e) => e.name === label)!;
    await tools.act({ kind: 'fill', target: { ref: e.ref }, value: inputs[key] });
  }
  view = await tools.observe();
  await tools.act({
    kind: 'select',
    target: { ref: view.elements.find((e) => e.role === 'combobox')!.ref },
    value: inputs.topic,
  });
  view = await tools.observe();
  await tools.act({
    kind: 'check',
    target: { ref: view.elements.find((e) => e.role === 'checkbox')!.ref },
    value: inputs.extra,
  });
  view = await tools.observe();
  const extra = view.elements.find((e) => e.name === 'Instructions');
  if (extra)
    await tools.act({ kind: 'fill', target: { ref: extra.ref }, value: inputs.instructions });
  view = await tools.observe();
  const submit = view.elements.find((e) => e.role === 'button')!;
  await tools.act({ kind: 'click', target: { ref: submit.ref } });
  return { goal: { text: 'Request received' } };
}
const inputs = (name: string, extra = false): Inputs => ({
  name,
  email: name.toLowerCase().replace(/\s/g, '') + '@example.test',
  access: 'fictional-access-' + name,
  topic: 'sport',
  extra,
  instructions: 'Synthetic instructions for ' + name,
});

test(
  'Agent exploration learns an unmapped cross-page form; disk restart replays new values without invoking the agent',
  { timeout: 20_000 },
  async () => {
    const directory = join(root, 'restart');
    const store = new ExperienceStore(directory);
    const page = await browser.newPage();
    const initial = inputs('First fixture');
    try {
      await page.goto(app.origin + '/intake');
      let turns = 0;
      const cold = await new Reflex({
        host: new BrowserHost(page),
        store,
        explore: async ({ tools, task }) => {
          turns++;
          return fillObserved(tools, task.inputs, true);
        },
      }).run({ key: 'workshop-request', inputs: initial, job: 'first' });
      assert.equal(cold.status, 'completed', cold.error);
      assert.equal(turns, 1);
      const memory = (await store.list())[0];
      assert.ok(memory.eliminatedActions >= 3);
      assert.ok(memory.requiredInputs.includes('name'));
      const disk = JSON.stringify(await store.episodes()) + JSON.stringify(await store.list());
      assert.ok(!disk.includes(String(initial.access)));
      assert.ok(!disk.includes(String(initial.email)));
      const second = inputs('Second fixture');
      const warm = await new Reflex({
        host: new BrowserHost(page),
        store: new ExperienceStore(directory),
        explore: async () => {
          throw new Error('A warm run must not invoke the agent');
        },
      }).run({ key: 'workshop-request', inputs: second, job: 'second' });
      assert.equal(warm.status, 'completed', warm.error);
      assert.equal(warm.hostDelegations, 0);
      assert.equal(app.saves.at(-1)!.name, second.name);
      assert.equal(app.saves.at(-1)!.access, second.access);
    } finally {
      await page.close();
    }
  },
);
test(
  'A changed submit label is repaired once, then persisted as a new reusable version',
  { timeout: 20_000 },
  async () => {
    const store = new ExperienceStore(join(root, 'repair'));
    const page = await browser.newPage();
    try {
      app.state.renamed = false;
      await page.goto(app.origin + '/intake');
      const reflex = new Reflex({
        host: new BrowserHost(page),
        store,
        explore: async ({ tools, task }) => fillObserved(tools, task.inputs),
        repair: async ({ observation: state }) => [
          {
            kind: 'click',
            target: { ref: state.elements.find((e) => e.name === 'Send request')!.ref },
          },
        ],
      });
      assert.equal(
        (await reflex.run({ key: 'repair-form', inputs: inputs('Before rename'), job: 'r1' }))
          .status,
        'completed',
      );
      app.state.renamed = true;
      const repaired = await reflex.run({
        key: 'repair-form',
        inputs: inputs('After rename'),
        job: 'r2',
      });
      assert.equal(repaired.status, 'completed', repaired.error);
      assert.equal(repaired.repairs, 1);
      assert.equal((await store.list()).length, 2);
      assert.ok((await store.list())[0].parent);
      const warm = await new Reflex({ host: new BrowserHost(page), store }).run({
        key: 'repair-form',
        inputs: inputs('After repair'),
        job: 'r3',
      });
      assert.equal(warm.status, 'completed', warm.error);
      assert.equal(warm.hostDelegations, 0);
    } finally {
      app.state.renamed = false;
      await page.close();
    }
  },
);
test(
  'A newly revealed required field triggers local preflight repair before a write',
  { timeout: 20_000 },
  async () => {
    const store = new ExperienceStore(join(root, 'conditional'));
    const page = await browser.newPage();
    try {
      await page.goto(app.origin + '/intake');
      const reflex = new Reflex({
        host: new BrowserHost(page),
        store,
        explore: async ({ tools, task }) => fillObserved(tools, task.inputs),
        repair: async ({ task, observation: state }) => [
          {
            kind: 'fill',
            target: { ref: state.elements.find((e) => e.name === 'Instructions')!.ref },
            value: task.inputs.instructions,
          },
          { kind: 'click', target: { ref: state.elements.find((e) => e.role === 'button')!.ref } },
        ],
      });
      assert.equal(
        (await reflex.run({ key: 'conditional', inputs: inputs('Simple fixture'), job: 'c1' }))
          .status,
        'completed',
      );
      const result = await reflex.run({
        key: 'conditional',
        inputs: inputs('Extra fixture', true),
        job: 'c2',
      });
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.repairs, 1);
      assert.equal(app.saves.at(-1)!.instructions, 'Synthetic instructions for Extra fixture');
      const next = await new Reflex({ host: new BrowserHost(page), store }).run({
        key: 'conditional',
        inputs: inputs('Extra again', true),
        job: 'c3',
      });
      assert.equal(next.status, 'completed', next.error);
    } finally {
      await page.close();
    }
  },
);
test('Uploads, keyboard input and same-origin frame inputs are supported without a contract', async () => {
  const page = await browser.newPage();
  const attachment = join(root, 'fixture.txt');
  await writeFile(attachment, 'Synthetic fixture');
  try {
    await page.goto(app.origin + '/intake');
    const host = new BrowserHost(page);
    let state = await host.observe();
    assert.ok(state.elements.some((e) => e.name === 'Frame note'));
    const frame = state.elements.find((e) => e.name === 'Frame note')!;
    await host.act({ kind: 'fill', target: frame.locator, value: 'Frame fixture' });
    const file = state.elements.find((e) => e.type === 'file')!;
    await host.act({ kind: 'upload', target: file.locator, value: attachment });
    const name = state.elements.find((e) => e.name === 'Full name')!;
    await host.act({ kind: 'type', target: name.locator, value: 'Keyboard fixture' });
    await host.act({ kind: 'press', target: name.locator, value: 'End' });
    state = await host.observe();
    assert.equal(state.elements.find((e) => e.name === 'Full name')!.value, 'Keyboard fixture');
    assert.equal(state.elements.find((e) => e.name === 'Frame note')!.value, 'Frame fixture');
  } finally {
    await page.close();
  }
});
test('An ambiguous effect is quarantined and is never retried by repair', async () => {
  const store = new ExperienceStore(join(root, 'uncertain'));
  let clicks = 0;
  const state = observation({
    surface: 'tool',
    scope: 'fixture',
    title: '',
    text: 'Submit',
    elements: [
      { ref: '1', role: 'button', name: 'Submit', locator: { role: 'button', name: 'Submit' } },
    ],
  });
  const host = new CallbackHost('opaque', ['click'], {
    observe: async () => state,
    act: async () => {
      clicks++;
      throw new Error('Response lost');
    },
  });
  const reflex = new Reflex({
    host,
    store,
    explore: async ({ tools }) => {
      await tools.act({ kind: 'click', target: { ref: '1' } });
      return { goal: { text: 'Submitted' } };
    },
    repair: async () => {
      throw new Error('Must not repair an ambiguous write');
    },
  });
  assert.equal(
    (await reflex.run({ key: 'uncertain', inputs: {}, job: 'same' })).status,
    'uncertain',
  );
  assert.equal(
    (await reflex.run({ key: 'uncertain', inputs: {}, job: 'same' })).status,
    'uncertain',
  );
  assert.equal(clicks, 1);
  assert.equal((await store.list()).length, 0);
});
test('Native accessibility references are rebound after indices change', async () => {
  let text =
    '0 window\n  1 text field (settable, string) Description: Name, Value: \n  2 button Description: Save\n';
  let filled = '';
  const host = new CuaAppHost(
    {
      getAXState: async () => text,
      click: async () => {},
      setValue: async (index, value) => {
        assert.equal(index, 91);
        filled = value;
      },
      typeText: async () => {},
      pressKey: async () => {},
      scroll: async () => {},
    },
    'native:fixture',
  );
  const target = (await host.observe()).elements.find((e) => e.name === 'Name')!.locator;
  text =
    '0 window\n  91 text field (settable, string) Description: Name, Value: \n  92 button Description: Save\n';
  await host.act({ kind: 'fill', target, value: 'Native fixture' });
  assert.equal(filled, 'Native fixture');
});
test('Native capture replays a new record through localized accessibility controls', async () => {
  const store = new ExperienceStore(join(root, 'native-localized'));
  let selected = '';
  let status = '';
  const archived: string[] = [];
  const host = new CuaAppHost(
    {
      getAXState: async () =>
        selected
          ? `0 window\n  4 \u6807\u9898 ${selected}\n  5 \u6309\u94ae \u63d0\u4ea4`
          : `0 window\n  1 \u6309\u94ae MAIL-5101\n  2 \u6309\u94ae MAIL-5102\n  3 \u6587\u672c ${status}`,
      click: async (index) => {
        if (index === 5) {
          archived.push(selected);
          status = `${selected} · Moved to archive`;
          selected = '';
        } else selected = index === 1 ? 'MAIL-5101' : 'MAIL-5102';
      },
      setValue: async () => {},
      typeText: async () => {},
      pressKey: async () => {},
      scroll: async () => {},
    },
    'native:localized-inbox',
  );
  const capture = new TaskCapture(host, store, {
    key: 'archive-message',
    job: 'learn-first',
    inputs: { message: 'MAIL-5101' },
  });
  await capture.act({ kind: 'click', target: { ref: '1' } });
  await capture.act({ kind: 'click', target: { ref: '5' } });
  const learned = await capture.complete({ text: 'MAIL-5101 · Moved to archive' });
  assert.equal(learned.steps[1].effect, true);
  const result = await new Reflex({ host, store }).run({
    key: learned.key,
    job: 'replay-second',
    experience: learned.id,
    inputs: { message: 'MAIL-5102' },
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.source, 'memory');
  assert.equal(result.hostDelegations, 0);
  assert.deepEqual(archived, ['MAIL-5101', 'MAIL-5102']);
});
test(
  'A whole batch persists progress, changes preferences before writes, continues failures and audits once',
  { timeout: 30_000 },
  async () => {
    const store = new ExperienceStore(join(root, 'batch'));
    const page = await browser.newPage();
    try {
      await page.goto(app.origin + '/intake');
      const reflex = new Reflex({
        host: new BrowserHost(page),
        store,
        explore: async ({ tools, task }) => fillObserved(tools, task.inputs),
      });
      await reflex.run({ key: 'batch-form', inputs: inputs('Seed fixture'), job: 'seed' });
      let p = { revision: 1, rules: [] } as import('../src/types.js').Policy;
      const items = ['First batch', 'Reject fixture', 'Third batch', 'Skip batch'].map(
        (name, i) => ({
          id: String(i),
          label: name,
          inputs: inputs(name),
          facts: { distance: i + 1 },
        }),
      );
      let audits = 0;
      const result = await runMemoryBatch(reflex, {
        id: 'batch-test',
        operation: 'batch-form',
        policy: () => p,
        items,
        factPlan: {
          identity: { target: { label: 'Full name' }, from: 'value', expected: { $input: 'name' } },
          fields: { name: { target: { label: 'Full name' }, from: 'value' } },
        },
        onItem: (row) => {
          if (row.id === '1')
            p = { revision: 2, rules: [{ field: 'name', op: 'not-in', value: ['Skip batch'] }] };
        },
        audit: async (ids) => {
          audits++;
          return new Map(
            ids.map((id) => [id, id === '1' ? ('rejected' as const) : ('confirmed' as const)]),
          );
        },
      });
      assert.equal(audits, 1);
      assert.equal(result.rows.find((r) => r.id === '1')!.status, 'rejected');
      assert.equal(result.rows.find((r) => r.id === '3')!.status, 'skipped');
      assert.equal(result.rows.find((r) => r.id === '2')!.status, 'confirmed');
      const before = app.saves.length;
      await runMemoryBatch(reflex, {
        id: 'batch-test',
        operation: 'batch-form',
        policy: () => p,
        items,
      });
      assert.equal(app.saves.length, before);
    } finally {
      await page.close();
    }
  },
);

test('Tool-call capture retains failed exploration and replays parameters across separately awaited calls', async () => {
  const page = await browser.newPage(),
    store = new ExperienceStore(join(root, 'capture'));
  try {
    await page.goto(app.origin + '/intake');
    const capture = new TaskCapture(new BrowserHost(page), store, {
      key: 'captured-form',
      job: 'capture-first',
      inputs: inputs('Captured first'),
    });
    const { goal } = await fillObserved(capture, capture.task.inputs, true);
    const learned = await capture.complete(goal);
    assert.ok(learned.eliminatedActions >= 3);
    assert.equal((await store.episodes()).length, 1);
    assert.equal(learned.parameters?.topic.kind, 'select');
    const warm = await new Reflex({ host: new BrowserHost(page), store }).run({
      key: 'captured-form',
      job: 'capture-second',
      inputs: inputs('Captured second'),
    });
    assert.equal(warm.status, 'completed', warm.error);
    assert.equal(warm.hostDelegations, 0);
    assert.equal(app.saves.at(-1)!.name, 'Captured second');
    await assert.rejects(capture.act({ kind: 'navigate', url: app.origin + '/intake' }), /closed/);
  } finally {
    await page.close();
  }
});

test('Capture fences invalid forms, cancellation, scope and uncertain effects without promoting a path', async () => {
  const page = await browser.newPage(),
    store = new ExperienceStore(join(root, 'capture-fences'));
  try {
    await page.goto(app.origin + '/intake');
    const host = new BrowserHost(page);
    const capture = new TaskCapture(host, store, { key: 'invalid', job: 'invalid', inputs: {} });
    const submit = (await capture.observe()).elements.find((e) => e.name === 'Submit request')!;
    const saves = app.saves.length;
    await assert.rejects(capture.act({ kind: 'click', target: submit.locator }), /required/);
    await assert.rejects(capture.act({ kind: 'navigate', url: 'https://example.test' }), /scope/);
    assert.equal(app.saves.length, saves);
    await capture.abort();
    assert.equal((await store.episodes())[0].success, false);
    assert.equal((await store.list()).length, 0);
    const controller = new AbortController();
    controller.abort();
    const canceled = new TaskCapture(host, store, {
      key: 'canceled',
      job: 'canceled',
      inputs: {},
      signal: controller.signal,
    });
    await assert.rejects(canceled.act({ kind: 'click', target: submit.locator }), /canceled/);
    await canceled.abort();
    const uncertain = new TaskCapture(
      new CallbackHost('lost', ['click'], {
        observe: async () =>
          observation({
            surface: 'tool',
            scope: 'lost',
            title: '',
            text: 'Saved',
            elements: [
              { ref: '1', role: 'button', name: 'Save', locator: { role: 'button', name: 'Save' } },
            ],
          }),
        act: async () => {
          throw new Error('Acknowledgement lost');
        },
      }),
      store,
      { key: 'lost', job: 'lost', inputs: {} },
    );
    await assert.rejects(uncertain.act({ kind: 'click', target: { ref: '1' } }), /lost/);
    await assert.rejects(uncertain.complete({ text: 'Saved' }), /uncertain/);
    await uncertain.abort();
    assert.equal((await store.list()).length, 0);
    await assert.rejects(
      learnFromTrace({
        host,
        store,
        task: { key: 'import', job: 'import', inputs: {}, allowedScopes: ['other-origin'] },
        trace: [],
        goal: { text: 'Community' },
      }),
      /scope/,
    );
  } finally {
    await page.close();
  }
});

test('Constraints and encoded URLs bind inputs; changed unbound constraints cause a memory miss', async () => {
  const store = new ExperienceStore(join(root, 'constraints'));
  const state = observation({
    surface: 'tool',
    scope: 'fixture',
    title: '',
    text: 'Ready',
    elements: [],
  });
  const params = { name: 'Synthetic sample', age: 24 };
  const memory = compileExperience({
    key: 'constraints',
    scope: 'fixture',
    inputs: params,
    goal: { text: 'Done' },
    episode: 'fixture',
    entryUrl: 'https://example.test/?name=Synthetic+sample',
    constraints: { age: 24, excluded: ['children'] },
    trace: [
      {
        action: { kind: 'wait', effect: false },
        before: state,
        after: { ...state, text: 'Done', stateKey: 'done' },
        dispatched: true,
        durationMs: 1,
      },
    ],
  });
  await store.save(memory);
  assert.deepEqual(new Set(memory.requiredInputs), new Set(['name', 'age']));
  assert.equal(
    decode(memory.entryUrl!, { name: 'Another sample', age: 25 }),
    'https://example.test/?name=Another+sample',
  );
  assert.equal(
    (
      await store.recall(
        'constraints',
        'fixture',
        { name: 'Another sample', age: 25 },
        { age: 25, excluded: ['children'] },
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await store.recall(
        'constraints',
        'fixture',
        { name: 'Another sample' },
        { age: 25, excluded: ['children'] },
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await store.recall('constraints', 'fixture', params, {
        age: 24,
        excluded: ['children', 'craft'],
      })
    ).length,
    0,
  );
});

test('Hover and drag change the real browser UI through ordinary host primitives', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<style>#tip{display:none}#hover:hover+#tip{display:block}[draggable],#drop{width:180px;height:90px;margin:40px;padding:20px;background:#ddd}</style><button id="hover">Reveal</button><p id="tip">Hover revealed</p><div role="button" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\'fixture\')">Drag source</div><div role="button" id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent=\'Dropped\'">Drop target</div>',
    );
    const host = new BrowserHost(page);
    await host.act({ kind: 'hover', target: { role: 'button', name: 'Reveal' } });
    assert.match((await host.observe()).text, /Hover revealed/);
    await host.act({
      kind: 'drag',
      target: { role: 'button', name: 'Drag source' },
      to: { role: 'button', name: 'Drop target' },
    });
    assert.match((await host.observe()).text, /Dropped/);
  } finally {
    await page.close();
  }
});

test('The final host audit settles only pending IDs and cannot silently revise a completed outcome', async () => {
  const store = new ExperienceStore(join(root, 'settlement'));
  const { createHash } = await import('node:crypto');
  await store.saveBatch(createHash('sha256').update('settle').digest('hex'), {
    id: 'settle',
    operation: 'fixture',
    revision: 1,
    rows: [
      { id: 'a', status: 'attempted', revision: 1 },
      { id: 'b', status: 'unknown', revision: 1 },
    ],
    coverage: 'observed-end',
    audits: 0,
  });
  const result = await settleMemoryBatch(
    store,
    'settle',
    new Map([['a', 'confirmed']]),
    'Rendered history table',
  );
  assert.equal(result.audits, 1);
  assert.equal(result.rows[0].status, 'confirmed');
  assert.equal(result.rows[1].status, 'unknown');
  await assert.rejects(
    settleMemoryBatch(store, 'settle', new Map([['a', 'rejected']]), 'Different guess'),
    /not pending/,
  );
});

test('Equal first-run values keep separate parameter identities; ambiguous inference is rejected', async () => {
  const page = await browser.newPage(),
    store = new ExperienceStore(join(root, 'equal-inputs'));
  try {
    await page.goto(app.origin + '/intake');
    const reflex = new Reflex({
      host: new BrowserHost(page),
      store,
      explore: async ({ tools }) => {
        await tools.act({ kind: 'fill', target: { label: 'Full name' }, input: 'name' });
        await tools.act({ kind: 'fill', target: { label: 'Contact email' }, input: 'email' });
        await tools.act({ kind: 'fill', target: { label: 'Access code' }, input: 'access' });
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Submit request' } });
        return { goal: { text: 'Request received' } };
      },
    });
    const first = await reflex.run({
      key: 'equal',
      job: 'equal-first',
      inputs: {
        name: 'Same fixture value',
        access: 'Same fixture value',
        email: 'same@example.test',
      },
    });
    assert.equal(first.status, 'completed', first.error);
    const warm = await reflex.run({
      key: 'equal',
      job: 'equal-second',
      inputs: { name: 'Changed name', access: 'Changed access', email: 'changed@example.test' },
    });
    assert.equal(warm.status, 'completed', warm.error);
    assert.equal(warm.hostDelegations, 0);
    assert.equal(app.saves.at(-1)!.name, 'Changed name');
    assert.equal(app.saves.at(-1)!.access, 'Changed access');
    const disk = JSON.stringify(await store.episodes()) + JSON.stringify(await store.list());
    assert.ok(!disk.includes('Same fixture value'));
    const before = observation({
      surface: 'tool',
      scope: 'fixture',
      title: '',
      text: '',
      elements: [],
    });
    assert.throws(
      () =>
        compileExperience({
          key: 'ambiguous',
          scope: 'fixture',
          inputs: { a: 'same', b: 'same' },
          goal: { text: 'Done' },
          episode: 'fixture',
          trace: [
            { action: { kind: 'fill', value: 'same' }, before, dispatched: true, durationMs: 1 },
          ],
        }),
      /Ambiguous input binding/,
    );
  } finally {
    await page.close();
  }
});

test('Capture and replay use the same intent identity across authorized scopes', async () => {
  let scope = 'scope-a',
    writes = 0;
  const host = new CallbackHost('multi-scope', ['navigate', 'click'], {
    observe: async () =>
      observation({
        surface: 'tool',
        scope,
        title: '',
        text: 'Save',
        elements: [
          { ref: '1', role: 'button', name: 'Save', locator: { role: 'button', name: 'Save' } },
        ],
      }),
    act: async (action) => {
      if (action.kind === 'navigate') scope = 'scope-b';
      else {
        writes++;
        throw new Error('Response lost');
      }
    },
  });
  const store = new ExperienceStore(join(root, 'capture-scopes'));
  const task = {
    key: 'cross-scope',
    job: 'stable',
    inputs: {},
    allowedScopes: ['scope-a', 'scope-b'],
  };
  const capture = new TaskCapture(host, store, task);
  await capture.act({ kind: 'navigate', value: 'scope-b' });
  await assert.rejects(capture.act({ kind: 'click', target: { ref: '1' } }), /lost/);
  await capture.abort();
  scope = 'scope-a';
  const replay = await new Reflex({
    host,
    store,
    explore: async ({ tools }) => {
      await tools.act({ kind: 'navigate', value: 'scope-b' });
      await tools.act({ kind: 'click', target: { ref: '1' } });
      return { goal: { text: 'Saved' } };
    },
  }).run(task);
  assert.equal(replay.status, 'uncertain');
  assert.equal(writes, 1);
});

test('A text-invariant click is retained: selection and focus can matter even without visible text changes', async () => {
  const state = observation({
    surface: 'tool',
    scope: 'fixture',
    title: '',
    text: 'Choose',
    elements: [],
  });
  assert.equal(
    successfulPath([
      {
        action: { kind: 'click', target: { role: 'button', name: 'Triage' }, effect: false },
        before: state,
        after: state,
        dispatched: true,
        durationMs: 1,
      },
    ]).length,
    1,
  );
  const page = await browser.newPage(),
    store = new ExperienceStore(join(root, 'selection'));
  const html =
    "<button id=\"triage\" onclick=\"this.classList.add('selected')\">Triage</button><button onclick=\"document.querySelector('p').textContent=document.querySelector('#triage').classList.contains('selected')?'Result Triage':'Result None'\">Save</button><p></p>";
  try {
    await page.setContent(html);
    const reflex = new Reflex({
      host: new BrowserHost(page),
      store,
      explore: async ({ tools }) => {
        const before = await tools.observe();
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Triage' } });
        const after = await tools.observe();
        assert.notEqual(before.stateKey, after.stateKey);
        await tools.act({ kind: 'click', target: { role: 'button', name: 'Save' } });
        return { goal: { text: 'Result Triage' } };
      },
    });
    assert.equal(
      (await reflex.run({ key: 'select-triage', job: 'first', inputs: {} })).status,
      'completed',
    );
    await page.setContent(html);
    const result = await reflex.run({ key: 'select-triage', job: 'second', inputs: {} });
    assert.equal(result.status, 'completed', result.error);
    assert.equal((await store.list())[0].steps.length, 2);
  } finally {
    await page.close();
  }
});

test('Compatible guarded segments compose locally, then the resulting experience replays without a planner', async () => {
  const page = await browser.newPage(),
    store = new ExperienceStore(join(root, 'compose'));
  try {
    await page.goto(app.origin + '/intake');
    const seed = new Reflex({
      host: new BrowserHost(page),
      store,
      explore: async ({ tools, task }) => fillObserved(tools, task.inputs),
    });
    assert.equal(
      (await seed.run({ key: 'full-form', job: 'seed', inputs: inputs('Composition seed') }))
        .status,
      'completed',
    );
    const memory = (await store.list())[0],
      submit = memory.steps.findIndex((s) => s.effect);
    const filled = { target: { label: 'Full name' }, equals: { $input: 'name' } };
    const composed = await new Reflex({ host: new BrowserHost(page), store }).run({
      key: 'composed-form',
      job: 'compose-first',
      inputs: inputs('Composed first'),
      compose: {
        goal: { text: 'Request received' },
        parts: [
          {
            experience: memory.id,
            segment: 'fill',
            start: 0,
            end: submit,
            requires: { target: { label: 'Full name' } },
            ensures: filled,
          },
          {
            experience: memory.id,
            segment: 'submit',
            start: submit,
            end: memory.steps.length,
            requires: filled,
            ensures: { text: 'Request received' },
          },
        ],
      },
    });
    assert.equal(composed.status, 'completed', composed.error);
    assert.equal(composed.source, 'composition');
    assert.equal(composed.hostDelegations, 0);
    assert.equal((await store.list()).find((m) => m.id === composed.experience)!.parts!.length, 2);
    const warm = await new Reflex({ host: new BrowserHost(page), store }).run({
      key: 'composed-form',
      job: 'compose-second',
      inputs: inputs('Composed second'),
    });
    assert.equal(warm.status, 'completed', warm.error);
    assert.equal(warm.hostDelegations, 0);
    assert.equal(app.saves.at(-1)!.name, 'Composed second');
    const incompatible = await new Reflex({ host: new BrowserHost(page), store }).run({
      key: 'incompatible-composition',
      job: 'wrong-constraints',
      inputs: inputs('Must not submit'),
      constraints: { purpose: 'different' },
      compose: {
        goal: { text: 'Request received' },
        parts: [
          {
            experience: memory.id,
            segment: 'incompatible',
            start: 0,
            end: memory.steps.length,
            requires: { text: 'Request received' },
            ensures: { text: 'Request received' },
          },
        ],
      },
    });
    assert.equal(incompatible.status, 'failed');
    assert.equal(incompatible.actions, 0, 'Check all segment constraints before dispatch');
    await store.quarantine(memory.id, 'Invalidated segment');
    const writes = app.saves.length;
    const refused = await new Reflex({ host: new BrowserHost(page), store }).run({
      key: 'another-composition',
      job: 'refuse-compose',
      inputs: inputs('Must not submit'),
      compose: {
        goal: { text: 'Request received' },
        parts: [
          {
            experience: memory.id,
            segment: 'old',
            start: 0,
            end: memory.steps.length,
            requires: { text: 'Request received' },
            ensures: { text: 'Request received' },
          },
        ],
      },
    });
    assert.equal(refused.status, 'failed');
    assert.equal(app.saves.length, writes);
  } finally {
    await page.close();
  }
});
