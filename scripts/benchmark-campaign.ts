import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSettleMs } from './live-runtime.js';
import {
  observedCampaignOutcome,
  parseCampaignReport,
  summarizeCampaign,
  campaignOrder,
  type CampaignSample,
} from './showcase-timing.js';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    out: { type: 'string' },
    rounds: { type: 'string', default: '5' },
    video: { type: 'boolean' },
    profile: { type: 'string', default: 'both' },
    'initial-context': { type: 'string', default: 'requested' },
    'settle-ms': { type: 'string', default: '500' },
  },
});
if (!values.app || !values.out) throw new Error('--app and a new --out directory are required');
if (!['before', 'after', 'both'].includes(values.profile!))
  throw new Error('--profile must be before, after or both');
if (!['requested', 'supplied'].includes(values['initial-context']!))
  throw new Error('--initial-context must be requested or supplied');
const hostSettleMs = parseSettleMs(values['settle-ms']!);
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 2)
  throw new Error('--rounds must be an integer of at least 2');
const directory = resolve(values.out);
try {
  await access(directory);
  throw new Error('--out already exists; preserve prior evidence');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await mkdir(directory, { recursive: true });
const initialFeatures =
  values['initial-context'] === 'supplied'
    ? [
        'both methods receive fresh live initial context, within the clock',
        'reuse native response snapshots',
      ]
    : ['model requests its initial observation'];
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  completedAt: undefined as string | undefined,
  completed: false,
  protocol: {
    roundsRequested: rounds,
    verification: 'per-item-independent-storage-readback',
    order: 'counterbalanced',
    recording: !!values.video,
    modelConfiguration: 'not-observed',
    selectedProfile: values.profile,
    initialContext: values['initial-context'],
    hostSettleMs,
    profiles: {
      before: [
        'original one-title instruction',
        ...initialFeatures,
        'broad repair schema',
        'wait for repair model turn completion',
      ],
      after: [
        'original one-title instruction',
        ...initialFeatures,
        'repair schema limited to original failed tool and unchanged non-target payload',
        'stop model at accepted bounded patch',
      ],
    },
    limits:
      'Sequential counterbalanced runs on one app; distributions and paired differences, not a cross-site or statistical-significance claim. Failed samples are retained and never treated as zero latency.',
  },
  samples: [] as CampaignSample[],
  summary: summarizeCampaign([]),
};
const save = () =>
  writeFile(join(directory, 'campaign.json'), JSON.stringify(report, null, 2) + '\n');
await save();
for (let round = 1; round <= rounds; round++) {
  for (const { profile, order } of campaignOrder(
    round,
    values.profile as 'before' | 'after' | 'both',
  )) {
    const output = join(directory, `round-${round}-${profile}.json`);
    const args = [
      '--import',
      'tsx',
      'scripts/benchmark-showcase.ts',
      '--app',
      resolve(values.app),
      '--out',
      output,
      '--evidence',
      join(directory, 'captures'),
      '--profile',
      profile,
      '--order',
      order,
      '--initial-context',
      values['initial-context']!,
      '--settle-ms',
      String(hostSettleMs),
      ...(values.video ? [] : ['--no-video']),
    ];
    process.stderr.write(`Campaign round ${round}/${rounds}: ${profile}, ${order}\n`);
    const exitCode = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code) => done(code));
    });
    let reportText: string | undefined, readFailure: string | undefined;
    try {
      reportText = await readFile(output, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') readFailure = 'unreadable-report';
    }
    const decoded = parseCampaignReport(reportText),
      raw = decoded.report;
    const failure = readFailure ?? decoded.failure;
    const completed = !failure && exitCode === 0 && raw.completed === true;
    const sample: CampaignSample = {
      round,
      profile,
      order:
        raw.fairness?.order ??
        (order === 'baseline-first' ? ['baseline', 'reflex'] : ['reflex', 'baseline']),
      completed,
      exitCode,
      outcomes: {},
      metrics: {},
      ...(completed
        ? {}
        : { failure: failure ?? (raw.error ? 'benchmark-failed' : 'no-complete-report') }),
    };
    const models: string[] = (raw.modelRuns ?? []).map((run: any) =>
      JSON.stringify([run.model, run.reasoningEffort]),
    );
    if (models.length) {
      sample.observedModels = [...new Set(models)].map((model) => {
        const [name, reasoningEffort] = JSON.parse(model);
        return { name, reasoningEffort };
      });
      if (sample.observedModels.length === 1) sample.model = sample.observedModels[0];
      else {
        sample.completed = false;
        sample.failure = 'model-config-mismatch';
      }
      sample.host = { codex: raw.codex, playwrightMcp: raw.playwrightMcp };
    }
    for (const method of ['baseline', 'reflex']) {
      const result = raw.results?.[method],
        phases = result?.phases ?? [];
      if (!result) continue;
      const phase = (name: string) => phases.find((p: any) => p.phase === name);
      const cold = phase('cold'),
        warm = phase('normal'),
        changed = phase('changed');
      sample.outcomes[method] = observedCampaignOutcome(result)!;
      sample.metrics[method] = {
        taskReadyMs: cold?.taskReadyMs,
        warmMs: warm?.elapsedMs,
        changedMs: changed?.elapsedMs,
        afterLearningMs: warm && changed ? warm.elapsedMs + changed.elapsedMs : undefined,
        attribution: cold?.attribution,
        ...Object.fromEntries(
          ['memoryReadyMs', 'modelTurnReadyMs', 'modelTailMs', 'localTimings']
            .filter((key) => cold?.[key] !== undefined)
            .map((key) => [key, cold[key]]),
        ),
      };
    }
    if (raw.results?.reflex?.repair) {
      const repair = raw.results.reflex.repair;
      sample.repair = Object.fromEntries(
        [
          'profile',
          'patchReadyMs',
          'elapsedMs',
          'modelStatus',
          'modelTimings',
          'attribution',
          'toolSchemaBytes',
          'offeredToolCount',
        ]
          .filter((key) => repair[key] !== undefined)
          .map((key) => [key, repair[key]]),
      );
    }
    report.samples.push(sample);
    report.summary = summarizeCampaign(report.samples);
    await save();
  }
}
const models = new Set(
  report.samples.flatMap((s) => (s.observedModels ?? []).map((model) => JSON.stringify(model))),
);
report.protocol.modelConfiguration =
  models.size === 1 ? 'consistent' : models.size ? 'mismatch' : 'not-observed';
report.completedAt = new Date().toISOString();
report.completed =
  report.summary.failedPairs === 0 && report.protocol.modelConfiguration === 'consistent';
await save();
process.stderr.write(
  `Campaign complete: ${report.summary.completedPairs}/${report.summary.attemptedPairs} complete pairs. ${join(directory, 'campaign.json')}\n`,
);
if (!report.completed) process.exitCode = 1;
