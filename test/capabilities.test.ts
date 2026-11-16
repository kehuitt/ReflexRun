import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CapabilityLibrary,
  CapabilityCapture,
  type CapabilityBoundary,
  type CapabilityProposal,
  type FactState,
  type FactRule,
} from '../src/memory/capabilities.js';
import { ExperienceStore } from '../src/memory/store.js';
import { compileExperience, elementFor, observation } from '../src/memory/compiler.js';
import type { Action, Host, Inputs, TraceStep } from '../src/memory/types.js';

const scope = 'https://fixture.invalid',
  recordKind = 'fixture-record',
  read: FactRule = { field: 'read', op: 'equals', value: true },
  tag: FactRule = { field: 'tags', op: 'contains', value: { $input: 'tag' } },
  editor = { role: 'textbox', name: 'Tag' },
  open = (subject: string): Action => ({
    kind: 'click',
    target: { role: 'link', name: subject },
    effect: true,
  }),
  back = (): Action => ({
    kind: 'click',
    target: { role: 'button', name: 'Return' },
    effect: false,
  }),
  addTag = (text: string): Action => ({
    kind: 'tool',
    tool: 'browser_type',
    args: { target: 'tag-ref', text, submit: true, element: 'Tag field' },
    target: editor,
    bindings: { target: editor },
    valuePaths: ['text'],
    effect: true,
  });

class RecordHost implements Host {
  id = 'fixture-host';
  capabilities = ['click', 'tool'] as const;
  detail = false;
  detailRoute = 'view';
  returnName = 'Return';
  editorName = 'Tag';
  actions: Action[] = [];
  records: Record<string, Record<string, any>>;
  constructor(
    read = false,
    tags: string[] = [],
    readonly identity = 'record-1',
    readonly subject = 'First subject',
  ) {
    this.records = {
      [identity]: { read, tags, rawSha: 'immutable-message-bytes' },
      other: { read: false, tags: ['Existing'], rawSha: 'other-message-bytes' },
    };
  }
  async observe() {
    const element = (ref: string, role: string, name: string) => ({
      ref,
      role,
      name,
      locator: { role, name },
    });
    return observation({
      surface: 'web',
      scope,
      title: 'Fixture',
      url: this.detail ? `${scope}/${this.detailRoute}/${this.identity}` : `${scope}/inbox`,
      text: this.detail ? 'Detail' : 'Mailbox',
      elements: this.detail
        ? [
            element('tag-ref', 'textbox', this.editorName),
            element('back-ref', 'button', this.returnName),
          ]
        : [
            element('record-ref', 'link', this.subject),
            element('other-ref', 'link', 'Another record'),
          ],
    });
  }
  facts(): FactState {
    return structuredClone({
      scope,
      recordKind,
      identity: this.identity,
      fields: this.records[this.identity],
      records: this.records,
      writableFields: ['read', 'tags'],
      source: 'independent fixture storage',
    });
  }
  async act(action: Action) {
    assert.ok(elementFor(action.target, await this.observe()), 'Fixture target must resolve');
    this.actions.push(structuredClone(action));
    if (action.kind === 'tool') {
      const value = action.args!.text as string;
      if (!this.records[this.identity].tags.includes(value))
        this.records[this.identity].tags.push(value);
    } else if (this.detail) this.detail = false;
    else {
      this.detail = true;
      this.records[this.identity].read = true;
    }
  }
}

async function source(host: RecordHost, actions: Action[], key: string, inputs: Inputs) {
  const trace: TraceStep[] = [],
    boundaries: CapabilityBoundary[] = [{ observation: await host.observe(), facts: host.facts() }];
  for (const action of actions) {
    const before = await host.observe();
    await host.act(action);
    const after = await host.observe();
    trace.push({ action, before, after, dispatched: true, durationMs: 1 });
    boundaries.push({ observation: after, facts: host.facts() });
  }
  const experience = compileExperience({
    key,
    scope,
    trace,
    inputs,
    goal: { text: 'Mailbox' },
    episode: `${key}-episode`,
    host,
  });
  return { experience, inputs, trace, boundaries };
}
const findProposal = (subject: string): CapabilityProposal => ({
  label: 'Find and open record',
  start: 0,
  end: 1,
  requires: { target: { role: 'link', name: subject } },
  ensures: { target: editor },
  effects: [read],
});
const backProposal = (subject: string, start: number): CapabilityProposal => ({
  label: 'Return to list',
  start,
  end: start + 1,
  requires: { target: editor },
  ensures: { target: { role: 'link', name: subject } },
  effects: [],
});

test('Two observed fact-state versions of the exact same program can satisfy a new plan', async () =>
  directory(async (library) => {
    const original = new RecordHost();
    const inputs = { subject: original.subject, tag: 'Work' };
    const first = await source(original, [open(original.subject), back()], 'A', inputs);
    const a = await library.learn({
      ...first,
      proposals: [
        { ...findProposal(original.subject), requiresFacts: [{ ...read, value: false }] },
        backProposal(original.subject, 1),
      ],
    });
    const second = await source(
      original,
      [open(original.subject), addTag(inputs.tag), back()],
      'B',
      inputs,
    );
    const b = await library.learn({
      ...second,
      proposals: [
        { ...findProposal(original.subject), requiresFacts: [read] },
        {
          label: 'Tag',
          start: 1,
          end: 2,
          requires: { target: editor },
          ensures: { target: editor },
          effects: [tag],
        },
      ],
    });
    const next = new RecordHost(true, [], 'read-variant', 'Already read');
    const result = await library.run({
      task: task(next),
      identity: next.identity,
      recordKind,
      goal: [read, tag],
      plan: [a[0].id, b[1].id, a[1].id],
      host: next,
      readFacts: async () => next.facts(),
    });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.capabilities, [b[0].id, b[1].id, a[1].id]);
    assert.deepEqual(next.records[next.identity].tags, ['New tag']);
    assert.deepEqual(a[0].requiresFacts, [{ ...read, value: false }]);
  }));

test('A visible completion check shared by two pages cannot skip required navigation', async () =>
  directory(async (library) => {
    const original = new RecordHost();
    const experience = await source(original, [open(original.subject), back()], 'read', {
      subject: original.subject,
    });
    const learned = await library.learn({
      ...experience,
      proposals: [
        findProposal(original.subject),
        { ...backProposal(original.subject, 1), ensures: { urlIncludes: scope } },
      ],
    });
    const next = new RecordHost(false, [], 'next', 'Next subject');
    const result = await library.run({
      task: task(next),
      identity: next.identity,
      recordKind,
      goal: [read],
      plan: learned.map((cap) => cap.id),
      host: next,
      readFacts: async () => next.facts(),
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.actions, 2);
    assert.equal(next.detail, false);
  }));
async function training(library: CapabilityLibrary, host = new RecordHost()) {
  const inputs = { subject: host.subject, tag: 'Work' },
    aSource = await source(host, [open(host.subject), back()], 'A', { subject: host.subject }),
    a = await library.learn({
      ...aSource,
      proposals: [findProposal(host.subject), backProposal(host.subject, 1)],
    }),
    bSource = await source(host, [open(host.subject), addTag(inputs.tag), back()], 'B', inputs),
    b = await library.learn({
      ...bSource,
      proposals: [
        findProposal(host.subject),
        {
          label: 'Add tag',
          start: 1,
          end: 2,
          requires: { target: editor },
          ensures: { target: editor },
          effects: [{ field: 'tags', op: 'contains', value: inputs.tag }],
        },
        backProposal(host.subject, 2),
      ],
    });
  return { a, b, aSource, bSource, plan: [a[0].id, b[1].id, a[1].id] };
}
async function directory(run: (library: CapabilityLibrary) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'reflex-capabilities-'));
  try {
    await run(new CapabilityLibrary(path));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
function task(host: RecordHost, job = 'job', key = 'C') {
  return { key, job, inputs: { subject: host.subject, tag: 'New tag' }, allowedScopes: [scope] };
}
function run(library: CapabilityLibrary, host: RecordHost, plan: string[], job = 'job') {
  return library.run({
    task: task(host, job),
    identity: host.identity,
    recordKind,
    goal: [read, tag],
    plan,
    host,
    readFacts: async () => host.facts(),
  });
}

test('Replaying an identical workflow keeps its verified catalog entry without rewriting it', async () =>
  directory(async (library) => {
    const { plan } = await training(library);
    const path = join(library.directory, 'capabilities.json');
    const first = new RecordHost(false, [], 'first-destination', 'First destination');
    const second = new RecordHost(false, [], 'second-destination', 'Second destination');
    assert.equal((await run(library, first, plan, 'first')).status, 'completed');
    const before = await stat(path);
    const result = await run(library, second, plan, 'second');
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.actions, 3);
    assert.deepEqual(second.facts().fields.tags, ['New tag']);
    assert.equal((await stat(path)).ino, before.ino);
    assert.deepEqual((await library.dependencies()).workflows.C, plan);
  }));

test('Model-proposed exact source ranges become parameterized capabilities shared across tasks', async () =>
  directory(async (library) => {
    const { a, b, plan } = await training(library);
    assert.equal(a[0].id, b[0].id);
    assert.equal(a[1].id, b[2].id);
    const catalog = await library.candidates(scope, recordKind);
    assert.equal(catalog.find((cap) => cap.id === a[0].id)!.evidence.length, 2);
    assert.equal(catalog.length, 3);
    assert.deepEqual(b[1].effects, [tag]);
    assert.deepEqual(b[1].inputs, ['tag']);
    const host = new RecordHost(false, ['Preserved'], 'record-2', 'Second subject'),
      result = await run(library, host, plan);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.actions, 3);
    assert.deepEqual(host.records[host.identity].tags, ['Preserved', 'New tag']);
    assert.deepEqual((await library.dependencies()).workflows.C, plan);
  }));

test('Local planning composes observed effects and shares snapshots across capability boundaries', async () =>
  directory(async (library) => {
    const { plan } = await training(library);
    class SharedHost extends RecordHost {
      reused = 0;
      async observeUntil(
        ready: Parameters<NonNullable<Host['observeUntil']>>[0],
        _action: Action,
        initial?: Awaited<ReturnType<Host['observe']>>,
      ) {
        if (initial) this.reused++;
        const state = initial ?? (await this.observe());
        assert.ok(ready(state));
        return state;
      }
    }
    const host = new SharedHost(false, ['Preserved'], 'new-record', 'New subject');
    let checked = 0;
    const result = await library.run({
      task: {
        ...task(host),
        verification: 'readback',
        readback: async () => {
          checked++;
          assert.equal(host.detail, false);
          assert.deepEqual(host.records[host.identity].tags, ['Preserved', 'New tag']);
          return { status: 'confirmed', source: 'fixture storage' };
        },
      },
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      host,
      readFacts: async () => host.facts(),
      selectPlan: async () => {
        throw new Error('The local match is unique');
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.planSource, 'local');
    assert.deepEqual(result.plan, plan);
    assert.equal(host.reused, 2);
    assert.equal(checked, 1);
  }));

test('Local selection refreshes a missing entry locator before asking the model', async () =>
  directory(async (library) => {
    await training(library);
    class LateInbox extends RecordHost {
      snapshots = 0;
      override async observe() {
        const state = await super.observe();
        return ++this.snapshots === 1 ? { ...state, elements: [] } : state;
      }
    }
    const host = new LateInbox(false, [], 'new-record', 'New subject');
    const result = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      host,
      readFacts: async () => host.facts(),
      selectPlan: async () => {
        throw new Error('The entry locator is visible after refresh');
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.planSource, 'local');
  }));

test('Local selection accepts a verified repair for its entry action and UI condition', async () =>
  directory(async (library) => {
    const { b } = await training(library);
    for (const mode of ['explicit', 'local'] as const) {
      const host = new RecordHost(true, [], mode, 'New subject');
      host.detail = true;
      host.editorName = 'Renamed tag';
      const result = await library.run({
        task: task(host),
        identity: host.identity,
        recordKind,
        goal: [tag],
        host,
        readFacts: async () => host.facts(),
        ...(mode === 'explicit'
          ? {
              plan: [b[1].id],
              repair: async ({ action }: { action: Action }) => {
                const target = { role: editor.role, name: host.editorName };
                return { ...action, target, bindings: { target } };
              },
            }
          : {}),
      });
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.planSource, mode);
      assert.equal(result.repairs, mode === 'explicit' ? 1 : 0);
    }
  }));

test('Equally short different browser programs ask the selector before any write', async () =>
  directory(async (library) => {
    const { plan } = await training(library);
    const sourceHost = new RecordHost(true);
    sourceHost.detail = true;
    const alternate = addTag('Work');
    alternate.args!.submit = false;
    await library.learn({
      ...(await source(sourceHost, [alternate], 'B alternate', { tag: 'Work' })),
      proposals: [
        {
          label: 'Alternate tag input',
          start: 0,
          end: 1,
          requires: { target: editor },
          ensures: { target: editor },
          effects: [tag],
        },
      ],
    });
    const host = new RecordHost(false, [], 'new-record', 'New subject');
    const run = {
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      host,
      readFacts: async () => host.facts(),
    };
    const ambiguous = await library.run(run);
    assert.equal(ambiguous.status, 'failed');
    assert.match(ambiguous.error!, /No unique compatible capability plan/);
    assert.equal(host.actions.length, 0);
    const selected = await library.run({
      ...run,
      selectPlan: async (candidates) => {
        assert.equal(host.actions.length, 0);
        assert.ok(candidates.some((cap) => cap.label === 'Alternate tag input'));
        return plan;
      },
    });
    assert.equal(selected.status, 'completed', selected.error);
    assert.equal(selected.planSource, 'model');
  }));

test('Local planning requires evidence of a change, not a fact already true during learning', async () =>
  directory(async (library) => {
    const sourceHost = new RecordHost(true);
    await library.learn({
      ...(await source(sourceHost, [open(sourceHost.subject), addTag('Work'), back()], 'B', {
        subject: sourceHost.subject,
        tag: 'Work',
      })),
      proposals: [
        {
          label: 'Tag a previously read record',
          start: 0,
          end: 3,
          requires: { text: 'Mailbox' },
          ensures: { text: 'Mailbox' },
          effects: [read, tag],
        },
      ],
    });
    const host = new RecordHost(false, [], 'new-record', 'New subject');
    const result = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      host,
      readFacts: async () => host.facts(),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /No unique compatible capability plan/);
    assert.equal(host.actions.length, 0);
  }));

test('A stale missing target is refreshed before asking for repair', async () =>
  directory(async (library) => {
    const { a, b, aSource } = await training(library);
    const [find] = await library.learn({
      ...aSource,
      proposals: [
        {
          ...findProposal(String(aSource.inputs.subject)),
          ensures: { text: 'Detail' },
        },
      ],
    });
    class DelayedTargetHost extends RecordHost {
      pending = false;
      refreshed = false;
      override async act(action: Action) {
        await super.act(action);
        if (action.kind === 'click' && this.detail) this.pending = true;
      }
      override async observe({ fresh = false } = {}) {
        const state = await super.observe();
        if (!this.pending) return state;
        if (!fresh)
          return { ...state, elements: state.elements.filter((el) => el.role !== editor.role) };
        this.pending = false;
        this.refreshed = true;
        return state;
      }
    }
    const host = new DelayedTargetHost(false, [], 'new-record', 'New subject');
    const result = await run(library, host, [find.id, b[1].id, a[1].id]);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(host.refreshed, true);
    assert.equal(result.repairs, 0);
  }));

for (const [initialRead, hasTag, actions] of [
  [false, false, 3],
  [true, false, 3],
  [false, true, 2],
  [true, true, 0],
] as const)
  test(`State-aware goal execution: read=${initialRead}, tag=${hasTag} performs ${actions} actions`, async () =>
    directory(async (library) => {
      const { plan } = await training(library),
        host = new RecordHost(
          initialRead,
          hasTag ? ['New tag'] : [],
          'fresh-record',
          'Changed subject',
        ),
        result = await run(library, host, plan);
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.actions, actions);
      assert.equal(host.records[host.identity].read, true);
      assert.deepEqual(host.records[host.identity].tags, ['New tag']);
    }));

test('An already-open record skips the learned opening without skipping unfinished effects', async () =>
  directory(async (library) => {
    const { plan } = await training(library),
      host = new RecordHost(true, [], 'fresh-record', 'Changed subject');
    host.detail = true;
    const result = await run(library, host, plan);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.skipped, 1);
    assert.equal(result.actions, 2);
  }));

test('Fabricated ranges, payloads, identities, immutable writes, and other-record writes are rejected atomically', async () =>
  directory(async (library) => {
    const { aSource } = await training(library),
      original = { ...aSource, proposals: [findProposal('First subject')] };
    await assert.rejects(
      library.learn({ ...original, proposals: [{ ...original.proposals[0], end: 99 }] }),
      /range/,
    );
    const forged = structuredClone(original);
    (forged.experience.steps[0].action as any).kind = 'tool';
    await assert.rejects(library.learn(forged), /exact successful/);
    for (const change of ['identity', 'immutable', 'other-record'] as const) {
      const invalid = structuredClone(original),
        state = invalid.boundaries[1].facts;
      if (change === 'identity') state.identity = 'other';
      if (change === 'immutable') {
        state.fields.rawSha = 'changed';
        state.records[state.identity].rawSha = 'changed';
      }
      if (change === 'other-record') state.records.other.read = true;
      await assert.rejects(library.learn(invalid), /identity|immutable|another record/);
    }
    assert.equal((await library.candidates(scope, recordKind)).length, 3);
  }));

test('A contains guarantee cannot hide deletion of existing values', async () =>
  directory(async (library) => {
    const { bSource } = await training(library),
      invalid = structuredClone(bSource);
    invalid.boundaries[1].facts.fields.tags = ['Keep'];
    invalid.boundaries[1].facts.records['record-1'].tags = ['Keep'];
    await assert.rejects(
      library.learn({
        ...invalid,
        proposals: [
          {
            label: 'Fabricated replacement',
            start: 1,
            end: 2,
            requires: { target: editor },
            ensures: { target: editor },
            effects: [{ field: 'tags', op: 'contains', value: 'Work' }],
          },
        ],
      }),
      /exceeded/,
    );
  }));

test('Missing dynamic facts fail before dispatch; unknown post-write facts fence future jobs for that record', async () =>
  directory(async (library) => {
    const { plan } = await training(library),
      missing = new RecordHost(),
      noFacts = missing.facts();
    delete noFacts.fields.tags;
    const initial = await library.run({
      task: task(missing),
      identity: missing.identity,
      recordKind,
      goal: [read, tag],
      plan,
      host: missing,
      readFacts: async () => noFacts,
    });
    assert.equal(initial.status, 'failed');
    assert.equal(missing.actions.length, 0);
    const host = new RecordHost(false, [], 'unknown-record', 'Unknown subject');
    const failed = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      plan,
      host,
      readFacts: async () => {
        if (host.actions.length) throw new Error('Storage reader offline');
        return host.facts();
      },
    });
    assert.equal(failed.status, 'uncertain', failed.error);
    assert.equal(host.actions.length, 1);
    const retry = await run(library, host, plan, 'new-job');
    assert.equal(retry.status, 'uncertain');
    assert.match(retry.error!, /unconfirmed prior attempt/);
    assert.equal(host.actions.length, 1);
  }));

test('Host policy, scopes, constraints, and authorized field effects survive composition', async () =>
  directory(async (library) => {
    const { plan } = await training(library);
    for (const violation of ['scope', 'constraints', 'policy', 'effects'] as const) {
      const host = new RecordHost(false, [], violation, 'Target subject'),
        definition = task(host);
      if (violation === 'scope') definition.allowedScopes = ['https://different.invalid'];
      if (violation === 'constraints')
        Object.assign(definition, { constraints: { prohibit: 'tag' } });
      if (violation === 'policy') Object.assign(definition, { beforeEffect: async () => false });
      const result = await library.run({
        task: definition,
        identity: host.identity,
        recordKind,
        goal: violation === 'effects' ? [tag] : [read, tag],
        plan,
        host,
        readFacts: async () => host.facts(),
      });
      assert.equal(result.status, 'failed', result.error);
      assert.equal(host.actions.length, 0);
    }
  }));

test('One locator repair is shared across compatible workflows while old UI remains usable', async () =>
  directory(async (library) => {
    const { a, b, plan } = await training(library),
      host = new RecordHost(false, [], 'repair-record', 'Repair subject');
    host.returnName = 'Mailbox home';
    let callbacks = 0;
    const result = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      plan,
      host,
      readFacts: async () => host.facts(),
      repair: async ({ action }) => {
        callbacks++;
        return { ...action, target: { role: 'button', name: host.returnName } };
      },
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(callbacks, 1);
    assert.equal((await library.dependencies()).repairs.length, 1);
    for (const [name, capabilities, initialRead] of [
      ['A', a, false],
      ['B', b, true],
    ] as const) {
      const next = new RecordHost(initialRead, [], `next-${name}`, `New ${name} subject`);
      next.returnName = host.returnName;
      const reused = await library.run({
        task: task(next, name, name),
        identity: next.identity,
        recordKind,
        goal: name === 'A' ? [read] : [tag],
        plan: capabilities.map((cap) => cap.id),
        host: next,
        readFacts: async () => next.facts(),
      });
      assert.equal(reused.status, 'completed', reused.error);
      assert.equal(reused.repairs, 0);
      assert.equal(next.detail, false);
    }
    const old = new RecordHost(false, [], 'old-ui', 'Old interface subject'),
      unchanged = await run(library, old, plan, 'old');
    assert.equal(unchanged.status, 'completed', unchanged.error);
    assert.equal(unchanged.repairs, 0);
  }));

test('Same-named controls on different source routes do not inherit another page repair', async () =>
  directory(async (library) => {
    const { a } = await training(library),
      drift = new RecordHost(false, [], 'route-repair', 'Route subject');
    drift.returnName = 'New return';
    const repaired = await library.run({
      task: task(drift),
      identity: drift.identity,
      recordKind,
      goal: [read],
      plan: a.map((cap) => cap.id),
      host: drift,
      readFacts: async () => drift.facts(),
      repair: async ({ action }) => ({
        ...action,
        target: { role: 'button', name: drift.returnName },
      }),
    });
    assert.equal(repaired.status, 'completed', repaired.error);
    const different = new RecordHost(true, [], 'settings-record', 'Settings subject');
    different.detail = true;
    different.detailRoute = 'settings';
    const otherSource = await source(different, [back()], 'settings-navigation', {
        subject: different.subject,
      }),
      other = await library.learn({
        ...otherSource,
        proposals: [backProposal(different.subject, 0)],
      });
    const next = new RecordHost(false, [], 'another-settings', 'Another settings subject');
    next.detail = true;
    next.detailRoute = 'settings';
    next.returnName = drift.returnName;
    const rejected = await library.run({
      task: task(next),
      identity: next.identity,
      recordKind,
      goal: [read],
      plan: [other[0].id],
      host: next,
      readFacts: async () => next.facts(),
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(next.actions.length, 0);
    assert.match(rejected.error!, /locator changed/);
  }));

test('Numeric record IDs preserve a versioned route prefix during replay', async () =>
  directory(async (library) => {
    const original = new RecordHost(false, [], '1'),
      next = new RecordHost(false, [], '2', 'Second subject');
    original.detailRoute = next.detailRoute = 'v1/view';
    const { plan } = await training(library, original);
    const result = await run(library, next, plan);
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(next.facts().fields.tags, ['New tag']);
    assert.equal(next.detail, false);
  }));

test('Compiled native bindings accept a target-only translation and reject a changed payload', async () =>
  directory(async (library) => {
    const { b } = await training(library);
    for (const expanded of [false, true]) {
      const host = new RecordHost(true, [], `native-${expanded}`, 'Native subject');
      host.detail = true;
      host.editorName = `New tag editor ${expanded}`;
      const result = await library.run({
        task: task(host),
        identity: host.identity,
        recordKind,
        goal: [tag],
        plan: [b[1].id, b[2].id],
        host,
        readFacts: async () => host.facts(),
        repair: async ({ action }) => ({
          ...action,
          target: { role: 'textbox', name: host.editorName },
          bindings: { target: { role: 'textbox', name: host.editorName } },
          args: {
            ...action.args,
            target: 'live-native-ref',
            element: 'Updated descriptive annotation',
            ...(expanded ? { text: 'Unauthorized payload' } : {}),
          },
        }),
      });
      assert.equal(result.status, expanded ? 'failed' : 'completed', result.error);
      assert.equal(host.actions.length, expanded ? 0 : 2);
    }
  }));

test('A record-binding repair cannot replace the input identity with a different record', async () =>
  directory(async (library) => {
    const { a } = await training(library),
      host = new RecordHost(false, [], 'identity-record', 'Changed subject');
    const definition = task(host);
    definition.inputs.subject = 'Missing original subject';
    const result = await library.run({
      task: definition,
      identity: host.identity,
      recordKind,
      goal: [read],
      plan: a.map((cap) => cap.id),
      host,
      readFacts: async () => host.facts(),
      repair: async ({ action }) => ({
        ...action,
        target: { role: 'link', name: 'Another record' },
      }),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /identity parameter/);
    assert.equal(host.actions.length, 0);
  }));

test('Fresh trusted facts and the original policy are rechecked after a repair wait before writing', async () =>
  directory(async (library) => {
    const { b } = await training(library),
      host = new RecordHost(true, [], 'late-change', 'Late change subject');
    host.detail = true;
    host.editorName = 'New tag editor';
    let policyChecks = 0;
    const result = await library.run({
      task: {
        ...task(host),
        beforeEffect: async () => {
          policyChecks++;
          return true;
        },
      },
      identity: host.identity,
      recordKind,
      goal: [tag],
      plan: [b[1].id, b[2].id],
      host,
      readFacts: async () => host.facts(),
      repair: async ({ action }) => {
        host.records.other.read = true;
        return {
          ...action,
          target: { role: 'textbox', name: host.editorName },
          bindings: { target: { role: 'textbox', name: host.editorName } },
        };
      },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /another record/);
    assert.equal(host.actions.length, 0);
    assert.equal(policyChecks, 0);
    assert.equal((await library.dependencies()).repairs.length, 0);
  }));

test('A page change during repair blocks dispatch even when the replacement still resolves', async () =>
  directory(async (library) => {
    const { b } = await training(library),
      host = new RecordHost(true, [], 'page-change', 'Page change subject');
    host.detail = true;
    host.editorName = 'New tag editor';
    const before = host.facts();
    const result = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [tag],
      plan: [b[1].id, b[2].id],
      host,
      readFacts: async () => host.facts(),
      repair: async ({ action }) => {
        host.detailRoute = 'settings';
        const target = { role: 'textbox', name: host.editorName };
        assert.ok(elementFor(target, await host.observe()));
        return { ...action, target, bindings: { target } };
      },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /source page changed before dispatch/);
    assert.equal(result.repairs, 1);
    assert.equal(host.actions.length, 0);
    assert.deepEqual(host.facts(), before);
    assert.equal((await library.dependencies()).repairs.length, 0);
  }));

test('Readback grade requires the original reader before any write', async () =>
  directory(async (library) => {
    const { plan } = await training(library),
      host = new RecordHost();
    const result = await library.run({
      task: { ...task(host), verification: 'readback' },
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      plan,
      host,
      readFacts: async () => host.facts(),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /independent reader/);
    assert.equal(host.actions.length, 0);
  }));

test('A final fresh snapshot cannot hide an unaccounted other-record change', async () =>
  directory(async (library) => {
    const host = new RecordHost(true, ['New tag']);
    let reads = 0;
    const result = await library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read, tag],
      plan: [],
      host,
      readFacts: async () => {
        if (++reads === 2) host.records.other.read = true;
        return host.facts();
      },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error!, /another record/);
    assert.equal(host.actions.length, 0);
  }));

test('Capture automatically records evidence and lazily invokes original-agent induction after verified success', async () =>
  directory(async (library) => {
    const host = new RecordHost(),
      store = new ExperienceStore(join(library.directory, 'source'));
    let proposals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = new CapabilityCapture({
      host,
      store,
      task: { ...task(host), inputs: { subject: host.subject } },
      library,
      readFacts: async () => host.facts(),
      propose: async (source) => {
        proposals++;
        assert.equal(source.trace.length, 2);
        assert.equal(source.boundaries.length, 3);
        assert.equal(source.boundaries[0].facts.fields.read, false);
        assert.equal(source.boundaries[1].facts.fields.read, true);
        assert.equal(source.candidates.length, 0);
        await gate;
        return [findProposal(host.subject), backProposal(host.subject, 1)];
      },
    });
    await capture.act(open(host.subject));
    await capture.act(back());
    const memory = await capture.complete({ text: 'Mailbox' });
    assert.equal((await store.get(memory.id))!.id, memory.id);
    assert.equal(capture.learning, 'pending');
    assert.equal(
      proposals,
      0,
      'Verified task completion must not await or start another model turn',
    );
    const ready = capture.waitForCapabilities();
    release();
    assert.equal((await ready).length, 2);
    assert.equal(capture.learning, 'ready');
    await capture.waitForCapabilities();
    assert.equal(proposals, 1);
    assert.equal(host.actions.length, 2, 'Induction and admission perform no UI actions');
  }));

test('A verified source accepts corrected same-turn ranges without another readback', async () =>
  directory(async (library) => {
    const host = new RecordHost();
    let reads = 0;
    const capture = new CapabilityCapture({
      host,
      store: new ExperienceStore(join(library.directory, 'source')),
      task: {
        ...task(host),
        verification: 'readback',
        readback: async () => {
          reads++;
          assert.equal(host.records[host.identity].read, true);
          assert.equal(host.detail, false);
          return { status: 'confirmed', source: 'fixture storage' };
        },
      },
      library,
      readFacts: async () => host.facts(),
    });
    const proposals = [findProposal(host.subject), backProposal(host.subject, 1)];
    await assert.rejects(capture.submitCapabilities(proposals), /verified completed/);
    await capture.act(open(host.subject));
    await capture.act(back());
    const exposed = capture.boundaryAt(1)!;
    exposed.facts.fields.read = false;
    assert.equal(capture.boundaryAt(1)?.facts.fields.read, true);
    await capture.complete({ text: 'Mailbox' });
    await assert.rejects(
      capture.submitCapabilities([{ ...proposals[0], end: 3 }]),
      /successful recorded actions/,
    );
    assert.equal((await library.candidates(scope, recordKind)).length, 0);
    assert.equal((await capture.submitCapabilities(proposals)).length, 2);
    assert.equal((await capture.waitForCapabilities()).length, 2);
    assert.equal(host.actions.length, 2);
    assert.equal(reads, 1);
  }));

test('Submitting A and B capabilities at completion enables a first C without model selection', async () =>
  directory(async (library) => {
    const store = new ExperienceStore(join(library.directory, 'source'));
    const a = new RecordHost(false, [], 'a', 'Read source');
    const b = new RecordHost(true, [], 'b', 'Tag source');
    const readCapture = new CapabilityCapture({
      host: a,
      store,
      task: task(a, 'read', 'A'),
      library,
      readFacts: async () => a.facts(),
    });
    await readCapture.act(open(a.subject));
    await readCapture.act(back());
    await readCapture.complete({ text: 'Mailbox' });
    const [openAndRead, returnToInbox] = await readCapture.submitCapabilities([
      findProposal(a.subject),
      backProposal(a.subject, 1),
    ]);
    const tagCapture = new CapabilityCapture({
      host: b,
      store,
      task: { ...task(b, 'tag', 'B'), inputs: { subject: b.subject, tag: 'Source tag' } },
      library,
      readFacts: async () => b.facts(),
    });
    await tagCapture.act(open(b.subject));
    await tagCapture.act(addTag('Source tag'));
    await tagCapture.act(back());
    await tagCapture.complete({ text: 'Mailbox' });
    const [applyTag] = await tagCapture.submitCapabilities([
      {
        label: 'Add tag',
        start: 1,
        end: 2,
        requires: { target: editor },
        ensures: { target: editor },
        effects: [tag],
      },
    ]);

    assert.deepEqual(Object.keys((await library.dependencies()).workflows).sort(), ['A', 'B']);
    const c = new RecordHost(false, ['Existing tag'], 'c', 'Unseen subject');
    const result = await library.run({
      task: task(c),
      identity: c.identity,
      recordKind,
      goal: [read, tag],
      host: c,
      readFacts: async () => c.facts(),
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.planSource, 'local');
    assert.deepEqual(result.capabilities, [openAndRead.id, applyTag.id, returnToInbox.id]);
    assert.equal(c.detail, false);
    assert.deepEqual(c.facts().fields, {
      read: true,
      tags: ['Existing tag', 'New tag'],
      rawSha: 'immutable-message-bytes',
    });
  }));

test('Verified tasks infer reusable atoms and compose a fresh task without proposals', async () =>
  directory(async (library) => {
    class BufferedTagHost extends RecordHost {
      private pending?: string;

      override async act(action: Action) {
        if (action.tool === 'browser_type') {
          assert.ok(elementFor(action.target, await this.observe()));
          this.actions.push(action);
          this.pending = action.args!.text as string;
        } else if (action.tool === 'browser_press_key') {
          assert.ok(this.pending, 'Typing must precede the tag commit');
          this.actions.push(action);
          this.records[this.identity].tags.push(this.pending);
          this.pending = undefined;
        } else await super.act(action);
      }
    }
    const store = new ExperienceStore(library.directory);
    const learn = async (host: RecordHost, key: string, goal: FactRule[], actions: Action[]) => {
      const capture = new CapabilityCapture({
        host,
        store,
        task: task(host, key, key),
        library,
        readFacts: async () => host.facts(),
        goal,
      });
      for (const action of actions) await capture.act(action);
      await capture.complete({ text: 'Mailbox' });
      return capture.waitForCapabilities();
    };
    const a = new RecordHost(false, [], 'a', 'Read source');
    const [openAndRead, returnToInbox] = await learn(a, 'A', [read], [open(a.subject), back()]);
    const b = new BufferedTagHost(true, [], 'b', 'Tag source');
    const typeTag = addTag('New tag');
    delete typeTag.args!.submit;
    const commit: Action = {
      kind: 'tool',
      tool: 'browser_press_key',
      args: { key: 'Enter' },
      effect: true,
    };
    const [openAlreadyRead, applyTag, sharedReturn] = await learn(
      b,
      'B',
      [tag],
      [open(b.subject), typeTag, commit, back()],
    );
    assert.equal(openAndRead.steps.length, 1);
    assert.deepEqual(openAlreadyRead.requiresFacts, [read]);
    assert.equal(
      applyTag.steps.length,
      2,
      'An uncommitted input must stay with its observed commit',
    );
    assert.equal(returnToInbox.id, sharedReturn.id);
    assert.equal(sharedReturn.evidence.length, 2);
    assert.equal((await library.candidates(scope, recordKind)).length, 4);
    assert.deepEqual(Object.keys((await library.dependencies()).workflows).sort(), ['A', 'B']);
    const catalog = JSON.parse(
      await readFile(join(library.directory, 'capabilities.json'), 'utf8'),
    );
    assert.equal(catalog.format, 2);
    const storedWorkflows = await Promise.all(
      [openAndRead.evidence[0], applyTag.evidence[0]].map(async ({ experience }) => {
        const path = join(library.directory, 'experiences', experience + '.json');
        return JSON.parse(await readFile(path, 'utf8'));
      }),
    );
    const workflowRefs = new Set(
      storedWorkflows.flatMap((workflow) =>
        workflow.steps.map(({ atom }: { atom: string }) => atom),
      ),
    );
    assert.equal(workflowRefs.size, 4);
    assert.deepEqual(
      await readdir(join(library.directory, 'atoms')),
      [...workflowRefs].map((atom) => atom + '.json').sort(),
    );
    for (const capability of catalog.capabilities) {
      assert.equal(capability.steps, undefined, 'The catalog persists references only');
      assert.ok(capability.atoms.every(({ atom }: { atom: string }) => workflowRefs.has(atom)));
    }

    const c = new BufferedTagHost(false, ['Existing tag'], 'c', 'Unseen subject');
    const result = await library.run({
      task: task(c),
      identity: c.identity,
      recordKind,
      goal: [read, tag],
      host: c,
      readFacts: async () => c.facts(),
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.planSource, 'local');
    assert.deepEqual(result.capabilities, [openAndRead.id, applyTag.id, sharedReturn.id]);
    assert.equal(c.detail, false);
    assert.deepEqual(c.facts().fields, {
      read: true,
      tags: ['Existing tag', 'New tag'],
      rawSha: 'immutable-message-bytes',
    });
  }));

test('Legacy capability programs can be read and an observed equivalent compacts under the same ID', async () =>
  directory(async (library) => {
    const host = new RecordHost();
    const observed = await source(host, [open(host.subject)], 'A', { subject: host.subject });
    const proposals = [findProposal(host.subject)];
    const [created] = await library.learn({ ...observed, proposals });
    const { surface: _surface, ...legacy } = created;
    const path = join(library.directory, 'capabilities.json');
    await writeFile(
      path,
      JSON.stringify({
        format: 1,
        capabilities: [legacy],
        repairs: [],
        workflows: { A: [legacy.id] },
      }),
    );
    const reopened = new CapabilityLibrary(library.directory);
    assert.deepEqual(await reopened.candidates(scope, recordKind), [legacy]);
    const [compact] = await reopened.learn({ ...observed, proposals });
    assert.equal(compact.id, legacy.id);
    assert.equal((await reopened.candidates(scope, recordKind)).length, 1);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.format, 2);
    assert.equal(stored.capabilities[0].steps, undefined);
    const atomPath = join(
      library.directory,
      'atoms',
      stored.capabilities[0].atoms[0].atom + '.json',
    );
    await rm(atomPath);
    await assert.rejects(new CapabilityLibrary(library.directory).candidates(scope, recordKind), {
      code: 'ENOENT',
    });
  }));

test('Automatic admission cannot use an unconfirmed typed goal or an unauthorized field change', async () =>
  directory(async (library) => {
    const store = new ExperienceStore(join(library.directory, 'source'));
    for (const changeOtherRecord of [false, true]) {
      const host = new RecordHost();
      const capture = new CapabilityCapture({
        host,
        store,
        task: task(host, String(changeOtherRecord)),
        library,
        readFacts: async () => {
          if (changeOtherRecord && host.detail) host.records.other.tags.push('Unexpected');
          return host.facts();
        },
        goal: changeOtherRecord ? [read] : [read, tag],
      });
      await capture.act(open(host.subject));
      await capture.act(back());
      const memory = await capture.complete({ text: 'Mailbox' });
      await assert.rejects(
        capture.waitForCapabilities(),
        changeOtherRecord ? /another record/ : /typed goal was not confirmed/,
      );
      assert.equal(capture.learning, 'failed');
      assert.equal((await store.get(memory.id))?.id, memory.id);
      assert.deepEqual(await library.candidates(scope, recordKind), []);
    }
  }));

test('Automatic admission rejects an unconfirmed dispatch and a rejected task', async () =>
  directory(async (library) => {
    const store = new ExperienceStore(library.directory);
    const detour: Action = {
      kind: 'tool',
      tool: 'simulated_off_goal_action',
      effect: false,
    };
    class DetourHost extends RecordHost {
      override async act(action: Action) {
        if (action.tool === detour.tool) throw new Error('Probe dispatched but did not complete');
        return super.act(action);
      }
    }
    const host = new DetourHost();
    const capture = new CapabilityCapture({
      host,
      store,
      task: task(host, 'detour', 'detour'),
      library,
      readFacts: async () => host.facts(),
      goal: [read],
    });
    // Allow a non-writing dispatch failure to be visible in the trace without
    // having to reconcile an uncertain business effect.
    await assert.rejects(capture.act(detour), /did not complete/);
    assert.equal(capture.trace[0].dispatched, true);
    await capture.act(open(host.subject));
    await capture.act(back());
    const memory = await capture.complete({ text: 'Mailbox' });
    await assert.rejects(capture.waitForCapabilities(), /discarded source action/);
    assert.equal((await store.get(memory.id))?.id, memory.id);

    const rejectedHost = new RecordHost();
    const rejected = new CapabilityCapture({
      host: rejectedHost,
      store,
      task: {
        ...task(rejectedHost, 'rejected', 'rejected'),
        verification: 'readback',
        readback: async () => ({ status: 'rejected', source: 'fixture storage' }),
      },
      library,
      readFacts: async () => rejectedHost.facts(),
      goal: [read],
    });
    await rejected.act(open(rejectedHost.subject));
    await rejected.act(back());
    await assert.rejects(rejected.complete({ text: 'Mailbox' }), /did not confirm/);
    await assert.rejects(rejected.waitForCapabilities(), /verified completed/);
    assert.deepEqual(await library.candidates(scope, recordKind), []);
  }));

test('Each source action keeps its own before and after even if UI text updates in between', async () =>
  directory(async (library) => {
    class UpdatingHost extends RecordHost {
      tick = 0;
      override async observe() {
        const state = await super.observe();
        return observation({ ...state, text: state.text + ' ' + ++this.tick });
      }
    }
    for (const changeFacts of [false, true]) {
      const host = new UpdatingHost();
      const capture = new CapabilityCapture({
        host,
        store: new ExperienceStore(join(library.directory, 'source')),
        task: task(host, String(changeFacts)),
        library,
        readFacts: async () => host.facts(),
      });
      await capture.act(open(host.subject));
      if (changeFacts) host.records.other.tags.push('Unexpected');
      await capture.act(back());
      assert.notEqual(
        capture.boundaryAt(0, 'after')?.observation.stateKey,
        capture.boundaryAt(1)?.observation.stateKey,
      );
      assert.equal(
        capture.boundaryAt(0, 'after')?.observation.stateKey,
        capture.trace[0].after?.stateKey,
      );
      await capture.complete({ text: 'Mailbox' });
      const admitted = capture.submitCapabilities([
        { ...findProposal(host.subject), end: 2, ensures: { text: 'Mailbox' } },
      ]);
      if (changeFacts) await assert.rejects(admitted, /another record/);
      else assert.equal((await admitted).length, 1);
    }
  }));

test('Failed original completion never invokes induction', async () =>
  directory(async (library) => {
    const host = new RecordHost();
    let proposals = 0;
    const capture = new CapabilityCapture({
      host,
      store: new ExperienceStore(join(library.directory, 'source')),
      task: task(host),
      library,
      readFacts: async () => host.facts(),
      propose: async () => {
        proposals++;
        return [];
      },
    });
    await capture.act(open(host.subject));
    await assert.rejects(capture.complete({ text: 'Never appeared' }), /Completion condition/);
    await assert.rejects(capture.waitForCapabilities(), /verified completed/);
    assert.equal(proposals, 0);
    assert.equal(capture.learning, 'idle');
    assert.deepEqual(await library.candidates(scope, recordKind), []);
  }));

test('Induction failure remains separate from verified task success and is not automatically retried', async () =>
  directory(async (library) => {
    const host = new RecordHost(),
      store = new ExperienceStore(join(library.directory, 'source'));
    let proposals = 0;
    const capture = new CapabilityCapture({
      host,
      store,
      task: task(host),
      library,
      readFacts: async () => host.facts(),
      propose: async () => {
        proposals++;
        throw new Error('Original model unavailable');
      },
    });
    await capture.act(open(host.subject));
    await capture.act(back());
    const memory = await capture.complete({ text: 'Mailbox' });
    await assert.rejects(capture.waitForCapabilities(), /Original model unavailable/);
    await assert.rejects(capture.waitForCapabilities(), /Original model unavailable/);
    assert.equal(proposals, 1);
    assert.equal(capture.learning, 'failed');
    assert.match(capture.learningError!, /Original model unavailable/);
    assert.equal((await store.get(memory.id))!.id, memory.id);
    assert.equal(host.actions.length, 2);
  }));

test('Capture rejects overlapping native actions', async () =>
  directory(async (library) => {
    const host = new RecordHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = new CapabilityCapture({
      host,
      store: new ExperienceStore(join(library.directory, 'source')),
      task: task(host),
      library,
      readFacts: async () => {
        await gate;
        return host.facts();
      },
      propose: async () => [],
    });
    const first = capture.act(open(host.subject));
    await assert.rejects(capture.act(open(host.subject)), /sequentially/);
    release();
    await first;
    await capture.abort();
    assert.equal(host.actions.length, 1);
  }));

test('A shared control repair survives different source fragment grouping', async () =>
  directory(async (library) => {
    const { a, bSource } = await training(library),
      grouped = await library.learn({
        ...bSource,
        proposals: [
          {
            label: 'Find, tag, and return',
            start: 0,
            end: 3,
            requires: { target: { role: 'link', name: bSource.inputs.subject } },
            ensures: { target: { role: 'link', name: bSource.inputs.subject } },
            effects: [read, { field: 'tags', op: 'contains', value: bSource.inputs.tag }],
          },
        ],
      });
    assert.deepEqual(grouped[0].stepEffects, [[], [tag], []]);
    const first = new RecordHost(false, [], 'grouping-repair', 'Grouping repair subject');
    first.returnName = 'Changed shared return';
    const repaired = await library.run({
      task: task(first),
      identity: first.identity,
      recordKind,
      goal: [read],
      plan: a.map((cap) => cap.id),
      host: first,
      readFacts: async () => first.facts(),
      repair: async ({ action }) => ({
        ...action,
        target: { role: 'button', name: first.returnName },
      }),
    });
    assert.equal(repaired.status, 'completed', repaired.error);
    const next = new RecordHost(true, [], 'grouping-reuse', 'Grouping reuse subject');
    next.returnName = first.returnName;
    const reused = await library.run({
      task: task(next),
      identity: next.identity,
      recordKind,
      goal: [tag],
      plan: [grouped[0].id],
      host: next,
      readFacts: async () => next.facts(),
    });
    assert.equal(reused.status, 'completed', reused.error);
    assert.equal(reused.repairs, 0);
    assert.equal(next.detail, false);
  }));

test('Identical locator behavior with a different observed per-action effect does not inherit a patch', async () =>
  directory(async (library) => {
    const { b } = await training(library),
      readonly = new RecordHost(true);
    readonly.detail = true;
    const action = { ...back(), effect: true },
      unchanged = await source(readonly, [action], 'readonly-return', {
        subject: readonly.subject,
      }),
      normal = await library.learn({
        ...unchanged,
        proposals: [backProposal(readonly.subject, 0)],
      });
    class ReadOnReturn extends RecordHost {
      override async act(action: Action) {
        await super.act(action);
        this.records[this.identity].read = true;
      }
    }
    const changed = new ReadOnReturn(false);
    changed.detail = true;
    const changedSource = await source(changed, [action], 'mutating-return', {
        subject: changed.subject,
      }),
      mutation = await library.learn({
        ...changedSource,
        proposals: [{ ...backProposal(changed.subject, 0), effects: [read] }],
      });
    assert.deepEqual(normal[0].stepEffects, [[]]);
    assert.deepEqual(mutation[0].stepEffects, [[read]]);
    const first = new RecordHost(true, [], 'effect-repair', 'Effect repair subject');
    first.detail = true;
    first.returnName = 'Changed return';
    const repaired = await library.run({
      task: task(first),
      identity: first.identity,
      recordKind,
      goal: [tag],
      plan: [b[1].id, normal[0].id],
      host: first,
      readFacts: async () => first.facts(),
      repair: async ({ action }) => ({
        ...action,
        target: { role: 'button', name: first.returnName },
      }),
    });
    assert.equal(repaired.status, 'completed', repaired.error);
    const next = new RecordHost(false, [], 'effect-reject', 'Effect reject subject');
    next.detail = true;
    next.returnName = first.returnName;
    const rejected = await library.run({
      task: task(next),
      identity: next.identity,
      recordKind,
      goal: [read],
      plan: [mutation[0].id],
      host: next,
      readFacts: async () => next.facts(),
    });
    assert.equal(rejected.status, 'failed', rejected.error);
    assert.equal(next.actions.length, 0);
    assert.match(rejected.error!, /locator changed/);
  }));

test('Embedded check parameters and form-encoded hash routes reuse the existing compiler templates', async () =>
  directory(async (library) => {
    class SearchContextHost extends RecordHost {
      override async observe() {
        const state = await super.observe();
        return observation({
          ...state,
          text: this.detail ? `Detail subject:"${this.subject}"` : state.text,
          url: this.detail
            ? `${state.url}#search=subject%3A${new URLSearchParams({ q: this.subject }).toString().slice(2)}`
            : state.url,
        });
      }
    }
    const host = new SearchContextHost(),
      learnedSource = await source(host, [open(host.subject), back()], 'embedded-checks', {
        subject: host.subject,
      }),
      capabilities = await library.learn({
        ...learnedSource,
        proposals: [
          { ...findProposal(host.subject), ensures: { text: `Detail subject:"${host.subject}"` } },
          {
            ...backProposal(host.subject, 1),
            requires: { text: `Detail subject:"${host.subject}"` },
          },
        ],
      });
    assert.ok(JSON.stringify(capabilities[0].ensures).includes('$template'));
    const next = new SearchContextHost(false, [], 'different-record', 'Second subject'),
      result = await library.run({
        task: task(next),
        identity: next.identity,
        recordKind,
        goal: [read],
        plan: capabilities.map((cap) => cap.id),
        host: next,
        readFacts: async () => next.facts(),
      });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.actions, 2);
  }));

test('Concurrent learning fails fast against the replay lock and later preserves both workflow and repair', async () =>
  directory(async (library) => {
    const { a, bSource } = await training(library),
      host = new RecordHost(false, [], 'locked-record', 'Locked subject');
    host.returnName = 'Changed shared return';
    let release!: () => void,
      entered!: () => void,
      first = true;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      peer = new CapabilityLibrary(library.directory),
      learning = {
        ...bSource,
        proposals: [
          {
            label: 'New grouping',
            start: 0,
            end: 3,
            requires: { target: { role: 'link', name: bSource.inputs.subject } },
            ensures: { target: { role: 'link', name: bSource.inputs.subject } },
            effects: [read, { field: 'tags', op: 'contains' as const, value: bSource.inputs.tag }],
          },
        ],
      };
    const running = library.run({
      task: task(host),
      identity: host.identity,
      recordKind,
      goal: [read],
      plan: a.map((cap) => cap.id),
      host,
      readFacts: async () => {
        if (first) {
          first = false;
          entered();
          await gate;
        }
        return host.facts();
      },
      repair: async ({ action }) => ({
        ...action,
        target: { role: 'button', name: host.returnName },
      }),
    });
    await started;
    try {
      await assert.rejects(peer.learn(learning), /Journal is locked/);
    } finally {
      release();
    }
    const result = await running;
    assert.equal(result.status, 'completed', result.error);
    const admitted = await peer.learn(learning),
      catalog = await peer.candidates(scope, recordKind),
      dependencies = await peer.dependencies();
    assert.ok(catalog.some((cap) => cap.id === admitted[0].id));
    assert.equal(catalog.length, 4);
    assert.deepEqual(
      dependencies.workflows.C,
      a.map((cap) => cap.id),
    );
    assert.equal(dependencies.repairs.length, 1);
  }));
