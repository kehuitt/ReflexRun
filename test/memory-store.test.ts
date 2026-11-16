import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore } from '../src/memory/store.js';
import { compileExperience, decode, observation } from '../src/memory/compiler.js';
import { Reflex } from '../src/memory/session.js';
import { PlaywrightMcpHost } from '../src/proxy/playwright.js';
import type { Action, Check, Host, MemoryResult, Task } from '../src/memory/types.js';

const state = observation({
  surface: 'tool',
  scope: 'fixture',
  title: '',
  text: 'Form A',
  elements: [],
});
const memory = (key: string, applicability?: Check) =>
  compileExperience({
    key,
    scope: 'fixture',
    inputs: {},
    goal: { text: 'Done' },
    episode: 'fixture',
    applicability,
    trace: [{ action: { kind: 'wait' }, before: state, dispatched: true, durationMs: 1 }],
  });
const success: MemoryResult = {
  status: 'completed',
  evidence: 'ui-postcondition',
  source: 'memory',
  actions: 1,
  hostDelegations: 0,
  repairs: 0,
  elapsedMs: 1,
};

test('Verified workflows share immutable step atoms across operations and preserve their own guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-atoms-'));
  try {
    const left = memory('A', { text: 'Form A' });
    const right = memory('B', { text: 'Form B' });
    left.steps[0] = {
      sourceIndex: 1,
      action: { kind: 'click', target: { role: 'button', name: 'Save' } },
      intent: { kind: 'click', target: { role: 'button', name: 'Save' } },
      effect: true,
    };
    right.steps[0] = {
      ...left.steps[0],
      sourceIndex: 4,
      action: { target: { name: 'Save', role: 'button' }, kind: 'click' },
    };
    right.steps.push({
      sourceIndex: 5,
      action: { kind: 'click', target: { role: 'button', name: 'Back' } },
      effect: false,
    });
    const leftStore = new ExperienceStore(directory),
      rightStore = new ExperienceStore(directory);
    await Promise.all([leftStore.save(left), rightStore.save(right)]);

    const record = async (id: string) =>
      JSON.parse(await readFile(join(directory, 'experiences', id + '.json'), 'utf8'));
    const a = await record(left.id),
      b = await record(right.id);
    assert.deepEqual(a.steps, [{ atom: b.steps[0].atom, sourceIndex: 1 }]);
    assert.deepEqual(b.steps[0], { atom: a.steps[0].atom, sourceIndex: 4 });
    assert.notEqual(b.steps[1].atom, a.steps[0].atom);
    assert.equal((await readdir(join(directory, 'atoms'))).length, 2);
    const restarted = new ExperienceStore(directory);
    for (const experience of [left, right])
      assert.deepEqual(await restarted.get(experience.id), JSON.parse(JSON.stringify(experience)));
    assert.equal(
      (await restarted.recall(right.key, right.scope, {}, undefined, undefined, state)).length,
      0,
    );
    const repaired = { ...right, id: memory('B').id, parent: right.id, steps: [...right.steps] };
    repaired.steps[0] = { ...right.steps[0], action: { kind: 'click', target: { name: 'Apply' } } };
    await leftStore.save(repaired);
    const updated = await record(repaired.id);
    assert.notEqual(updated.steps[0].atom, a.steps[0].atom);
    assert.equal(updated.steps[1].atom, b.steps[1].atom);
    assert.deepEqual(await restarted.get(left.id), JSON.parse(JSON.stringify(left)));
    assert.equal((await readdir(join(directory, 'atoms'))).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Atom references are scoped to the application and adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-atom-scope-'));
  try {
    const store = new ExperienceStore(directory);
    await store.save(memory('A'));
    await store.save({ ...memory('B'), scope: 'different-application' });
    await store.save({ ...memory('C'), adapter: 'different-adapter' });
    assert.equal((await readdir(join(directory, 'atoms'))).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Legacy inline programs and newly stored atom references replay from the same catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-atom-legacy-'));
  try {
    const legacy = memory('legacy'),
      current = memory('current');
    const legacyPath = join(directory, 'experiences', legacy.id + '.json');
    const legacyBody = JSON.stringify(legacy);
    await mkdir(join(directory, 'experiences'));
    await writeFile(legacyPath, legacyBody);
    await new ExperienceStore(directory).save(current);
    const store = new ExperienceStore(directory);
    assert.equal((await store.list()).length, 2);
    for (const experience of [legacy, current])
      assert.deepEqual(await store.get(experience.id), JSON.parse(JSON.stringify(experience)));
    assert.equal(await readFile(legacyPath, 'utf8'), legacyBody);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Batch staging admits no shared atoms until the final audit and retains only references after promotion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-atom-batch-'));
  try {
    const store = new ExperienceStore(directory);
    const candidate = memory('pending'),
      rejected = memory('rejected');
    await store.stage('batch', candidate, 'batch:1', 'attempt');
    await store.stage('batch', rejected, 'batch:2', 'attempt');
    assert.deepEqual(await store.list(), []);
    await assert.rejects(readdir(join(directory, 'atoms')), { code: 'ENOENT' });
    await store.settleCandidates('batch', [
      { id: '1', experience: candidate.id, status: 'confirmed' },
      { id: '2', experience: rejected.id, status: 'rejected' },
    ]);
    const programs = await store.list();
    assert.equal(programs.length, 1);
    assert.equal(programs[0].id, candidate.id);
    assert.equal((await readdir(join(directory, 'atoms'))).length, 1);
    const persisted = JSON.parse(
      await readFile(join(directory, 'provisional', candidate.id + '.json'), 'utf8'),
    );
    assert.equal(persisted.status, 'promoted');
    assert.deepEqual(persisted.memory.steps.map(Object.keys), [['atom', 'sourceIndex']]);
    const promoted = (await store.provisional('batch')).find((p) => p.status === 'promoted');
    assert.deepEqual(promoted?.memory, JSON.parse(JSON.stringify(candidate)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A fresh process-style store reads only indexed candidate bodies; warm recall uses the cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-index-'));
  try {
    const store = new ExperienceStore(directory);
    for (let i = 0; i < 80; i++) await store.save(memory('task-' + i));
    await store.recall('task-42', 'fixture', {}); // Build the derived index once.
    const restarted = new ExperienceStore(directory);
    for (let i = 0; i < 20; i++)
      assert.equal((await restarted.recall('task-42', 'fixture', {})).length, 1);
    assert.equal(restarted.stats.indexBuilds, 0);
    assert.equal(restarted.stats.bodyReads, 1);
    assert.equal(restarted.stats.indexHits, 20);
    const other = new ExperienceStore(directory);
    await other.save(memory('new-task'));
    assert.equal((await restarted.recall('new-task', 'fixture', {})).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Feedback affects ranking, quarantined versions stay out, and explicit applicability filters candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-health-'));
  try {
    const store = new ExperienceStore(directory),
      trusted = memory('same', { text: 'Form A' }),
      newer = memory('same', { text: 'Form B' });
    await store.save(trusted);
    await store.save(newer);
    await store.feedback(trusted.id, success);
    assert.equal((await store.recall('same', 'fixture', {}))[0].id, trusted.id);
    assert.deepEqual(
      (await store.recall('same', 'fixture', {}, undefined, undefined, state)).map((m) => m.id),
      [trusted.id],
    );
    await store.quarantine(trusted.id, 'The target no longer exists');
    assert.deepEqual(
      (await new ExperienceStore(directory).recall('same', 'fixture', {})).map((m) => m.id),
      [newer.id],
    );
    assert.equal(
      (await store.list()).length,
      2,
      'Isolation preserves the old evidence instead of deleting it',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function workflowHost(id: string) {
  const calls: Action[] = [];
  const elements = [
    ['textbox', 'Title'],
    ['button', 'Review'],
    ['button', 'Save'],
  ].map(([role, name], index) => ({ ref: String(index), role, name, locator: { role, name } }));
  const host = {
    id,
    capabilities: ['click', 'fill'] as const,
    observe: async () =>
      observation({
        surface: 'web',
        scope: 'local-workflow',
        title: 'Local workflow',
        text: calls.length ? 'Saved' : 'Ready',
        elements,
      }),
    act: async (action: Action) => {
      calls.push(action);
    },
  } satisfies Host;
  return { host, calls };
}

test('An agent discovers a verified operation by scope and replays it with fresh inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-discovery-'));
  try {
    const store = new ExperienceStore(directory);
    const { host, calls } = workflowHost('original');
    const first = await new Reflex({
      host,
      store,
      explore: async ({ tools }) => {
        await tools.act({ kind: 'fill', target: { ref: '0' }, input: 'title' });
        await tools.act({ kind: 'click', target: { ref: '2' } });
        return { goal: { text: 'Saved' } };
      },
    }).run({ key: 'save-record', job: 'first', inputs: { title: 'First title' }, learn: true });
    assert.equal(first.status, 'completed');
    assert.ok(first.experience);

    await store.save(memory('another-scope'));
    const quarantined = { ...memory('quarantined'), scope: 'local-workflow' };
    await store.save(quarantined);
    await store.quarantine(quarantined.id, 'Outdated controls');
    await store.stage(
      'pending-batch',
      { ...memory('pending-audit'), scope: 'local-workflow' },
      'pending-batch:first',
      'attempt',
    );
    await store.versions();

    const restarted = new ExperienceStore(directory);
    const observation = await host.observe();
    const candidates = await restarted.discover(observation.scope);
    assert.deepEqual(candidates, [
      { id: first.experience, key: 'save-record', requiredInputs: ['title'] },
    ]);
    assert.equal(restarted.stats.bodyReads, 0);
    const selected = await restarted.get(candidates[0].id);
    assert.ok(selected);
    const next = await new Reflex({ host, store: restarted }).run({
      key: selected.key,
      experience: selected.id,
      job: 'second',
      inputs: { title: 'New title' },
      allowedScopes: [observation.scope],
    });
    assert.equal(next.source, 'memory');
    assert.equal(next.status, 'completed');
    assert.deepEqual(
      calls.filter((action) => action.kind === 'fill').map((action) => action.value),
      ['First title', 'New title'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Verified examples align stable steps, explicit branches route and repetitions stay candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-study-'));
  try {
    const store = new ExperienceStore(directory),
      { host, calls } = workflowHost('original');
    const runner = new Reflex({
      host,
      store,
      explore: async ({ task, tools }) => {
        await tools.act({ kind: 'fill', target: { ref: '0' }, input: 'title' });
        if (task.inputs.mode === 'review')
          for (let i = 0; i < 2; i++) await tools.act({ kind: 'click', target: { ref: '1' } });
        await tools.act({ kind: 'click', target: { ref: '2' } });
        return {
          goal: { text: 'Saved' },
          parameterCandidates: [{ input: 'title', step: 0, path: 'value' }],
        };
      },
    });
    const task = (job: string, mode: string): Task => ({
      key: 'save',
      job,
      guardInputs: ['mode'],
      inputs: { title: job, mode },
    });
    assert.equal((await runner.run(task('sample-a', 'direct'))).source, 'explore');
    assert.equal((await runner.run(task('sample-b', 'review'))).source, 'explore');
    calls.length = 0;
    assert.equal((await runner.run(task('sample-c', 'review'))).source, 'memory');
    assert.deepEqual(
      calls.map((a) => a.target?.name),
      ['Title', 'Review', 'Review', 'Save'],
    );
    const study = await new ExperienceStore(directory).study('save', 'local-workflow');
    assert.equal(study.alignedExamples, 2);
    assert.equal(study.stable.length, 2);
    assert.deepEqual(
      study.parameters.find((p) => p.input === 'title'),
      { input: 'title', samples: 3, distinctValues: 3 },
    );
    const review = study.routes.find((r) => r.when?.mode === 'review');
    assert.deepEqual(review?.differences, [1, 2]);
    assert.deepEqual(review?.repeatCandidates, [{ start: 1, length: 1, count: 2 }]);
    assert.equal(study.candidates.length, 2);
    assert.equal((await readFile(join(directory, 'sample-key'))).length, 32);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Conflicting verified routes with overlapping guards delegate before executing an old action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-overlap-'));
  try {
    const store = new ExperienceStore(directory),
      { host, calls } = workflowHost('original');
    const task = { key: 'overlap', inputs: { title: 'task-a' } };
    const examples = new Reflex({
      host,
      store,
      explore: async ({ task, tools }) => {
        await tools.act({ kind: 'click', target: { ref: task.learn ? '1' : '2' } });
        return { goal: { text: 'Saved' } };
      },
    });
    assert.equal((await examples.run({ ...task, job: 'first' })).status, 'completed');
    assert.equal((await examples.run({ ...task, job: 'second', learn: true })).status, 'completed');
    const before = calls.length;
    const batch = await examples.run({
      ...task,
      job: 'third',
      batch: 'bounded',
      verification: 'attempt',
    });
    assert.match(batch.error!, /overlap/);
    assert.equal(calls.length, before);
    assert.equal((await examples.run({ ...task, job: 'fourth' })).source, 'explore');
    assert.equal(calls.length, before + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A model proposal cannot turn unknown content into an executable parameter or memory literal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-proposal-'));
  try {
    const store = new ExperienceStore(directory),
      { host } = workflowHost('original'),
      privateValue = 'local-nondeclared-value';
    const result = await new Reflex({
      host,
      store,
      explore: async ({ tools }) => {
        await tools.act({ kind: 'fill', target: { ref: '0' }, value: privateValue });
        return {
          goal: { text: 'Saved' },
          parameterCandidates: [{ input: 'message', step: 0, path: 'value' }],
        };
      },
    }).run({ key: 'unbound', job: 'first', inputs: {} });
    assert.equal(result.status, 'completed');
    assert.match(result.learningError!, /task inputs/);
    assert.equal((await store.list()).length, 0);
    const study = await store.study('unbound', 'local-workflow');
    assert.deepEqual(study.parameters, []);
    assert.equal(study.candidates[0]?.status, 'proposed');
    assert.ok(!JSON.stringify(await store.episodes()).includes(privateValue));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Adapter-specific calls stay local; only proven plain actions receive portable intents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-portability-'));
  try {
    const store = new ExperienceStore(directory),
      { host, calls } = workflowHost('destination');
    const before = await host.observe();
    const adapter = new PlaywrightMcpHost({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
    });
    const source = (kind: string, args: Record<string, string | boolean>) =>
      compileExperience({
        key: kind,
        scope: before.scope,
        trace: [
          {
            action: {
              kind: 'tool',
              tool: 'browser_click',
              target: { role: 'button', name: 'Save' },
              bindings: { target: { role: 'button', name: 'Save' } },
              args: { target: 'e1', ...args },
              valuePaths: [],
              effect: true,
            },
            before,
            dispatched: true,
            durationMs: 1,
          },
        ],
        goal: { text: 'Saved' },
        episode: 'fixture',
        inputs: {},
        host: adapter,
      });
    const simple = source('portable', {}),
      modified = source('local-only', { doubleClick: true });
    assert.deepEqual(simple.steps[0].intent, {
      kind: 'click',
      target: { role: 'button', name: 'Save' },
    });
    assert.equal(modified.steps[0].intent, undefined);
    await store.save(simple);
    await store.save(modified);
    const runner = new Reflex({ host, store });
    const denied = await runner.run({
      key: 'portable',
      job: 'deny',
      inputs: {},
      beforeEffect: () => false,
    });
    assert.equal(denied.status, 'skipped');
    assert.equal(calls.length, 0);
    assert.equal(
      (await runner.run({ key: 'local-only', job: 'unsupported', inputs: {} })).status,
      'failed',
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (await runner.run({ key: 'portable', job: 'allow', inputs: {} })).experience,
      simple.id,
    );
    assert.deepEqual(calls[0], {
      kind: 'click',
      target: { role: 'button', name: 'Save' },
      effect: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('A task value that happens to equal a keyboard command does not rewrite the command', async () => {
  const { host } = workflowHost('original');
  const before = await host.observe();
  const memory = compileExperience({
    key: 'save-title',
    scope: before.scope,
    episode: 'fixture',
    host,
    inputs: { title: 'Enter' },
    goal: { text: 'Saved' },
    trace: [
      {
        action: { kind: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Enter' },
        before,
        dispatched: true,
        durationMs: 1,
      },
      {
        action: { kind: 'press', value: 'Enter', effect: true },
        before,
        dispatched: true,
        durationMs: 1,
      },
    ],
  });
  assert.equal(
    (decode(memory.steps[0].action, { title: 'Backspace' }) as Action).value,
    'Backspace',
  );
  assert.equal((decode(memory.steps[1].action, { title: 'Backspace' }) as Action).value, 'Enter');
});
