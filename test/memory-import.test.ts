import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileJournal } from '../src/journal.js';
import { CapabilityLibrary, type Capability } from '../src/memory/capabilities.js';
import { importExperiences } from '../src/memory/import.js';
import { ExperienceStore, StepAtoms } from '../src/memory/store.js';
import type { Experience } from '../src/memory/types.js';

function experience(id: string, scope = 'test') {
  return {
    format: 2,
    id,
    key: id,
    scope,
    surface: 'tool',
    createdAt: '2026-01-01T00:00:00Z',
    requiredInputs: [],
    steps: [{ action: { kind: 'wait' }, sourceIndex: 0, effect: false }],
    goal: { text: 'Complete' },
    episode: 'episode',
    exploratoryActions: 1,
    eliminatedActions: 0,
    capabilities: ['wait'],
  } satisfies Experience;
}

test('Import preserves verified programs and write fences, skips invalid records and keeps destination versions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'reflexrun-memory-import-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const from = new ExperienceStore(source);
  const to = new ExperienceStore(target);
  const legacy = experience('legacy');
  const legacyPath = join(source, 'experiences', 'legacy.json');
  const originalLegacy = JSON.stringify(legacy);
  await mkdir(join(source, 'experiences'), { recursive: true });
  await writeFile(legacyPath, originalLegacy);
  await writeFile(
    join(source, 'experiences', 'invalid.json'),
    JSON.stringify({ ...legacy, id: 'invalid', scope: undefined }),
  );
  await from.save(experience('bad-atom'));
  const malformedAtomRecord = join(source, 'experiences', 'bad-atom.json');
  const badAtom = JSON.parse(await readFile(malformedAtomRecord, 'utf8'));
  badAtom.steps[0].atom = '0'.repeat(64);
  await writeFile(malformedAtomRecord, JSON.stringify(badAtom));
  const current = experience('current');
  await from.save(current);
  await from.save(experience('quarantined'));
  await from.quarantine('quarantined', 'changed target');
  await from.save(experience('conflict', 'source'));
  await to.save(experience('conflict', 'target'));
  const entry = {
    key: 'old-job-key',
    id: 'old-job:0',
    label: 'legacy',
    state: 'attempted' as const,
    revision: 1,
    at: '2026-01-01T00:00:00Z',
  };
  const oldJournalPath = join(source, 'intents.jsonl');
  const oldJournal = JSON.stringify({ ...entry, note: 'old freeform details' }) + '\n';
  await writeFile(oldJournalPath, oldJournal);

  assert.deepEqual(await importExperiences(source, target), {
    imported: 3,
    skipped: 3,
    invalid: 2,
  });
  assert.deepEqual(await to.get('legacy'), legacy);
  assert.deepEqual(await to.get('current'), current);
  assert.equal((await to.get('conflict'))?.scope, 'target');
  assert.equal(await to.get('quarantined'), undefined);
  assert.deepEqual((await to.versions()).find(({ id }) => id === 'quarantined')?.health, {
    id: 'quarantined',
    successes: 0,
    failures: 0,
    quarantined: true,
    reason: 'changed target',
  });
  const targetJournal = await FileJournal.load(join(target, 'intents.jsonl'));
  assert.deepEqual(targetJournal.get(entry.key), entry);
  assert.equal(await readFile(legacyPath, 'utf8'), originalLegacy);
  assert.equal(await readFile(oldJournalPath, 'utf8'), oldJournal);
  await assert.rejects(readFile(join(source, 'catalog', 'index.json')), { code: 'ENOENT' });
  assert.deepEqual(await importExperiences(source, target), {
    imported: 0,
    skipped: 6,
    invalid: 2,
  });
  assert.equal((await FileJournal.load(join(target, 'intents.jsonl'))).entries().length, 1);
  await assert.rejects(importExperiences(source, source), /must differ/);
  await writeFile(join(source, 'intents.jsonl.lock'), '');
  await assert.rejects(importExperiences(source, target), /Source memory is in use/);
});

test('Import merges inline and atom-backed capability catalogs with their dependencies', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'reflexrun-capability-import-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const shared: Capability = {
    id: 'shared',
    label: 'Shared in target',
    scope: 'test',
    surface: 'tool',
    recordKind: 'message',
    steps: experience('shared').steps,
    contexts: ['one'],
    outcomeContext: 'two',
    stepEffects: [[]],
    requires: { text: 'Before' },
    ensures: { text: 'After' },
    effects: [],
    requiresFacts: [],
    inputs: [],
    evidence: [],
  };
  const { steps, ...owner } = { ...shared, id: 'imported', label: 'Imported' };
  const atoms = await new StepAtoms(source).store({ ...owner, surface: 'tool' }, steps);
  const from = {
    format: 2,
    capabilities: [
      { ...shared, label: 'Shared in source' },
      { ...owner, atoms },
    ],
    repairs: [],
    workflows: { shared: ['imported'], other: ['imported'] },
  };
  const to = {
    format: 1,
    capabilities: [shared],
    repairs: [],
    workflows: { shared: ['shared'] },
  };
  const sourceCatalog = join(source, 'capabilities.json');
  await mkdir(target);
  await writeFile(sourceCatalog, JSON.stringify(from));
  await writeFile(join(target, 'capabilities.json'), JSON.stringify(to));
  const library = new CapabilityLibrary(target);

  await importExperiences(source, target);
  await importExperiences(source, target);
  assert.deepEqual(await library.candidates('test', 'message'), [shared, { ...owner, steps }]);
  assert.deepEqual((await library.dependencies()).workflows, {
    shared: ['shared'],
    other: ['imported'],
  });
  assert.equal(await readFile(sourceCatalog, 'utf8'), JSON.stringify(from));
});
