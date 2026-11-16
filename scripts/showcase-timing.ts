import type { Readback } from '../src/memory/types.js';

export type Stamp = { at: string; monotonicMs: number };
export type TaskTimeline = {
  started: Stamp;
  taskReady?: Stamp;
  memoryReady?: Stamp;
  modelTurnReady?: Stamp;
};

export const stamp = (): Stamp => ({
  at: new Date().toISOString(),
  monotonicMs: performance.now(),
});

/** Both methods stop the task clock at the same independent readback boundary. */
export async function confirmedReadback(
  timeline: TaskTimeline,
  readback: () => Promise<Readback>,
  now = stamp,
) {
  const outcome = await readback();
  if (outcome.status === 'confirmed') timeline.taskReady ??= now();
  return outcome;
}

export function summarizeTiming(timeline: TaskTimeline) {
  const elapsed = (ready: Stamp | undefined) =>
    ready ? ready.monotonicMs - timeline.started.monotonicMs : undefined;
  return {
    taskReadyMs: elapsed(timeline.taskReady),
    memoryReadyMs: elapsed(timeline.memoryReady),
    modelTurnReadyMs: elapsed(timeline.modelTurnReady),
    modelTailMs:
      timeline.taskReady && timeline.modelTurnReady
        ? timeline.modelTurnReady.monotonicMs - timeline.taskReady.monotonicMs
        : undefined,
  };
}

/** The queue is revealed by completion responses, not by a different cold-start prompt. */
export const firstTaskPrompt = (title: string, initialSnapshot?: string) =>
  `You are on a TodoMVC page already open in the browser. Create exactly one task whose title is ${JSON.stringify(title)}. Discover the controls from the live interface. Leave existing records unchanged. When it is visibly created, call task_complete with an observed literal UI completion condition. The completion tool independently verifies the current task. If its response supplies a nextTitle, create that exact next task and call task_complete again; otherwise stop. Continue efficiently using your existing browser context and the supplied tools.${initialSnapshot ? `\nThe initial live snapshot is supplied below. Native tool responses also contain current snapshots; use those when sufficient instead of requesting the same observation again.\n${initialSnapshot}` : ''}`;

export type TimingSpan = { kind: string; startMs: number; endMs: number; name?: string };
export type TimingEvent = {
  type: string;
  monotonicMs: number;
  sequence?: number;
  tool?: string;
};

/** Each wall-clock interval belongs to exactly one bucket, in the supplied priority order. */
export function exclusiveTiming(
  startMs: number,
  endMs: number,
  spans: TimingSpan[],
  priorities: readonly string[],
) {
  if (endMs < startMs) throw new Error('Timing interval ended before it started');
  const clipped = spans.flatMap((span) => {
    const start = Math.max(startMs, span.startMs),
      end = Math.min(endMs, span.endMs);
    return end > start ? [{ ...span, startMs: start, endMs: end }] : [];
  });
  const points = [
    ...new Set([startMs, endMs, ...clipped.flatMap((s) => [s.startMs, s.endMs])]),
  ].sort((a, b) => a - b);
  const buckets: Record<string, number> = Object.fromEntries(
    [...priorities, 'unattributed'].map((key) => [key, 0]),
  );
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const key =
      priorities.find((kind) =>
        clipped.some((s) => s.kind === kind && s.startMs <= a && s.endMs >= b),
      ) ?? 'unattributed';
    buckets[key] += b - a;
  }
  return { elapsedMs: endMs - startMs, buckets };
}

export function taskAttribution(
  startMs: number,
  endMs: number,
  events: TimingEvent[],
  spans: TimingSpan[],
) {
  const process = events.find((e) => e.type === 'model-process-start');
  const turn = events.find((e) => e.type === 'turn-request');
  const requests = new Map<number, TimingEvent>();
  const callbacks: TimingSpan[] = [];
  const requestsInOrder = events.filter((e) => e.type === 'tool-request');
  for (const event of events) {
    if (event.sequence === undefined) continue;
    if (event.type === 'tool-request') requests.set(event.sequence, event);
    if (
      event.type === 'tool-response-sent' ||
      ((event.type === 'tool-result' || event.type === 'tool-error') &&
        !events.some((e) => e.type === 'tool-response-sent' && e.sequence === event.sequence))
    ) {
      const request = requests.get(event.sequence);
      if (request)
        callbacks.push({
          kind: 'toolCallbacks',
          name: request.tool,
          startMs: request.monotonicMs,
          endMs: event.monotonicMs,
        });
    }
  }
  // A confirmed readback can end the first-task clock while its callback is still running.
  for (const event of requests.values())
    if (!callbacks.some((span) => span.startMs === event.monotonicMs))
      callbacks.push({
        kind: 'toolCallbacks',
        name: event.tool,
        startMs: event.monotonicMs,
        endMs,
      });
  const measured = [
    ...spans.filter((s) => s.kind === 'preflight'),
    ...(process && turn
      ? [{ kind: 'startup', startMs: process.monotonicMs, endMs: turn.monotonicMs }]
      : []),
    ...callbacks,
    ...(turn ? [{ kind: 'modelAndTransportWait', startMs: turn.monotonicMs, endMs }] : []),
  ];
  const exclusive = exclusiveTiming(startMs, endMs, measured, [
    'preflight',
    'startup',
    'toolCallbacks',
    'modelAndTransportWait',
  ]);
  const native = exclusiveTiming(startMs, endMs, spans, ['native']).buckets.native;
  const readback = exclusiveTiming(startMs, endMs, spans, ['readback']).buckets.readback;
  const waits = requestsInOrder.flatMap((request, index) => {
    if (request.monotonicMs > endMs) return [];
    const previous = index
      ? (events.find(
          (e) =>
            e.sequence === requestsInOrder[index - 1].sequence && e.type === 'tool-response-sent',
        ) ??
        events.find(
          (e) =>
            e.sequence === requestsInOrder[index - 1].sequence &&
            (e.type === 'tool-result' || e.type === 'tool-error'),
        ))
      : turn;
    return previous
      ? [
          {
            beforeTool: request.tool,
            afterTool: index ? requestsInOrder[index - 1].tool : undefined,
            elapsedMs: Math.max(0, request.monotonicMs - previous.monotonicMs),
          },
        ]
      : [];
  });
  return {
    ...exclusive,
    nested: { nativeToolMs: native, independentReadbackMs: readback },
    firstToolRequestMs: requestsInOrder[0] ? requestsInOrder[0].monotonicMs - startMs : undefined,
    waits,
  };
}

export const campaignMetrics = ['taskReadyMs', 'warmMs', 'changedMs', 'afterLearningMs'] as const;
type Metric = (typeof campaignMetrics)[number];
export type CampaignSample = {
  round: number;
  profile: 'before' | 'after';
  order: string[];
  completed: boolean;
  exitCode: number | null;
  failure?: string;
  model?: { name: string; reasoningEffort?: string };
  observedModels?: { name: string; reasoningEffort?: string }[];
  host?: { codex: string; playwrightMcp: string };
  outcomes: Record<string, { confirmed?: number; total: number; observed?: boolean }>;
  metrics: Record<
    string,
    Partial<Record<Metric | 'memoryReadyMs' | 'modelTurnReadyMs' | 'modelTailMs', number>> & {
      attribution?: unknown;
      localTimings?: unknown;
    }
  >;
  repair?: Record<string, unknown>;
};

export function campaignOrder(round: number, profile: 'before' | 'after' | 'both') {
  const profiles =
    profile === 'both'
      ? round % 2
        ? (['before', 'after'] as const)
        : (['after', 'before'] as const)
      : [profile];
  return profiles.map((profile) => ({
    profile,
    order: round % 2 ? 'baseline-first' : 'reflex-first',
  }));
}

/** Business records are never substituted for an independent confirmation. */
export function observedCampaignOutcome(result: Record<string, any> | undefined) {
  if (!result) return undefined;
  const reads: { status: string; identity: string }[] = [];
  for (const read of Array.isArray(result.observedReadbacks) ? result.observedReadbacks : [])
    if (
      ['confirmed', 'rejected', 'unknown'].includes(read?.status) &&
      typeof read.title === 'string'
    )
      reads.push({ status: read.status, identity: read.title });
  if (!reads.length) {
    for (const row of Array.isArray(result.rows) ? result.rows : []) {
      const outcome =
        row.outcome ??
        (row.result?.evidence === 'readback'
          ? { status: row.result.outcome, source: row.result.readbackSource }
          : undefined);
      const identity = row.title ?? row.id;
      if (
        outcome &&
        typeof outcome.source === 'string' &&
        outcome.source.trim() &&
        ['confirmed', 'rejected', 'unknown'].includes(outcome.status) &&
        typeof identity === 'string'
      )
        reads.push({ status: outcome.status, identity });
    }
  }
  return reads.length
    ? {
        confirmed: new Set(
          reads.filter((read) => read.status === 'confirmed').map((read) => read.identity),
        ).size,
        total: 7,
        observed: true,
      }
    : { total: 7, observed: false };
}

/** A damaged capture is a retained failed sample, so the campaign can continue. */
export function parseCampaignReport(text: string | undefined): {
  report: Record<string, any>;
  failure?: string;
} {
  if (text === undefined) return { report: {}, failure: 'no-complete-report' };
  try {
    const report = JSON.parse(text);
    if (!report || typeof report !== 'object' || Array.isArray(report))
      throw new Error('Not a report');
    return { report };
  } catch {
    return { report: {}, failure: 'unreadable-report' };
  }
}

export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const percentile = (q: number) => {
    const at = (sorted.length - 1) * q,
      lower = Math.floor(at),
      upper = Math.ceil(at);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
  };
  return {
    n: sorted.length,
    median: percentile(0.5),
    min: sorted[0],
    max: sorted.at(-1)!,
    p25: percentile(0.25),
    p75: percentile(0.75),
  };
}

/** Failed samples remain in the campaign; paired deltas require both observed outcomes. */
export function summarizeCampaign(samples: CampaignSample[]) {
  const successful = samples.filter((s) => s.completed);
  const metricSummary = (rows: CampaignSample[], method: string) =>
    Object.fromEntries(
      campaignMetrics.map((metric) => [
        metric,
        distribution(
          rows.flatMap((s) =>
            typeof s.metrics[method]?.[metric] === 'number' ? [s.metrics[method][metric]!] : [],
          ),
        ),
      ]),
    );
  return {
    attemptedPairs: samples.length,
    completedPairs: successful.length,
    failedPairs: samples.length - successful.length,
    profiles: Object.fromEntries(
      ['before', 'after'].map((profile) => {
        const rows = successful.filter((s) => s.profile === profile);
        return [
          profile,
          {
            attemptedPairs: samples.filter((s) => s.profile === profile).length,
            completedPairs: rows.length,
            baseline: metricSummary(rows, 'baseline'),
            reflex: metricSummary(rows, 'reflex'),
            pairedReflexMinusBaselineMs: Object.fromEntries(
              campaignMetrics.map((metric) => [
                metric,
                distribution(
                  rows.flatMap((s) => {
                    const baseline = s.metrics.baseline?.[metric],
                      reflex = s.metrics.reflex?.[metric];
                    return typeof baseline === 'number' && typeof reflex === 'number'
                      ? [reflex - baseline]
                      : [];
                  }),
                ),
              ]),
            ),
          },
        ];
      }),
    ),
    pairedAfterMinusBeforeMs: Object.fromEntries(
      ['baseline', 'reflex'].map((method) => [
        method,
        Object.fromEntries(
          campaignMetrics.map((metric) => [
            metric,
            distribution(
              successful
                .filter((s) => s.profile === 'after')
                .flatMap((after) => {
                  const before = successful.find(
                    (s) => s.round === after.round && s.profile === 'before',
                  );
                  const a = after.metrics[method]?.[metric],
                    b = before?.metrics[method]?.[metric];
                  return typeof a === 'number' && typeof b === 'number' ? [a - b] : [];
                }),
            ),
          ]),
        ),
      ]),
    ),
  };
}
