import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileJournal, MemoryJournal } from '../src/journal.js';
import { compilePolicy, parseFact, validatePolicy } from '../src/policy.js';
import type { Candidate, Entry, Policy } from '../src/types.js';

test('Compiled preferences distinguish allowed, denied and unknown live facts', () => {
  const decide = compilePolicy({
    revision: 7,
    rules: [
      { field: 'distance', op: 'lte', value: 10 },
      { field: 'age', op: 'gte', value: 18 },
      { field: 'category', op: 'in', value: ['Sports', 'Wellness', 'Beads'] },
      { field: 'category', op: 'not-in', value: ['Beads'] },
      { field: 'price', op: 'eq', value: 0 },
      { field: 'eligible', op: 'eq', value: true },
    ],
  });
  const facts = { distance: 3, age: 24, category: 'Sports', price: 0, eligible: true };
  const item = (changes: Candidate['facts'] = {}): Candidate => ({
    id: 'activity',
    label: 'Activity',
    facts: { ...facts, ...changes },
  });
  assert.deepEqual(decide(item()), { decision: 'allow', reason: 'Policy v7' });
  const denied: Candidate['facts'][] = [
    { distance: 12 },
    { age: 12 },
    { category: 'Other' },
    { category: 'Beads' },
    { price: 49 },
    { eligible: false },
  ];
  for (const changes of denied) assert.equal(decide(item(changes)).decision, 'deny');
  assert.equal(decide(item({ distance: null })).decision, 'unknown');
  assert.equal(decide(item({ distance: 'nearby' })).decision, 'unknown');
  assert.equal(decide(item({ distance: null, price: 49 })).decision, 'deny');
});

test('Invalid policy revisions, operators, membership and bounds fail before compilation', () => {
  const invalid = [
    { revision: 0, rules: [] },
    { revision: 1.5, rules: [] },
    { revision: 1, rules: null },
    { revision: 1, rules: [{ field: '', op: 'eq', value: 0 }] },
    { revision: 1, rules: [{ field: 'price', op: 'less', value: 0 }] },
    { revision: 1, rules: [{ field: 'category', op: 'in', value: 'Sports' }] },
    { revision: 1, rules: [{ field: 'category', op: 'not-in', value: 'Beads' }] },
    { revision: 1, rules: [{ field: 'distance', op: 'lte', value: '10' }] },
    { revision: 1, rules: [{ field: 'age', op: 'gte', value: Infinity }] },
  ];
  for (const policy of invalid) assert.throws(() => compilePolicy(policy as unknown as Policy));
  assert.doesNotThrow(() => validatePolicy({ revision: 1, rules: [] }));
});

test('Fact parsing respects units and rejects malformed or missing values', () => {
  assert.equal(parseFact('  activity  '), 'activity');
  assert.equal(parseFact(null), null);
  assert.equal(parseFact('  '), null);
  assert.equal(parseFact('-1.5', 'number'), -1.5);
  assert.equal(parseFact('1.5 items', 'number'), null);
  assert.equal(parseFact('950 m', 'distance'), 0.95);
  assert.equal(parseFact('10.0 \u516c\u91cc', 'distance'), 10);
  assert.equal(parseFact('950 \u7c73', 'distance'), 0.95);
  assert.equal(parseFact('10 minutes', 'distance'), null);
  assert.equal(parseFact('¥ 0', 'money'), 0);
  assert.equal(parseFact('free?', 'money'), null);
});

test('Durable journals reload under a writer lock and retain intent across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-journal-'));
  try {
    const path = join(directory, 'journal.jsonl');
    const stale = await FileJournal.load(path);
    const entry: Entry = {
      key: 'intent',
      id: 'activity',
      label: 'Activity',
      state: 'reserved',
      revision: 1,
      at: new Date().toISOString(),
    };
    const other = { ...entry, key: 'other-intent', id: 'other-activity' };
    const { journal: first, release } = await FileJournal.openLocked(path);
    await assert.rejects(stale.acquire(), /locked/);
    await assert.rejects(FileJournal.openLocked(path), /locked/);
    await first.put(entry);
    await first.put(other);
    await first.putMany([
      { ...entry, state: 'confirmed' },
      { ...other, state: 'confirmed' },
    ]);
    await release();
    const releaseStale = await stale.acquire();
    assert.equal(stale.get(entry.key)?.state, 'confirmed');
    assert.equal(stale.get(other.key)?.state, 'confirmed');
    await releaseStale();
    assert.deepEqual((await FileJournal.load(path)).entries(), stale.entries());
    const log = await readFile(path, 'utf8');
    assert.match(log, /reserved/);
    assert.match(log, /confirmed/);
    await writeFile(path, log + '{truncated');
    await assert.rejects(FileJournal.load(path), /damaged/);
    await assert.rejects(stale.acquire(), /damaged/);
    await assert.rejects(FileJournal.openLocked(path), /damaged/);
    await writeFile(path, log);
    const { journal: repaired, release: releaseRepaired } = await FileJournal.openLocked(path);
    assert.deepEqual(repaired.entries(), stale.entries());
    await releaseRepaired();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('An in-memory journal excludes concurrent writers and releases its lock', async () => {
  const journal = new MemoryJournal();
  const release = await journal.acquire();
  await assert.rejects(journal.acquire(), /active writer/);
  await release();
  const next = await journal.acquire();
  await next();
});
