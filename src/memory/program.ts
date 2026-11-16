import { isDeepStrictEqual as equal } from 'node:util';
import { decode } from './compiler.js';
import type {
  Action,
  Episode,
  Experience,
  Host,
  Inputs,
  Intent,
  Json,
  MemoryStep,
  ParameterCandidate,
  TraceStep,
} from './types.js';

export function replayActions(
  memory: Experience,
  host: Host,
  inputs: Inputs,
  steps = memory.steps,
): Action[] | undefined {
  const actions: Action[] = [];
  for (const step of steps) {
    const portable = memory.adapter !== undefined && memory.adapter !== host.id;
    const template = portable ? step.intent : step.action;
    if (!template) return;
    const action = decode(template, inputs) as Action;
    if (!host.capabilities.includes(action.kind)) return;
    if (portable && (host.acceptsIntent ? !host.acceptsIntent(action as Intent) : action.submit))
      return;
    actions.push({ ...action, effect: step.effect });
  }
  return actions;
}

function transition(memory: Experience, step: MemoryStep) {
  return step.intent
    ? { intent: step.intent, effect: step.effect }
    : { adapter: memory.adapter, action: step.action, effect: step.effect };
}

export function sameRoute(a: Experience, b: Experience) {
  return (
    equal(
      a.steps.map((s) => transition(a, s)),
      b.steps.map((s) => transition(b, s)),
    ) &&
    equal(a.goal, b.goal) &&
    equal(a.factPlan, b.factPlan) &&
    equal(a.entryUrl, b.entryUrl)
  );
}

export function candidateHints(
  trace: TraceStep[],
  proposed?: ParameterCandidate[],
): ParameterCandidate[] | undefined {
  if (!Array.isArray(proposed)) return;
  const candidates = proposed.slice(0, 32).filter((hint) => {
    if (!hint || !Number.isInteger(hint.step) || hint.step < 0) return false;
    const { input, step, path } = hint;
    const action = trace[step]?.action;
    return (
      action &&
      typeof input === 'string' &&
      /^[\p{L}\p{N}_-]{1,80}$/u.test(input) &&
      (path === 'value' ? action.value !== undefined : action.valuePaths?.includes(path))
    );
  });
  return candidates.length ? candidates : undefined;
}

export function taskGuards(inputs: Inputs, names: string[] = [], inherited?: Record<string, Json>) {
  return {
    ...inherited,
    ...Object.fromEntries(
      names.map((name) => {
        if (!Object.hasOwn(inputs, name)) throw new Error(`Missing declared guard input ${name}`);
        return [name, inputs[name]];
      }),
    ),
  };
}

/** Align only observed steps. Variations are evidence for review, never new executable branches or loops. */
export function studyWorkflow(
  memories: Experience[],
  episodes: (Episode & Sample)[],
  outcomes: (Sample & { experience: string })[],
) {
  const paths = memories.map((memory) => memory.steps.map((step) => transition(memory, step)));
  const stable = paths.reduce((common, path) => align(common, path), paths[0] ?? []);
  const admitted = new Set(memories.map((m) => m.episode));
  const samples = [...episodes.filter((e) => admitted.has(e.id)), ...outcomes];
  const bound = new Set(memories.flatMap((m) => m.requiredInputs));
  const parameters = [...bound].sort().map((input) => {
    const values = samples.flatMap((s) =>
      s.fingerprints && Object.hasOwn(s.fingerprints, input) ? [s.fingerprints[input]] : [],
    );
    return { input, samples: values.length, distinctValues: new Set(values).size };
  });
  const candidates = episodes
    .filter((e) => e.verified || e.success)
    .flatMap((e) =>
      (e.parameterCandidates ?? []).map((hint) => ({
        ...hint,
        episode: e.id,
        status: 'proposed' as const,
      })),
    );
  const routes = memories.map((memory, i) => {
    let at = 0;
    const differences = paths[i].flatMap((step, index) => {
      if (at < stable.length && equal(stable[at], step)) {
        at++;
        return [];
      }
      return [index];
    });
    return {
      experience: memory.id,
      adapter: memory.adapter,
      when: memory.when,
      applicability: memory.applicability,
      constraints: memory.constraints,
      differences,
      repeatCandidates: repetitions(paths[i]),
      confirmedReplays: outcomes.filter((s) => s.experience === memory.id).length,
    };
  });
  return { alignedExamples: memories.length, stable, parameters, candidates, routes };
}

export type Sample = { fingerprints?: Record<string, string> };

function align<T>(a: T[], b: T[]) {
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] = equal(a[i], b[j])
        ? 1 + lengths[i + 1][j + 1]
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const common: T[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (equal(a[i], b[j])) {
      common.push(a[i]);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return common;
}

function repetitions(path: unknown[]) {
  const candidates: { start: number; length: number; count: number }[] = [];
  for (let start = 0; start + 1 < path.length; start++) {
    for (let length = 1; start + 2 * length <= path.length; length++) {
      const block = path.slice(start, start + length);
      let count = 1;
      while (equal(block, path.slice(start + count * length, start + (count + 1) * length)))
        count++;
      if (count > 1) {
        candidates.push({ start, length, count });
        start += length * count - 1;
        break;
      }
    }
  }
  return candidates;
}
