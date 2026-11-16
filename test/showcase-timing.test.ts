import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LiveBrowser, parseSettleMs } from '../scripts/live-runtime.js';
import {
  confirmedReadback,
  summarizeTiming,
  taskAttribution,
  exclusiveTiming,
  summarizeCampaign,
  observedCampaignOutcome,
  parseCampaignReport,
  campaignOrder,
  type CampaignSample,
  type TaskTimeline,
} from '../scripts/showcase-timing.js';

const point = (monotonicMs: number) => ({ at: 'synthetic-clock', monotonicMs });
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve: () => resolve() };
};

test('Host settle configuration preserves zero and rejects invalid values before browser or model startup', async () => {
  assert.equal(parseSettleMs(), 500);
  assert.equal(parseSettleMs('0'), 0);
  assert.equal(parseSettleMs(0), 0);
  for (const value of [-1, 1.5, NaN, Infinity, '', '-1', '1.5', 'invalid'])
    assert.throws(() => parseSettleMs(value), /non-negative integer/);
  await assert.rejects(
    LiveBrowser.open('http://unused.invalid', 'unused', '/unused', { settleMs: -1 }),
    /non-negative integer/,
  );
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  for (const script of ['benchmark-showcase.ts', 'benchmark-campaign.ts']) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        `scripts/${script}`,
        '--app',
        '/unused',
        '--out',
        '/unused',
        '--settle-ms=-1',
      ],
      { cwd, encoding: 'utf8', timeout: 10_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--settle-ms must be a non-negative integer/);
    assert.ok(!result.stderr.includes('model-start'));
  }
});

test('First-task timing stops at confirmed readback while memory and model tail remain pending', async () => {
  const timeline: TaskTimeline = { started: point(100) };
  const verified = deferred(),
    persisted = deferred(),
    stopped = deferred();
  const task = confirmedReadback(
    timeline,
    async () => {
      await verified.promise;
      return { status: 'confirmed', source: 'independent-storage' };
    },
    () => point(150),
  );
  const memory = persisted.promise.then(() => (timeline.memoryReady = point(190)));
  const model = stopped.promise.then(() => (timeline.modelTurnReady = point(500)));
  assert.equal(summarizeTiming(timeline).taskReadyMs, undefined);
  verified.resolve();
  await task;
  assert.deepEqual(summarizeTiming(timeline), {
    taskReadyMs: 50,
    memoryReadyMs: undefined,
    modelTurnReadyMs: undefined,
    modelTailMs: undefined,
  });
  persisted.resolve();
  await memory;
  assert.equal(summarizeTiming(timeline).memoryReadyMs, 90);
  assert.equal(summarizeTiming(timeline).modelTurnReadyMs, undefined);
  stopped.resolve();
  await model;
  assert.deepEqual(summarizeTiming(timeline), {
    taskReadyMs: 50,
    memoryReadyMs: 90,
    modelTurnReadyMs: 400,
    modelTailMs: 350,
  });
});

test('Single-profile campaigns alternate method order; both profiles also alternate profile order', () => {
  assert.deepEqual(campaignOrder(1, 'after'), [{ profile: 'after', order: 'baseline-first' }]);
  assert.deepEqual(campaignOrder(2, 'after'), [{ profile: 'after', order: 'reflex-first' }]);
  assert.deepEqual(campaignOrder(1, 'both'), [
    { profile: 'before', order: 'baseline-first' },
    { profile: 'after', order: 'baseline-first' },
  ]);
  assert.deepEqual(campaignOrder(2, 'both'), [
    { profile: 'after', order: 'reflex-first' },
    { profile: 'before', order: 'reflex-first' },
  ]);
});

test('Exclusive attribution covers wall time once while nested native and readback spans remain separate', () => {
  const result = taskAttribution(
    0,
    100,
    [
      { type: 'model-process-start', monotonicMs: 10 },
      { type: 'turn-request', monotonicMs: 20 },
      { type: 'tool-request', monotonicMs: 40, sequence: 1, tool: 'browser_type' },
      { type: 'tool-result', monotonicMs: 59, sequence: 1 },
      { type: 'tool-response-sent', monotonicMs: 60, sequence: 1 },
      { type: 'tool-request', monotonicMs: 90, sequence: 2, tool: 'task_complete' },
      { type: 'tool-response-sent', monotonicMs: 105, sequence: 2 },
    ],
    [
      { kind: 'preflight', startMs: -10, endMs: 10 },
      { kind: 'native', startMs: 45, endMs: 55 },
      { kind: 'readback', startMs: 90, endMs: 110 },
    ],
  );
  assert.deepEqual(result.buckets, {
    preflight: 10,
    startup: 10,
    toolCallbacks: 30,
    modelAndTransportWait: 50,
    unattributed: 0,
  });
  assert.equal(
    Object.values(result.buckets).reduce((a, b) => a + b, 0),
    100,
  );
  assert.deepEqual(result.nested, { nativeToolMs: 10, independentReadbackMs: 10 });
  assert.equal(result.firstToolRequestMs, 40);
  assert.deepEqual(
    result.waits.map((wait) => wait.elapsedMs),
    [20, 30],
  );
  assert.deepEqual(exclusiveTiming(0, 10, [], ['measured']).buckets, {
    measured: 0,
    unattributed: 10,
  });
});

test('Campaign summaries retain failures and compare only genuinely paired observed metrics', () => {
  const sample = (
    round: number,
    profile: 'before' | 'after',
    baseline: number,
    reflex: number,
  ): CampaignSample => ({
    round,
    profile,
    order: ['baseline', 'reflex'],
    completed: true,
    exitCode: 0,
    outcomes: { baseline: { confirmed: 7, total: 7 }, reflex: { confirmed: 7, total: 7 } },
    metrics: { baseline: { taskReadyMs: baseline }, reflex: { taskReadyMs: reflex } },
  });
  const failed: CampaignSample = {
    round: 2,
    profile: 'before',
    order: ['reflex', 'baseline'],
    completed: false,
    exitCode: 1,
    failure: 'benchmark-failed',
    outcomes: { reflex: { confirmed: 1, total: 7 } },
    metrics: {},
  };
  const result = summarizeCampaign([sample(1, 'before', 10, 12), sample(1, 'after', 8, 9), failed]);
  assert.equal(result.attemptedPairs, 3);
  assert.equal(result.failedPairs, 1);
  const before = result.profiles.before;
  assert.equal(before.attemptedPairs, 2);
  assert.equal(before.completedPairs, 1);
  assert.deepEqual(before.pairedReflexMinusBaselineMs.taskReadyMs, {
    n: 1,
    median: 2,
    min: 2,
    max: 2,
    p25: 2,
    p75: 2,
  });
  const changes = result.pairedAfterMinusBeforeMs;
  assert.equal(changes.baseline.taskReadyMs.median, -2);
  assert.equal(changes.reflex.taskReadyMs.median, -3);
  assert.equal(changes.reflex.taskReadyMs.n, 1);
});

test('Campaign confirmations require independent readback and deduplicate observed identities', () => {
  assert.equal(observedCampaignOutcome(undefined), undefined);
  assert.deepEqual(
    observedCampaignOutcome({ finalRecords: Array.from({ length: 7 }, (_, id) => ({ id })) }),
    { total: 7, observed: false },
  );
  assert.deepEqual(
    observedCampaignOutcome({
      observedReadbacks: [
        { title: 'One', status: 'confirmed' },
        { title: 'One', status: 'confirmed' },
        { title: 'Two', status: 'rejected' },
        { title: 'Three', status: 'unknown' },
      ],
    }),
    { confirmed: 1, total: 7, observed: true },
  );
  assert.deepEqual(
    observedCampaignOutcome({
      rows: [
        { title: 'One', outcome: { status: 'confirmed', source: 'independent-storage' } },
        { title: 'One', outcome: { status: 'confirmed', source: 'independent-storage' } },
        {
          id: 'item-2',
          result: {
            outcome: 'confirmed',
            evidence: 'readback',
            readbackSource: 'independent-storage',
          },
        },
        { title: 'Unverified', status: 'confirmed' },
        { id: 'Toast', result: { status: 'completed', evidence: 'ui-postcondition' } },
      ],
    }),
    { confirmed: 2, total: 7, observed: true },
  );
});

test('Truncated or damaged campaign captures become failed samples without blocking later captures', () => {
  for (const text of ['{"completed":', '', 'null', '[]', '"report"'])
    assert.deepEqual(parseCampaignReport(text), { report: {}, failure: 'unreadable-report' });
  assert.deepEqual(parseCampaignReport(undefined), { report: {}, failure: 'no-complete-report' });
  assert.deepEqual(parseCampaignReport('{"completed":true}'), { report: { completed: true } });
});

test('Rejected or unknown readback cannot publish task-ready; a later check cannot move it', async () => {
  const timeline: TaskTimeline = { started: point(100) };
  for (const status of ['rejected', 'unknown'] as const)
    await confirmedReadback(
      timeline,
      async () => ({ status, source: 'independent-storage' }),
      () => point(200),
    );
  assert.equal(timeline.taskReady, undefined);
  await assert.rejects(
    confirmedReadback(timeline, async () => {
      throw new Error('reader unavailable');
    }),
    /reader unavailable/,
  );
  assert.equal(timeline.taskReady, undefined);
  await confirmedReadback(
    timeline,
    async () => ({ status: 'confirmed', source: 'independent-storage' }),
    () => point(220),
  );
  await confirmedReadback(
    timeline,
    async () => ({ status: 'confirmed', source: 'independent-storage' }),
    () => point(900),
  );
  assert.equal(summarizeTiming(timeline).taskReadyMs, 120);
});
