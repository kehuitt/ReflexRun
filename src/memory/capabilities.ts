import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { FileJournal } from '../journal.js';
import { TaskCapture } from './capture.js';
import {
  check,
  decode,
  elementFor,
  encode as parameterize,
  ground,
  isEffect,
  setAt,
} from './compiler.js';
import { ActionExecution, PolicyFence, UncertainEffect } from './execution.js';
import { replayActions } from './program.js';
import { StepAtoms, type ExperienceStore, type StepAtomRef } from './store.js';
import type {
  Action,
  Check,
  Experience,
  Host,
  Inputs,
  Json,
  LearningDetails,
  MemoryStep,
  Observation,
  Target,
  Task,
  TraceStep,
} from './types.js';

/** Values come from a host reader, never from the model that proposes a capability. */
export type FactState = {
  scope: string;
  recordKind: string;
  identity: string;
  fields: Record<string, Json>;
  records: Record<string, Record<string, Json>>;
  writableFields: string[];
  source: string;
};
export type FactRule = { field: string; op: 'equals' | 'contains'; value: Json };
export type CapabilityBoundary = { observation: Observation; facts: FactState };
export type CapabilityProposal = {
  label: string;
  start: number;
  end: number;
  requires: Json;
  ensures: Json;
  effects: FactRule[];
  requiresFacts?: FactRule[];
};
export type Capability = {
  id: string;
  label: string;
  scope: string;
  surface?: Experience['surface'];
  recordKind: string;
  adapter?: string;
  steps: MemoryStep[];
  contexts: string[];
  outcomeContext: string;
  stepEffects: FactRule[][];
  requires: Json;
  ensures: Json;
  effects: FactRule[];
  requiresFacts: FactRule[];
  inputs: string[];
  constraints?: Json;
  when?: Record<string, Json>;
  evidence: { experience: string; episode: string; start: number; end: number }[];
};
type LocatorPatch = {
  id: string;
  dependency: string;
  target: Json;
  from: Json;
  adapter: string;
  capability: string;
  source: string;
  context: string;
};
type Catalog = {
  capabilities: Capability[];
  repairs: LocatorPatch[];
  workflows: Record<string, string[]>;
};
type StoredCapability =
  | Capability
  | (Omit<Capability, 'steps' | 'surface'> & {
      surface: Experience['surface'];
      atoms: StepAtomRef[];
    });
type StoredCatalog = Omit<Catalog, 'capabilities'> &
  ({ format: 1; capabilities: Capability[] } | { format: 2; capabilities: StoredCapability[] });
export type CapabilityRun = {
  task: Task;
  identity: string;
  recordKind: string;
  goal: FactRule[];
  /** An explicit plan bypasses local selection. */
  plan?: string[];
  /** Resolve missing or ambiguous local matches from the authorized catalog. */
  selectPlan?: (candidates: Capability[], initial: CapabilityBoundary) => Promise<string[]>;
  host: Host;
  readFacts: () => Promise<FactState>;
  allowedEffects?: FactRule[];
  repair?: (request: {
    capability: Capability;
    step: number;
    action: Action;
    observation: Observation;
    error: string;
  }) => Promise<Action | undefined>;
};
export type CapabilityResult = {
  status: 'completed' | 'failed' | 'uncertain';
  actions: number;
  skipped: number;
  repairs: number;
  capabilities: string[];
  plan?: string[];
  planSource?: 'explicit' | 'local' | 'model';
  trace: TraceStep[];
  error?: string;
};
export type CapabilityInduction = {
  experience: Experience;
  inputs: Inputs;
  trace: TraceStep[];
  boundaries: CapabilityBoundary[];
  after?: CapabilityBoundary[];
  candidates: Capability[];
};
export type CapabilityCaptureOptions = {
  host: Host;
  store: ExperienceStore;
  task: Task;
  library: CapabilityLibrary;
  readFacts: () => Promise<FactState>;
  /** Authorized typed goal for local induction. Legacy callers can submit ranges explicitly. */
  goal?: FactRule[];
  propose?: (source: CapabilityInduction) => Promise<CapabilityProposal[]>;
};

/** Success hook for the original agent's tools. Induction never performs UI operations. */
export class CapabilityCapture extends TaskCapture {
  learning: 'idle' | 'pending' | 'ready' | 'failed' = 'idle';
  learningError?: string;
  private acting = false;
  private readonly boundaries: CapabilityBoundary[] = [];
  private readonly after: CapabilityBoundary[] = [];
  private source?: Omit<CapabilityInduction, 'candidates'>;
  private ready?: Promise<Capability[]>;
  private readonly factGoal?: FactRule[];
  constructor(private readonly options: CapabilityCaptureOptions) {
    super(options.host, options.store, options.task);
    this.factGoal = structuredClone(options.goal);
  }
  boundaryAt(index: number, side: 'before' | 'after' = 'before'): CapabilityBoundary | undefined {
    return structuredClone((side === 'after' ? this.after : this.boundaries)[index]);
  }
  override async act(action: Action) {
    if (this.acting) throw new Error('Capability capture actions must run sequentially');
    this.acting = true;
    const index = this.trace.length;
    try {
      const before = structuredClone(await this.options.readFacts());
      try {
        return await super.act(action);
      } finally {
        const step = this.trace[index];
        if (step) {
          this.boundaries[index] = { observation: step.before, facts: before };
          this.after[index] = this.boundaries[index + 1] = {
            observation: step.after ?? step.before,
            facts: structuredClone(await this.options.readFacts()),
          };
        }
      }
    } finally {
      this.acting = false;
    }
  }
  override async complete(goal: Check, details: LearningDetails = {}) {
    if (this.acting) throw new Error('Finish the current action before completing capture');
    const experience = await super.complete(goal, details);
    this.source = structuredClone({
      experience,
      inputs: this.task.inputs,
      trace: this.trace,
      boundaries: this.boundaries,
      after: this.after,
    });
    this.learning = 'pending';
    if (this.factGoal && !this.options.propose) {
      const goal = this.factGoal;
      // Admission only consumes the verified trace. A storage failure must not
      // turn a completed user task into a reason to dispatch its actions again.
      void this.admit(async () => {
        const source = this.verifiedSource();
        return this.options.library.learn({
          ...source,
          proposals: inferCapabilities(source, goal),
        });
      }).catch(() => {});
    }
    return experience;
  }
  private verifiedSource() {
    if (!this.source) throw new Error('Only a verified completed task can induce capabilities');
    if (
      this.source.boundaries.length !== this.source.trace.length + 1 ||
      [...this.source.boundaries].some((boundary) => !boundary)
    )
      throw new Error('Missing trusted source boundaries; capability induction was not started');
    return this.source;
  }
  /** Admit proposals submitted by the original task turn. Ranges index the original tool trace. */
  async submitCapabilities(proposals: CapabilityProposal[]) {
    const source = this.verifiedSource();
    if (this.ready && this.learning !== 'failed')
      throw new Error('Capability admission already started');
    return this.admit(async () => {
      const steps = source.experience.steps;
      const ranges = proposals.map(({ start, end, ...proposal }) => {
        const compiledStart = steps.findIndex((step) => step.sourceIndex === start);
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          compiledStart < 0 ||
          end <= start ||
          steps[compiledStart + end - start - 1]?.sourceIndex !== end - 1
        )
          throw new Error('Capability range does not match successful recorded actions');
        return { ...proposal, start: compiledStart, end: compiledStart + end - start };
      });
      return this.options.library.learn({ ...source, proposals: ranges });
    });
  }
  async waitForCapabilities() {
    if (this.ready) return this.ready;
    const source = this.verifiedSource();
    const propose = this.options.propose;
    if (!propose) throw new Error('The completed task did not submit capability proposals');
    return this.admit(async () => {
      const candidates = await this.options.library.candidates(
        source.experience.scope,
        source.boundaries[0].facts.recordKind,
      );
      const proposals = await propose({ ...source, candidates });
      return this.options.library.learn({ ...source, proposals });
    });
  }
  private admit(learn: () => Promise<Capability[]>) {
    this.learning = 'pending';
    this.learningError = undefined;
    this.ready = learn().then(
      (capabilities) => {
        this.learning = 'ready';
        return capabilities;
      },
      (error) => {
        this.learning = 'failed';
        this.learningError = error instanceof Error ? error.message : String(error);
        throw error;
      },
    );
    return this.ready;
  }
}

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function inputsIn(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => inputsIn(v, result));
  else if (value && typeof value === 'object') {
    if ('$input' in value && typeof value.$input === 'string') result.add(value.$input);
    Object.values(value).forEach((v) => inputsIn(v, result));
  }
  return result;
}
function rulesHold(facts: FactState, rules: FactRule[], inputs: Inputs): boolean {
  return rules.every((rule) => {
    if (!Object.hasOwn(facts.fields, rule.field)) return false;
    const expected = decode(rule.value, inputs),
      actual = facts.fields[rule.field];
    return rule.op === 'equals'
      ? equal(actual, expected)
      : Array.isArray(actual) && actual.some((value) => equal(value, expected));
  });
}
function validateRules(rules: FactRule[], state: FactState, inputs: Inputs) {
  if (!Array.isArray(rules)) throw new Error('Fact rules must be an array');
  for (const rule of rules) {
    if (
      !rule ||
      !['equals', 'contains'].includes(rule.op) ||
      typeof rule.field !== 'string' ||
      !Object.hasOwn(state.fields, rule.field) ||
      !Object.hasOwn(rule, 'value')
    )
      throw new Error('Rule refers to a missing or unsupported host fact');
    decode(rule.value, inputs);
  }
}
function validateState(
  state: FactState,
  expected: Pick<FactState, 'scope' | 'identity' | 'recordKind'>,
) {
  if (
    !state.source?.trim() ||
    !expected.identity ||
    state.identity !== expected.identity ||
    state.scope !== expected.scope ||
    state.recordKind !== expected.recordKind ||
    !Array.isArray(state.writableFields) ||
    !equal(state.fields, state.records?.[state.identity])
  )
    throw new Error('Trusted reader did not establish the authorized record identity and facts');
}
/** A contains effect may add its member, but may not remove or overwrite other members. */
function validateDelta(before: FactState, after: FactState, effects: FactRule[], inputs: Inputs) {
  validateState(after, before);
  if (!equal(before.writableFields, after.writableFields))
    throw new Error('The trusted writable-field schema changed');
  if (!equal(Object.keys(before.records).sort(), Object.keys(after.records).sort()))
    throw new Error('The action changed the authorized record set');
  for (const [id, fields] of Object.entries(before.records)) {
    if (id !== before.identity) {
      if (!equal(fields, after.records[id])) throw new Error('The action changed another record');
      continue;
    }
    if (!equal(Object.keys(fields).sort(), Object.keys(after.fields).sort()))
      throw new Error('A required dynamic fact disappeared or was introduced');
    for (const [field, value] of Object.entries(fields)) {
      if (equal(value, after.fields[field])) continue;
      if (!before.writableFields.includes(field)) throw new Error('An immutable host fact changed');
      const allowed = effects.filter((rule) => rule.field === field);
      const permitted = allowed.some((rule) => {
        const next = decode(rule.value, inputs);
        if (rule.op === 'equals') return equal(after.fields[field], next);
        const actual = after.fields[field];
        return (
          Array.isArray(value) &&
          Array.isArray(actual) &&
          value.every((old) => actual.some((v) => equal(old, v))) &&
          actual.every((v) => value.some((old) => equal(old, v)) || equal(v, next))
        );
      });
      if (!permitted) throw new Error('The action exceeded its observed field effects');
    }
  }
}
function sourceAction(action: Action, state: Observation) {
  const result = structuredClone(action);
  delete result.effect; // A trusted fact delta may strengthen the original effect classification.
  const target = (value: Target) => {
    const element = elementFor(value, state);
    if (!element) throw new Error('Source action does not identify a unique observed element');
    return { ref: element.ref };
  };
  if (result.target) result.target = target(result.target);
  if (result.to) result.to = target(result.to);
  if (result.bindings) {
    for (const [path, binding] of Object.entries(result.bindings)) {
      result.bindings[path] = target(binding);
      setAt(result.args, path, null);
    }
  }
  return result;
}
function uiTemplate(template: Json, state: Observation, inputs: Inputs): Json {
  const condition = decode(template, inputs) as Check;
  if (!condition || !check(state, condition))
    throw new Error('Proposed UI condition is not supported by its source boundary');
  const resolved = condition.target
    ? { ...condition, target: ground({ kind: 'wait', target: condition.target }, state).target }
    : condition;
  return parameterize(resolved, inputs);
}
function slots(action: Action): [string, Target][] {
  return [
    ...(action.target ? [['target', action.target] as [string, Target]] : []),
    ...(action.to ? [['to', action.to] as [string, Target]] : []),
    ...Object.entries(action.bindings ?? {}).map(
      ([path, target]) => [`bindings.${path}`, target] as [string, Target],
    ),
  ];
}
function putTarget(action: Action, slot: string, target: Target) {
  if (slot.startsWith('bindings.')) action.bindings![slot.slice(9)] = target;
  else if (slot === 'target') action.target = target;
  else action.to = target;
}
function withoutTargets(action: Action) {
  const result = structuredClone(action);
  for (const [slot] of slots(result)) putTarget(result, slot, {});
  for (const path of Object.keys(result.bindings ?? {})) setAt(result.args, path, null);
  if (
    ['browser_click', 'browser_type', 'browser_hover', 'browser_select_option'].includes(
      result.tool ?? '',
    )
  )
    delete result.args?.element; // Playwright MCP's description is not a behavioral argument.
  return result;
}
function pageContext(state: Observation, facts: FactState, inputs: Inputs) {
  const substitutions = Object.entries(inputs)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length >= 3,
    )
    .map(([key, value]) => [value, `$input:${key}`])
    .sort(([a], [b]) => b.length - a.length);
  const identity = new Set([facts.identity, encodeURIComponent(facts.identity)]);
  const bindIdentity = (value: string) => (identity.has(value) ? '$record' : value);
  const normalize = (text: string) => {
    for (const [value, key] of substitutions)
      for (const representation of new Set([
        value,
        encodeURIComponent(value),
        new URLSearchParams({ x: value }).toString().slice(2),
      ]))
        text = text.split(representation).join(key);
    return text;
  };
  if (state.url) {
    const url = new URL(state.url);
    return stable({
      surface: state.surface,
      origin: url.origin,
      path: normalize(url.pathname.split('/').map(bindIdentity).join('/')),
      // Query names and all unknown values remain exact; only trusted parameter values vary.
      query: [...url.searchParams].map(([key, value]) => [key, normalize(bindIdentity(value))]),
      hash: normalize(
        url.hash
          .split(/([/#?&=])/)
          .map(bindIdentity)
          .join(''),
      ),
    });
  }
  // A screenshot-only surface has no verified route. Sharing is limited to this exact UI class.
  return `native:${hash({ surface: state.surface, scope: state.scope, title: normalize(state.title), layout: state.layoutKey })}`;
}

/** Split only at independently observable route or authorized field transitions. */
function inferCapabilities(
  { experience, inputs, trace, boundaries, after }: Omit<CapabilityInduction, 'candidates'>,
  goal: FactRule[],
): CapabilityProposal[] {
  const steps = experience.steps;
  const initial = boundaries[0];
  const final = after?.at(-1);
  if (!initial || !after || !final || !goal.length)
    throw new Error('Local induction needs recorded boundaries and a typed goal');
  validateRules(goal, initial.facts, inputs);
  validateDelta(initial.facts, final.facts, goal, inputs);
  if (!rulesHold(final.facts, goal, inputs))
    throw new Error('The typed goal was not confirmed by the recorded facts');

  const included = new Set(steps.map((step) => step.sourceIndex));
  for (const [index, step] of trace.entries()) {
    if (included.has(index)) continue;
    if (
      step.dispatched &&
      (isEffect(step.action, step.before) || step.before.stateKey !== step.after?.stateKey)
    )
      throw new Error('A discarded source action may have changed the authorized state');
    validateDelta(boundaries[index].facts, after[index].facts, [], inputs);
  }

  const proposals: CapabilityProposal[] = [];
  let start = 0;
  for (const [index, { sourceIndex }] of steps.entries()) {
    const first = steps[start].sourceIndex;
    if (sourceIndex !== first + index - start)
      throw new Error('A compound action is missing a successful source step');
    const before = boundaries[sourceIndex];
    const next = after[sourceIndex];
    const startBoundary = boundaries[first];
    if (!before?.observation.url || !next?.observation.url || !startBoundary?.observation.url)
      throw new Error('Local induction needs observable URL-backed routes');
    validateDelta(before.facts, next.facts, goal, inputs);
    if (index > 0) {
      const previous = after[steps[index - 1].sourceIndex];
      validateDelta(previous.facts, before.facts, [], inputs);
      if (
        pageContext(previous.observation, previous.facts, inputs) !==
        pageContext(before.observation, before.facts, inputs)
      )
        throw new Error('The source route changed outside a captured action');
    }
    const effects = goal.filter(
      (rule) =>
        !rulesHold(startBoundary.facts, [rule], inputs) && rulesHold(next.facts, [rule], inputs),
    );
    const entry = pageContext(startBoundary.observation, startBoundary.facts, inputs);
    const outcome = pageContext(next.observation, next.facts, inputs);
    if (!effects.length && entry === outcome) continue;

    // Opening an already-read record can hide a conditional write. Preserve
    // observed unchanged boolean state when the route enters that exact record.
    const requiresFacts: FactRule[] =
      !entry.includes('$record') && outcome.includes('$record')
        ? startBoundary.facts.writableFields.flatMap((field) => {
            const value = startBoundary.facts.fields[field];
            return typeof value === 'boolean' && equal(value, next.facts.fields[field])
              ? [{ field, op: 'equals', value }]
              : [];
          })
        : [];
    proposals.push({
      label: effects.length ? effects.map((effect) => effect.field).join(', ') : 'Navigate',
      start,
      end: index + 1,
      requires: { urlIncludes: new URL(startBoundary.observation.url).origin },
      ensures: { urlIncludes: new URL(next.observation.url).origin },
      effects,
      requiresFacts,
    });
    start = index + 1;
  }
  if (start !== steps.length)
    throw new Error('A trailing action group has no observable route or field outcome');
  return proposals;
}
function dependency(cap: Capability, index: number, slot: string, target: Json, adapter: string) {
  return hash({
    scope: cap.scope,
    recordKind: cap.recordKind,
    adapter,
    context: cap.contexts[index],
    constraints: cap.constraints,
    behavior: withoutTargets(cap.steps[index].action as unknown as Action),
    effect: cap.steps[index].effect,
    effects: cap.stepEffects[index],
    slot,
    target,
  });
}

/** Align successful versions only when their complete action programs and routes agree. */
function programKey(cap: Capability) {
  return hash({
    scope: cap.scope,
    recordKind: cap.recordKind,
    adapter: cap.adapter,
    constraints: cap.constraints,
    when: cap.when,
    contexts: cap.contexts,
    outcome: cap.outcomeContext,
    steps: cap.steps.map((step) => ({
      behavior: withoutTargets(step.action as unknown as Action),
      targets: slots(step.action as unknown as Action),
      effect: step.effect,
    })),
  });
}

function capabilityActions(capability: Capability, host: Host, inputs: Inputs) {
  const memory = { ...capability, requiredInputs: capability.inputs } as unknown as Experience;
  return replayActions(memory, host, inputs);
}

function patchAction(
  action: Action,
  cap: Capability,
  step: number,
  { observation, facts }: CapabilityBoundary,
  inputs: Inputs,
  adapter: string,
  patches: LocatorPatch[],
) {
  for (const [slot, target] of slots(action)) {
    if (elementFor(target, observation)) continue;
    const original = slots(cap.steps[step].action as unknown as Action).find(
      ([path]) => path === slot,
    )?.[1];
    if (!original) continue;
    const key = dependency(cap, step, slot, original as unknown as Json, adapter);
    const patch = [...patches]
      .reverse()
      .find(
        (candidate) =>
          candidate.dependency === key &&
          candidate.context === pageContext(observation, facts, inputs) &&
          elementFor(decode(candidate.target, inputs) as Target, observation),
      );
    if (patch) putTarget(action, slot, decode(patch.target, inputs) as Target);
  }
  return action;
}

function checkCapability(
  template: Json,
  cap: Capability,
  { observation, facts }: CapabilityBoundary,
  inputs: Inputs,
  adapter: string,
  catalog: Catalog,
  pending: LocatorPatch[] = [],
) {
  const condition = decode(template, inputs) as Check;
  if (condition.target && !elementFor(condition.target, observation)) {
    const patch = [...catalog.repairs, ...pending].reverse().find((candidate) => {
      const owner = catalog.capabilities.find((entry) => entry.id === candidate.capability);
      return (
        owner?.scope === cap.scope &&
        owner.recordKind === cap.recordKind &&
        equal(owner.constraints, cap.constraints) &&
        candidate.adapter === adapter &&
        candidate.context === pageContext(observation, facts, inputs) &&
        equal(decode(candidate.from, inputs), condition.target) &&
        !!elementFor(decode(candidate.target, inputs) as Target, observation)
      );
    });
    if (patch) condition.target = decode(patch.target, inputs) as Target;
  }
  return check(observation, condition);
}

/** Find a unique shortest observed program, including the return to its entry page. */
function localPlan(
  args: CapabilityRun,
  candidates: Capability[],
  initial: CapabilityBoundary,
  allowed: FactRule[],
  catalog: Catalog,
) {
  const { inputs, maxActions } = args.task;
  const entry = pageContext(initial.observation, initial.facts, inputs);
  const ruleKey = (rule: FactRule) => stable(decode(rule as unknown as Json, inputs));
  const permits = new Set(allowed.map(ruleKey));
  const edges = candidates.flatMap((cap) => {
    const actions = capabilityActions(cap, args.host, inputs);
    return actions?.length
      ? [
          {
            cap,
            actions,
            observed: new Set(cap.stepEffects.flat().map(ruleKey)),
            signature: actions.map((action, i) =>
              stable([cap.contexts[i], withoutTargets(action), slots(action)]),
            ),
          },
        ]
      : [];
  });
  type Route = {
    context: string;
    facts: FactState;
    plan: string[];
    signature: string[];
  };
  const queue: Route[] = [{ context: entry, facts: initial.facts, plan: [], signature: [] }];
  const visited = new Map<string, { length: number; programs: Set<string> }>();
  let best: Route | undefined,
    refresh = false;
  // Bound local search even if a catalog contains many combinations of otherwise valid fragments.
  for (let examined = 0; queue.length; examined++) {
    if (examined >= 128) return { refresh };
    queue.sort((a, b) => a.signature.length - b.signature.length);
    const route = queue.shift()!;
    if (best && route.signature.length > best.signature.length) break;
    const key = stable([route.context, route.facts.fields]);
    const signature = stable(route.signature);
    const prior = visited.get(key);
    if (
      prior &&
      (prior.length < route.signature.length ||
        prior.programs.has(signature) ||
        prior.programs.size >= 2)
    )
      continue;
    if (prior) prior.programs.add(signature);
    else visited.set(key, { length: route.signature.length, programs: new Set([signature]) });
    if (route.context === entry && rulesHold(route.facts, args.goal, inputs)) {
      if (best) return { refresh };
      best = route;
      continue;
    }
    for (const edge of edges) {
      const { cap, actions, observed } = edge;
      if (
        route.context !== cap.contexts[0] ||
        route.signature.length + actions.length > (maxActions ?? 200) ||
        !rulesHold(route.facts, cap.requiresFacts, inputs)
      )
        continue;
      if (!route.plan.length) {
        const action = patchAction(
          structuredClone(actions[0]),
          cap,
          0,
          initial,
          inputs,
          args.host.id,
          catalog.repairs,
        );
        if (slots(action).some(([, target]) => !elementFor(target, initial.observation))) {
          refresh = true;
          continue;
        }
        if (!checkCapability(cap.requires, cap, initial, inputs, args.host.id, catalog)) continue;
      }
      const facts = { ...route.facts, fields: { ...route.facts.fields } };
      const compatible = cap.effects.every((rule) => {
        if (rulesHold(facts, [rule], inputs)) return true;
        const key = ruleKey(rule);
        const field = facts.fields[rule.field];
        if (
          !facts.writableFields.includes(rule.field) ||
          !permits.has(key) ||
          !observed.has(key) ||
          (rule.op === 'contains' && !Array.isArray(field))
        )
          return false;
        const value = decode(rule.value, inputs) as Json;
        facts.fields[rule.field] = rule.op === 'contains' ? [...(field as Json[]), value] : value;
        return true;
      });
      if (compatible)
        queue.push({
          context: cap.outcomeContext,
          facts,
          plan: [...route.plan, cap.id],
          signature: [...route.signature, ...edge.signature],
        });
    }
  }
  return { plan: best?.plan, refresh };
}

/** Only exact, verified source actions become executable capabilities. */
export class CapabilityLibrary {
  private readonly atoms: StepAtoms;
  constructor(readonly directory: string) {
    this.atoms = new StepAtoms(directory);
  }
  private async load(): Promise<Catalog> {
    let data: string;
    try {
      data = await readFile(join(this.directory, 'capabilities.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { capabilities: [], repairs: [], workflows: {} };
    }
    const catalog = JSON.parse(data) as StoredCatalog;
    if (catalog.format === 1) return catalog;
    if (catalog.format !== 2) throw new Error('Unsupported capability catalog');
    const capabilities = await Promise.all(
      catalog.capabilities.map(async (cap) => {
        if (!('atoms' in cap)) return cap;
        const { atoms, ...owner } = cap;
        return { ...owner, steps: await this.atoms.hydrate(owner, atoms) };
      }),
    );
    return { capabilities, repairs: catalog.repairs, workflows: catalog.workflows };
  }
  private async save(catalog: Catalog) {
    const capabilities = await Promise.all(
      catalog.capabilities.map(async (cap) => {
        if (!cap.surface) return cap;
        const { steps, surface, ...details } = cap;
        const owner = { ...details, surface };
        return { ...owner, atoms: await this.atoms.store(owner, steps) };
      }),
    );
    const stored: StoredCatalog = {
      format: 2,
      capabilities,
      repairs: catalog.repairs,
      workflows: catalog.workflows,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'capabilities.json'),
      temporary = `${path}.${randomUUID()}.tmp`,
      file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(stored, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }
  async candidates(scope: string, recordKind: string): Promise<Capability[]> {
    return (await this.load()).capabilities.filter(
      (cap) => cap.scope === scope && cap.recordKind === recordKind,
    );
  }
  async dependencies() {
    const { workflows, repairs } = await this.load();
    return { workflows, repairs };
  }
  /** Bring verified programs and their write fences into a store without replacing its catalog entries. */
  async importFrom(source: CapabilityLibrary) {
    const incoming = await source.load();
    const pending = await FileJournal.load(join(source.directory, 'capability-intents.jsonl'));
    if (
      !incoming.capabilities.length &&
      !incoming.repairs.length &&
      !Object.keys(incoming.workflows).length &&
      !pending.entries().length
    )
      return;
    const { journal, release } = await FileJournal.openLocked(
      join(this.directory, 'capability-intents.jsonl'),
    );
    try {
      const current = await this.load();
      await journal.importFences(pending);
      const capabilities = new Map(current.capabilities.map((entry) => [entry.id, entry]));
      const repairs = new Map(current.repairs.map((entry) => [entry.id, entry]));
      for (const capability of incoming.capabilities)
        if (!capabilities.has(capability.id)) capabilities.set(capability.id, capability);
      const addedRepairs = incoming.repairs.filter((entry) => !repairs.has(entry.id));
      const workflows = { ...incoming.workflows, ...current.workflows };
      if (
        capabilities.size !== current.capabilities.length ||
        addedRepairs.length ||
        Object.keys(workflows).length !== Object.keys(current.workflows).length
      )
        await this.save({
          capabilities: [...capabilities.values()],
          // Matching repairs prefer the latest catalog entry.
          repairs: [...addedRepairs, ...current.repairs],
          workflows,
        });
    } finally {
      await release();
    }
  }
  async learn(
    args: {
      experience: Experience;
      inputs: Inputs;
      trace: TraceStep[];
      boundaries: CapabilityBoundary[];
      after?: CapabilityBoundary[];
      proposals: CapabilityProposal[];
    },
    options: { validateOnly?: boolean } = {},
  ): Promise<Capability[]> {
    const { experience: memory, inputs, trace, boundaries } = args;
    const post = args.after ?? boundaries.slice(1);
    if (
      boundaries.length !== trace.length + 1 ||
      post.length !== trace.length ||
      !args.proposals.length
    )
      throw new Error('Learning requires original per-action boundaries and model proposals');
    const { release } = await FileJournal.openLocked(
      join(this.directory, 'capability-intents.jsonl'),
    );
    try {
      const catalog = await this.load(),
        admitted: Capability[] = [];
      for (const proposal of args.proposals) {
        const { start, end } = proposal;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > memory.steps.length
        )
          throw new Error('Proposed capability range is outside the successful source experience');
        const selected = memory.steps.slice(start, end),
          first = selected[0].sourceIndex,
          last = selected.at(-1)!.sourceIndex,
          before = boundaries[first],
          after = post[last];
        if (!before || !after || selected.some((step, i) => step.sourceIndex !== first + i))
          throw new Error('Capability steps must be an exact contiguous successful source range');
        validateState(before.facts, { ...before.facts, scope: memory.scope });
        validateRules(proposal.effects, before.facts, inputs);
        validateRules(proposal.requiresFacts ?? [], before.facts, inputs);
        if (!rulesHold(before.facts, proposal.requiresFacts ?? [], inputs))
          throw new Error('Proposed fact precondition did not hold in the source task');
        if (!rulesHold(after.facts, proposal.effects, inputs))
          throw new Error('Proposed effects were not observed after the source range');
        const steps = selected.map((step) => {
          const original = trace[step.sourceIndex],
            left = boundaries[step.sourceIndex],
            right = post[step.sourceIndex];
          if (
            !original ||
            original.error ||
            !original.dispatched ||
            !original.after ||
            !left ||
            !right ||
            left.observation.stateKey !== original.before.stateKey ||
            right.observation.stateKey !== original.after.stateKey ||
            left.observation.scope !== memory.scope ||
            right.observation.scope !== memory.scope ||
            !equal(
              sourceAction(decode(step.action, inputs) as Action, original.before),
              sourceAction(original.action, original.before),
            )
          )
            throw new Error('Capability action is not the exact successful observed source action');
          validateState(left.facts, before.facts);
          if (step.sourceIndex > first) {
            const prior = post[step.sourceIndex - 1];
            if (
              pageContext(prior.observation, prior.facts, inputs) !==
              pageContext(left.observation, left.facts, inputs)
            )
              throw new Error('The source route changed between recorded actions');
            validateDelta(prior.facts, left.facts, [], inputs);
          }
          validateDelta(left.facts, right.facts, proposal.effects, inputs);
          return { ...step, effect: step.effect || !equal(left.facts.fields, right.facts.fields) };
        });
        const cap: Capability = {
          id: '',
          label: proposal.label,
          scope: memory.scope,
          surface: memory.surface,
          recordKind: before.facts.recordKind,
          ...(memory.adapter ? { adapter: memory.adapter } : {}),
          steps,
          contexts: selected.map((step) =>
            pageContext(
              boundaries[step.sourceIndex].observation,
              boundaries[step.sourceIndex].facts,
              inputs,
            ),
          ),
          outcomeContext: pageContext(after.observation, after.facts, inputs),
          stepEffects: selected.map((step) => {
            const before = boundaries[step.sourceIndex].facts,
              after = post[step.sourceIndex].facts;
            return proposal.effects
              .filter(
                (rule) =>
                  !equal(before.fields[rule.field], after.fields[rule.field]) &&
                  !rulesHold(before, [rule], inputs) &&
                  rulesHold(after, [rule], inputs),
              )
              .map((rule) => ({ ...rule, value: parameterize(decode(rule.value, inputs), inputs) }))
              .sort((a, b) => stable(a).localeCompare(stable(b)));
          }),
          requires: uiTemplate(proposal.requires, before.observation, inputs),
          ensures: uiTemplate(proposal.ensures, after.observation, inputs),
          effects: proposal.effects.map((rule) => ({
            ...rule,
            value: parameterize(decode(rule.value, inputs), inputs),
          })),
          requiresFacts: (proposal.requiresFacts ?? []).map((rule) => ({
            ...rule,
            value: parameterize(decode(rule.value, inputs), inputs),
          })),
          inputs: [],
          ...(memory.constraints !== undefined ? { constraints: memory.constraints } : {}),
          ...(memory.when ? { when: memory.when } : {}),
          evidence: [{ experience: memory.id, episode: memory.episode, start, end }],
        };
        cap.inputs = [
          ...inputsIn([
            cap.steps,
            cap.requires,
            cap.ensures,
            cap.effects,
            cap.requiresFacts,
            cap.constraints,
          ]),
        ].sort();
        cap.inputs.forEach((input) => {
          if (!Object.hasOwn(inputs, input)) throw new Error(`Missing source input ${input}`);
        });
        // Labels and evidence never decide compatibility. Exact source programs and contracts do.
        const {
          id: _id,
          label: _label,
          surface: _surface,
          evidence: _evidence,
          stepEffects: _observedEffects,
          ...program
        } = cap;
        cap.id = hash({
          ...program,
          steps: steps.map(({ sourceIndex: _source, effect: _effect, ...step }) => step),
        });
        const prior = catalog.capabilities.find((entry) => entry.id === cap.id);
        if (prior) {
          prior.surface ??= cap.surface;
          prior.evidence.push(
            ...cap.evidence.filter((entry) => !prior.evidence.some((old) => equal(old, entry))),
          );
          prior.steps.forEach((step, i) => {
            step.effect ||= cap.steps[i].effect;
            prior.stepEffects[i] = [
              ...new Map(
                [...prior.stepEffects[i], ...cap.stepEffects[i]].map((rule) => [
                  stable(rule),
                  rule,
                ]),
              ).values(),
            ].sort((a, b) => stable(a).localeCompare(stable(b)));
          });
          admitted.push(prior);
        } else {
          catalog.capabilities.push(cap);
          admitted.push(cap);
        }
      }
      catalog.workflows[memory.key] = [...new Set(admitted.map((cap) => cap.id))];
      if (!options.validateOnly) await this.save(catalog);
      return admitted;
    } finally {
      await release();
    }
  }

  async run(args: CapabilityRun): Promise<CapabilityResult> {
    const { host, task } = args;
    const { journal, release } = await FileJournal.openLocked(
      join(this.directory, 'capability-intents.jsonl'),
    );
    let execution: ActionExecution | undefined,
      skipped = 0,
      repairs = 0,
      recordFence: string | undefined,
      plan = args.plan,
      planSource: CapabilityResult['planSource'] = plan ? 'explicit' : undefined;
    const used: string[] = [],
      pending: LocatorPatch[] = [];
    try {
      const catalog = await this.load();
      if (!task.key || !task.job || !args.identity || !args.goal.length)
        throw new Error('A stable job, record identity, and typed goal are required');
      if (task.verification === 'readback' && !task.readback)
        throw new Error(
          'Host readback verification requires its independent reader before any write',
        );
      const initial = await host.observe({ fresh: true });
      recordFence = `capability:${hash({ scope: initial.scope, recordKind: args.recordKind, identity: args.identity })}`;
      let facts = await args.readFacts();
      const expected = {
        scope: initial.scope,
        identity: args.identity,
        recordKind: args.recordKind,
      };
      let actionContext: string | undefined;
      const freshFacts = async () => {
        const latest = await args.readFacts();
        validateState(latest, expected);
        validateDelta(facts, latest, [], task.inputs);
        facts = latest;
      };
      execution = new ActionExecution(
        host,
        {
          ...task,
          key: recordFence,
          beforeEffect: async (action, observation, plan) => {
            await freshFacts();
            if (
              actionContext &&
              observation.url &&
              pageContext(observation, facts, task.inputs) !== actionContext
            )
              throw new PolicyFence('Capability source page changed before dispatch');
            return task.beforeEffect ? task.beforeEffect(action, observation, plan) : true;
          },
        },
        initial,
      );
      execution.allowed(execution.state);
      validateState(facts, expected);
      if (
        journal
          .entries()
          .some(
            (entry) =>
              entry.label === recordFence && !['confirmed', 'rejected'].includes(entry.state),
          )
      )
        throw new UncertainEffect(
          'This record has an unconfirmed prior attempt; the host must reconcile it before another plan',
        );
      validateRules(args.goal, facts, task.inputs);
      const allowed = args.allowedEffects ?? args.goal;
      validateRules(allowed, facts, task.inputs);
      if (!plan) {
        const candidates = catalog.capabilities.filter(
          (cap) =>
            cap.scope === initial.scope &&
            cap.recordKind === args.recordKind &&
            cap.inputs.every((input) => Object.hasOwn(task.inputs, input)) &&
            equal(decode(cap.constraints ?? null, task.inputs), task.constraints ?? null) &&
            Object.entries(cap.when ?? {}).every(([key, value]) => equal(task.inputs[key], value)),
        );
        const selectLocal = () =>
          localPlan(args, candidates, { observation: execution!.state, facts }, allowed, catalog);
        let selected = selectLocal();
        if (selected.refresh) {
          await execution.observe({ fresh: true });
          await freshFacts();
          selected = selectLocal();
        }
        plan = selected.plan;
        if (plan) planSource = 'local';
        else if (args.selectPlan) {
          plan = await args.selectPlan(structuredClone(candidates), {
            observation: structuredClone(execution.state),
            facts: structuredClone(facts),
          });
          planSource = 'model';
          await execution.observe({ fresh: true });
          await freshFacts();
        } else throw new Error('No unique compatible capability plan for this goal');
      }
      const capabilities = plan.map((id) => {
        const cap = catalog.capabilities.find((entry) => entry.id === id);
        if (!cap || cap.scope !== execution!.scope || cap.recordKind !== args.recordKind)
          throw new Error('Plan references an unavailable or incompatible capability');
        if (!equal(decode(cap.constraints ?? null, task.inputs), task.constraints ?? null))
          throw new PolicyFence('Capability constraints differ from this authorization');
        if (Object.entries(cap.when ?? {}).some(([key, value]) => !equal(task.inputs[key], value)))
          throw new PolicyFence('Capability guard input changed');
        cap.inputs.forEach((input) => {
          if (!Object.hasOwn(task.inputs, input)) throw new Error(`Missing input ${input}`);
        });
        validateRules(cap.effects, facts, task.inputs);
        if (
          cap.effects.some(
            (rule) =>
              !rulesHold(facts, [rule], task.inputs) &&
              !allowed.some((permit) =>
                equal(
                  decode(permit as unknown as Json, task.inputs),
                  decode(rule as unknown as Json, task.inputs),
                ),
              ),
          )
        )
          throw new PolicyFence('Plan would expand the authorized field effects');
        return cap;
      });
      if (!rulesHold(facts, args.goal, task.inputs) && !capabilities.length)
        throw new Error('The plan did not provide capabilities for the unfinished goal');
      if (!rulesHold(facts, args.goal, task.inputs))
        for (const selected of capabilities) {
          // A later successful example can prove the same program works in a different fact state.
          // Keep both preconditions; choose a compatible variant rather than deleting either guard.
          let cap = selected;
          if (!rulesHold(facts, selected.requiresFacts, task.inputs)) {
            const sameRule = (a: FactRule, b: FactRule) =>
              equal(
                decode(a as unknown as Json, task.inputs),
                decode(b as unknown as Json, task.inputs),
              );
            const key = programKey(selected);
            cap =
              catalog.capabilities.find(
                (candidate) =>
                  candidate.id !== selected.id &&
                  candidate.inputs.every((input) => Object.hasOwn(task.inputs, input)) &&
                  programKey(candidate) === key &&
                  rulesHold(facts, candidate.requiresFacts, task.inputs) &&
                  selected.effects.every(
                    (rule) =>
                      rulesHold(facts, [rule], task.inputs) ||
                      candidate.effects.some((effect) => sameRule(rule, effect)),
                  ) &&
                  candidate.effects.every(
                    (rule) =>
                      rulesHold(facts, [rule], task.inputs) ||
                      allowed.some((effect) => sameRule(rule, effect)),
                  ),
              ) ?? selected;
          }
          const actions = capabilityActions(cap, host, task.inputs);
          if (!actions) throw new Error('Host does not support this capability program');
          const boundary = () => ({ observation: execution!.state, facts });
          const checkAt = (template: Json) =>
            checkCapability(template, cap, boundary(), task.inputs, host.id, catalog, pending);
          const atOutcome = () =>
            (!execution!.state.url ||
              cap.outcomeContext === pageContext(execution!.state, facts, task.inputs)) &&
            checkAt(cap.ensures);
          if (rulesHold(facts, cap.effects, task.inputs) && atOutcome()) {
            skipped++;
            continue;
          }
          if (!rulesHold(facts, cap.requiresFacts, task.inputs))
            throw new Error('Capability fact precondition does not hold');
          const before = facts;
          for (const [i, original] of actions.entries()) {
            const currentAction = () =>
              patchAction(structuredClone(original), cap, i, boundary(), task.inputs, host.id, [
                ...catalog.repairs,
                ...pending,
              ]);
            let action = currentAction();
            actionContext = cap.contexts[i];
            const checkContext = () => {
              if (
                execution!.state.url &&
                actionContext !== pageContext(execution!.state, facts, task.inputs)
              )
                throw new PolicyFence(
                  'Capability source page or route does not match the current UI',
                );
            };
            checkContext();
            const missing = () =>
              slots(action).some(([, target]) => !elementFor(target, execution!.state));
            let unresolved = missing();
            if (unresolved) {
              await execution.observe({ fresh: true });
              checkContext();
              action = currentAction();
              unresolved = missing();
            }
            if (unresolved) {
              if (!args.repair || repairs >= (task.maxRepairs ?? 1))
                throw new Error('A capability locator changed; the original agent must repair it');
              repairs++;
              const replacement = await args.repair({
                capability: cap,
                step: i,
                action: structuredClone(action),
                observation: execution.state,
                error: 'Recorded target is missing or ambiguous',
              });
              if (
                !replacement ||
                !equal(withoutTargets(action), withoutTargets(replacement)) ||
                !equal(
                  slots(action).map(([path]) => path),
                  slots(replacement).map(([path]) => path),
                )
              )
                throw new PolicyFence('Repair may only replace existing locator bindings');
              for (const [slot, target] of slots(replacement)) {
                const old = slots(action).find(([path]) => path === slot)![1];
                if (equal(old, target)) continue;
                if (
                  target.ref ||
                  target.index !== undefined ||
                  !elementFor(target, execution.state) ||
                  old.role !== target.role ||
                  !equal(old.frames, target.frames) ||
                  old.within !== target.within
                )
                  throw new PolicyFence(
                    'Repair widened the locator context or is not uniquely observed',
                  );
                const template = slots(cap.steps[i].action as unknown as Action).find(
                    ([path]) => path === slot,
                  )![1] as unknown as Json,
                  encoded = parameterize(target, task.inputs);
                if ([...inputsIn(template)].some((input) => !inputsIn(encoded).has(input)))
                  throw new PolicyFence('Repair removed a record identity parameter');
                pending.push({
                  id: randomUUID(),
                  dependency: dependency(cap, i, slot, template, host.id),
                  target: encoded,
                  from: template,
                  adapter: host.id,
                  capability: cap.id,
                  source: facts.source,
                  context: pageContext(execution.state, facts, task.inputs),
                });
              }
              action = replacement;
            }
            if (i === 0 && !checkAt(cap.requires))
              throw new Error('Capability UI precondition does not hold');
            const previous = facts;
            await execution.perform(action, journal, {
              replay: true,
              shareAfter: !!host.observeUntil,
            });
            try {
              facts = await args.readFacts();
              validateState(facts, expected);
              validateDelta(previous, facts, cap.effects, task.inputs);
              validateDelta(previous, facts, allowed, task.inputs);
            } catch (error) {
              throw new UncertainEffect(
                `Post-action facts require reconciliation: ${String(error)}`,
              );
            }
          }
          validateDelta(before, facts, cap.effects, task.inputs);
          const effectsHold = rulesHold(facts, cap.effects, task.inputs);
          let outcomeHolds = atOutcome();
          if (effectsHold && !outcomeHolds) {
            await execution.observe({ fresh: true });
            outcomeHolds = atOutcome();
          }
          if (!effectsHold || !outcomeHolds)
            throw execution.effectAttempts
              ? new UncertainEffect('Capability result did not confirm; reconcile before retry')
              : new Error('Capability UI result did not hold');
          used.push(cap.id);
        }
      const previous = facts;
      facts = await args.readFacts();
      validateState(facts, expected);
      validateDelta(previous, facts, [], task.inputs);
      if (!rulesHold(facts, args.goal, task.inputs))
        throw new UncertainEffect('Final typed goal did not confirm');
      if (task.readback) {
        const readback = await task.readback();
        if (readback.status !== 'confirmed' || !readback.source.trim())
          throw new UncertainEffect('Host independent readback did not confirm');
      }
      // After independent verification, flush all final confirmations together.
      await journal.putMany(
        journal
          .entries()
          .filter((entry) => entry.label === recordFence && entry.id.startsWith(`${task.job}:`))
          .map((entry) => ({ ...entry, state: 'confirmed' })),
      );
      // A patch is promoted only after the unchanged task goal and host readback pass.
      const workflow = [...new Set([...plan, ...used])];
      if (pending.length || !equal(catalog.workflows[task.key], workflow)) {
        catalog.repairs.push(...pending);
        catalog.workflows[task.key] = workflow;
        await this.save(catalog);
      }
      return {
        status: 'completed',
        actions: execution.actions,
        skipped,
        repairs,
        capabilities: used,
        plan,
        planSource,
        trace: execution.trace,
      };
    } catch (error) {
      const uncertain = !!(
        error instanceof UncertainEffect ||
        execution?.uncertain ||
        execution?.effectAttempts ||
        execution?.trace.some((step) => step.dispatched && step.error)
      );
      if (uncertain && recordFence && execution?.trace.some((step) => step.dispatched))
        await journal.put({
          key: hash([recordFence, task.job, 'unconfirmed']),
          id: `${task.job}:unconfirmed`,
          label: recordFence,
          state: 'unknown',
          revision: 1,
          at: new Date().toISOString(),
          note: error instanceof Error ? error.message : String(error),
        });
      return {
        status: uncertain ? 'uncertain' : 'failed',
        actions: execution?.actions ?? 0,
        skipped,
        repairs,
        capabilities: used,
        plan,
        planSource,
        trace: execution?.trace ?? [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await release();
    }
  }
}
