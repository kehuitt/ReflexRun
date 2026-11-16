import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { compilePolicy } from '../policy.js';
import { FileJournal } from '../journal.js';
import type { Candidate, Fact, Policy, Verdict } from '../types.js';
import { Reflex } from './session.js';
import type {
  FactPlan,
  Inputs,
  Json,
  MemoryResult,
  Readback,
  Task,
  Verification,
} from './types.js';
import { decode } from './compiler.js';
import { extractFacts } from './facts.js';

export type BatchItem = Candidate & { inputs: Inputs };
export type BatchRow = {
  id: string;
  status: 'attempted' | 'confirmed' | 'rejected' | 'unknown' | 'failed' | 'skipped';
  revision: number;
  reason?: string;
  experience?: string;
  evidence?: MemoryResult['evidence'];
};
export type BatchState = {
  id: string;
  operation: string;
  revision: number;
  rows: BatchRow[];
  coverage: 'observed-end' | 'bounded' | 'canceled';
  audits: number;
  policy?: Policy;
  auditSource?: string;
  verification?: Verification;
  readbacks?: number;
  candidates?: { id: string; status: string }[];
};
export type BatchOptions = {
  id: string;
  operation: string;
  policy: () => Policy;
  /** The original agent or generic host discovers items; this is not a site-specific selector map. */
  items: BatchItem[] | (() => Promise<BatchItem[]>);
  allowedScopes?: string[];
  maxItems?: number;
  maxPasses?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  verification?: Verification;
  fixedFacts?: Record<string, Fact>;
  factPlan?: FactPlan;
  readback?: (item: BatchItem) => Promise<Readback>;
  beforeEffect?: (
    item: BatchItem,
    ...effect: Parameters<NonNullable<Task['beforeEffect']>>
  ) => boolean | Promise<boolean>;
  audit?: (ids: string[]) => Promise<Map<string, 'confirmed' | 'rejected'>>;
  onItem?: (row: BatchRow, result?: MemoryResult) => void;
};

/** One authorization envelope and one final audit, with a durable, independently resumable queue. */
export async function runMemoryBatch(reflex: Reflex, options: BatchOptions): Promise<BatchState> {
  const { store } = reflex.options;
  const id = createHash('sha256').update(options.id).digest('hex');
  const { release } = await FileJournal.openLocked(join(store.directory, `batch-${id}.journal`));
  try {
    const saved = await store.batch<BatchState>(id);
    if (saved && saved.operation !== options.operation)
      throw new Error('A batch ID cannot be reused for a different operation');
    const rows = new Map((saved?.rows ?? []).map((r) => [r.id, r]));
    let coverage: BatchState['coverage'] = 'bounded',
      audits = saved?.audits ?? 0;
    let count = 0,
      revision = saved?.revision ?? 0,
      serialized = saved?.policy ? JSON.stringify(saved.policy) : '';
    let currentPolicy = saved?.policy;
    const verification = options.verification ?? 'batch';
    if (saved?.verification && saved.verification !== verification)
      throw new Error('A resumed batch must retain its verification level');
    if (verification === 'readback' && !options.readback)
      throw new Error('Readback verification requires an independent host reader');
    let readbacks = saved?.readbacks ?? 0;
    let decide: (candidate: Candidate) => Verdict = () => ({
      decision: 'unknown',
      reason: 'Policy is not compiled',
    });
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    const policy = () => {
      const p = options.policy();
      const text = JSON.stringify(p);
      if (p.revision < revision || (p.revision === revision && serialized && serialized !== text))
        throw new Error('Batch policy updates need a strictly newer revision');
      if (!currentPolicy || serialized !== text || revision !== p.revision)
        decide = compilePolicy(p);
      else if (!revision || currentPolicy === saved?.policy) decide = compilePolicy(p);
      revision = p.revision;
      serialized = text;
      currentPolicy = p;
      return p;
    };
    const snapshot = async (): Promise<BatchState> => ({
      id: options.id,
      operation: options.operation,
      revision,
      rows: [...rows.values()],
      coverage,
      audits,
      policy: currentPolicy,
      verification,
      readbacks,
      candidates: (await store.provisional(options.id)).map((p) => ({
        id: p.memory.id,
        status: p.status,
      })),
    });
    const persist = async () => {
      await store.saveBatch(id, await snapshot());
    };
    const alive = () =>
      !options.signal?.aborted && Date.now() < deadline && count < (options.maxItems ?? 500);
    policy();
    for (let pass = 0; pass < (options.maxPasses ?? 20) && alive(); pass++) {
      const items = typeof options.items === 'function' ? await options.items() : options.items;
      let progress = false;
      for (const item of items) {
        if (!alive()) break;
        const current = policy();
        const prior = rows.get(item.id);
        if (prior && (prior.status !== 'skipped' || prior.revision === current.revision)) continue;
        progress = true;
        const verdict = decide({ ...item, facts: options.fixedFacts ?? {} });
        if (verdict.decision === 'deny') {
          const row: BatchRow = {
            id: item.id,
            status: 'skipped',
            revision,
            reason: verdict.reason,
          };
          rows.set(item.id, row);
          options.onItem?.(row);
          await persist();
          continue;
        }
        count++;
        // Queue reservation survives an agent/process crash; an interrupted item is not
        // blindly re-executed even if its effect journal was not reached yet.
        rows.set(item.id, {
          id: item.id,
          status: 'unknown',
          revision,
          reason: 'In progress; reconcile after interruption',
        });
        await persist();
        let fenceReason: string | undefined;
        const task: Task = {
          key: options.operation,
          inputs: item.inputs,
          job: `${options.id}:${item.id}`,
          batch: options.id,
          verification,
          allowedScopes: options.allowedScopes,
          signal: options.signal,
          ...(options.factPlan
            ? { factPlan: decode(options.factPlan as unknown as Json, item.inputs) as FactPlan }
            : {}),
          ...(options.readback
            ? {
                readback: async () => {
                  readbacks++;
                  return options.readback!(item);
                },
              }
            : {}),
          context: { selection: current.rules, facts: item.facts } as unknown as Task['context'],
          beforeEffect: async (action, observation, plan) => {
            if (options.signal?.aborted || Date.now() >= deadline) return false;
            const p = policy();
            const needed = new Set(
              p.rules
                .map((r) => r.field)
                .filter((k) => !Object.hasOwn(options.fixedFacts ?? {}, k)),
            );
            const relevant = plan
              ? {
                  ...plan,
                  fields: Object.fromEntries(
                    Object.entries(plan.fields).filter(([k]) => needed.has(k)),
                  ),
                }
              : undefined;
            try {
              const fresh = relevant
                ? await extractFacts(relevant, observation, reflex.options.host)
                : undefined;
              if (fresh && !fresh.identityMatches) {
                fenceReason = 'Fresh item identity does not match the queued item';
                return false;
              }
              const verdict = decide({
                ...item,
                facts: { ...options.fixedFacts, ...fresh?.facts },
              });
              if (verdict.decision !== 'allow') fenceReason = `Live facts: ${verdict.reason}`;
              if (verdict.decision !== 'allow') return false;
            } catch (e) {
              fenceReason = `Cannot read live facts: ${e instanceof Error ? e.message : String(e)}`;
              return false;
            }
            if (
              options.beforeEffect &&
              !(await options.beforeEffect(item, action, observation, plan))
            ) {
              fenceReason = 'The original host denied the effect';
              return false;
            }
            return true;
          },
        };
        const result = await reflex.run(task);
        const row: BatchRow = {
          id: item.id,
          revision,
          status:
            result.outcome ??
            (result.status === 'uncertain'
              ? 'unknown'
              : result.status === 'failed'
                ? 'failed'
                : result.status === 'skipped'
                  ? 'skipped'
                  : 'attempted'),
          experience: result.experience,
          evidence: result.evidence,
          ...(fenceReason || result.error ? { reason: fenceReason ?? result.error } : {}),
        };
        rows.set(item.id, row);
        options.onItem?.(row, result);
        await persist();
      }
      if (!progress) {
        coverage = 'observed-end';
        break;
      }
      if (Array.isArray(options.items)) {
        coverage = 'observed-end';
        break;
      }
    }
    if (options.signal?.aborted) coverage = 'canceled';
    else if (
      !alive() &&
      !(Array.isArray(options.items) && options.items.every((item) => rows.has(item.id)))
    )
      coverage = 'bounded';
    const attempts = [...rows.values()]
      .filter((r) => ['attempted', 'unknown'].includes(r.status))
      .map((r) => r.id);
    if (verification === 'batch' && options.audit && attempts.length) {
      audits++;
      try {
        const outcomes = await options.audit(attempts);
        for (const key of attempts) {
          const old = rows.get(key)!;
          rows.set(key, { ...old, status: outcomes.get(key) ?? 'unknown' });
        }
      } catch (e) {
        for (const key of attempts)
          rows.set(key, {
            ...rows.get(key)!,
            status: 'unknown',
            reason: `Final audit unavailable: ${String(e)}`,
          });
      }
    }
    await store.settleCandidates(options.id, [...rows.values()]);
    await persist();
    return snapshot();
  } finally {
    await release();
  }
}

/** The original host reports one final audit. This records its evidence, not click-inferred success. */
export async function settleMemoryBatch(
  store: import('./store.js').ExperienceStore,
  batchId: string,
  outcomes: Map<string, 'confirmed' | 'rejected'>,
  source: string,
): Promise<BatchState> {
  if (!source.trim()) throw new Error('An audit source is required');
  const id = createHash('sha256').update(batchId).digest('hex');
  const { release } = await FileJournal.openLocked(join(store.directory, `batch-${id}.journal`));
  try {
    const state = await store.batch<BatchState>(id);
    if (!state) throw new Error('Unknown batch');
    const pending = new Set(
      state.rows.filter((r) => ['attempted', 'unknown'].includes(r.status)).map((r) => r.id),
    );
    for (const key of outcomes.keys())
      if (!pending.has(key)) throw new Error(`Item ${key} is not pending reconciliation`);
    state.rows = state.rows.map((r) =>
      pending.has(r.id) ? { ...r, status: outcomes.get(r.id) ?? 'unknown' } : r,
    );
    state.audits++;
    state.auditSource = source;
    state.candidates = (await store.settleCandidates(batchId, state.rows)).map((p) => ({
      id: p.memory.id,
      status: p.status,
    }));
    await store.saveBatch(id, state);
    return state;
  } finally {
    await release();
  }
}
