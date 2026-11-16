import { randomUUID, createHash } from 'node:crypto';
import type {
  Action,
  Check,
  Element,
  Experience,
  Host,
  Inputs,
  Intent,
  Json,
  Observation,
  TraceStep,
} from './types.js';

export function observation(input: Omit<Observation, 'stateKey' | 'layoutKey'>): Observation {
  const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const layout = input.elements.map((e) => [e.role, e.name, e.locator, e.disabled]);
  return {
    ...input,
    stateKey: digest([
      input.url,
      input.text,
      input.elements.map((e) => [e.role, e.name, e.value, e.state]),
    ]),
    layoutKey: digest(layout),
  };
}

/** Bind values supplied to the original agent, without saving personal values into a skill. */
export function encode(value: unknown, inputs: Inputs): Json {
  const pairs = Object.entries(inputs).filter(([, v]) => v !== null);
  const exact = pairs.filter(([, v]) => JSON.stringify(v) === JSON.stringify(value));
  if (exact.length === 1) return { $input: exact[0][0] };
  if (Array.isArray(value)) return value.map((x) => encode(x, inputs));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encode(v, inputs)]),
    );
  if (typeof value === 'string') {
    const strings = pairs
      .filter(
        ([, v]) =>
          typeof v === 'string' && v.length >= 3 && pairs.filter(([, x]) => x === v).length === 1,
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length);
    let parts: (string | { $input: string; $codec?: string })[] = [value];
    for (const [key, v] of strings) {
      const variants = [
        { text: String(v), codec: undefined },
        { text: encodeURIComponent(String(v)), codec: 'uri' },
        { text: new URLSearchParams({ x: String(v) }).toString().slice(2), codec: 'form' },
      ];
      for (const { text, codec } of variants)
        parts = parts.flatMap((part) => {
          if (typeof part !== 'string' || !part.includes(text)) return [part];
          const xs = part.split(text);
          return xs.flatMap((x, i) =>
            i ? [{ $input: key, ...(codec ? { $codec: codec } : {}) }, x] : [x],
          );
        });
    }
    return parts.some((x) => typeof x !== 'string') ? { $template: parts } : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}
export function decode(value: Json, inputs: Inputs): unknown {
  if (Array.isArray(value)) return value.map((x) => decode(x, inputs));
  if (value && typeof value === 'object') {
    if (
      typeof value.$input === 'string' &&
      Object.keys(value).every((k) => ['$input', '$codec'].includes(k))
    ) {
      if (!Object.hasOwn(inputs, value.$input)) throw new Error(`Missing input ${value.$input}`);
      const input = inputs[value.$input];
      if (value.$codec === 'uri') return encodeURIComponent(String(input));
      if (value.$codec === 'form')
        return new URLSearchParams({ x: String(input) }).toString().slice(2);
      if (value.$codec === 'string') return String(input);
      return input;
    }
    if (Array.isArray(value.$template) && Object.keys(value).length === 1)
      return value.$template.map((x) => String(decode(x, inputs))).join('');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, inputs)]));
  }
  return value;
}

export function ground(action: Action, before: Observation): Action {
  const resolve = (target: Action['target']) => {
    if (!target?.ref) return target;
    const element = before.elements.find((e) => e.ref === target.ref);
    if (!element) throw new Error(`Unknown live target ${target.ref}`);
    return { ...element.locator };
  };
  return {
    ...action,
    ...(action.target ? { target: resolve(action.target) } : {}),
    ...(action.to ? { to: resolve(action.to) } : {}),
    ...(action.bindings
      ? {
          bindings: Object.fromEntries(
            Object.entries(action.bindings).map(([k, t]) => [k, resolve(t)!]),
          ),
        }
      : {}),
  };
}
function getAt(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined),
      value,
    );
}
export function setAt(value: unknown, path: string, item: unknown): void {
  const keys = path.split('.');
  if (keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
    throw new Error('Invalid argument binding path');
  const parent = getAt(value, keys.slice(0, -1).join('.')) as Record<string, unknown> | undefined;
  if (keys.length === 1 && value && typeof value === 'object')
    (value as Record<string, unknown>)[keys[0]] = item;
  else if (parent) parent[keys.at(-1)!] = item;
  else throw new Error('Argument binding path does not exist');
}
export function bindInput(action: Action, inputs: Inputs): Action {
  if (!action.input) return action;
  if (!Object.hasOwn(inputs, action.input)) throw new Error(`Missing input ${action.input}`);
  return { ...action, value: inputs[action.input] };
}
export function validPartialName(target: NonNullable<Action['target']>): boolean {
  return (
    !!target.role &&
    typeof target.nameIncludes === 'string' &&
    target.nameIncludes.length > 0 &&
    Object.keys(target).every((key) => ['role', 'nameIncludes', 'frames', 'within'].includes(key))
  );
}
export function elementFor(target: Action['target'], state: Observation): Element | undefined {
  if (!target) return undefined;
  if (target.nameIncludes !== undefined && !validPartialName(target)) return undefined;
  const matches = state.elements.filter((e) => {
    if (target.ref) return e.ref === target.ref;
    const l = e.locator;
    if (JSON.stringify(target.frames ?? []) !== JSON.stringify(l.frames ?? [])) return false;
    if (target.within && target.within !== l.within) return false;
    if (target.nameIncludes !== undefined)
      return e.role === target.role && e.name.includes(target.nameIncludes);
    return target.label
      ? l.label === target.label
      : target.placeholder
        ? l.placeholder === target.placeholder
        : target.role
          ? e.role === target.role && (target.name === undefined || e.name === target.name)
          : target.testId
            ? l.testId === target.testId
            : target.css
              ? l.css === target.css
              : target.text
                ? e.name === target.text
                : false;
  });
  return target.index === undefined
    ? matches.length === 1
      ? matches[0]
      : undefined
    : matches[target.index];
}
// Chinese alternatives mean sign up, submit, confirm, save, send, delete, and buy.
const effectLabel =
  /\b(save|submit|send|confirm|apply|archive|approve|delete|purchase|buy)\b|\u62a5\u540d|\u63d0\u4ea4|\u786e\u8ba4|\u4fdd\u5b58|\u53d1\u9001|\u5220\u9664|\u8d2d\u4e70/;

export function isEffect(action: Action, state: Observation): boolean {
  if (action.submit) return true;
  if (action.effect !== undefined) return action.effect;
  if (action.kind === 'tool') return true;
  const el = elementFor(action.target, state);
  if (action.kind === 'press' && action.value === 'Enter') return true;
  return (
    action.kind === 'click' &&
    (el?.type === 'submit' ||
      effectLabel.test((el?.name ?? action.target?.name ?? '').toLowerCase()))
  );
}

/** Remove failed probes and effect-free loops; retain the entire exploration in its episode. */
export function successfulPath(trace: TraceStep[]): { step: TraceStep; index: number }[] {
  const path: { step: TraceStep; index: number }[] = [];
  for (const [index, step] of trace.entries()) {
    if (step.error) continue;
    path.push({ step, index });
    if (!step.after) continue;
    const loop = path.findIndex((p) => p.step.before.stateKey === step.after!.stateKey);
    const cycle = path.slice(loop);
    const navigation = cycle.some(
      (p) =>
        p.step.action.kind === 'navigate' ||
        (p.step.after?.url && p.step.after.url !== p.step.before.url),
    );
    if (
      loop >= 0 &&
      cycle.length >= 2 &&
      navigation &&
      cycle.every(
        (p) =>
          !p.step.action.effect &&
          ['navigate', 'click', 'hover', 'scroll', 'wait'].includes(p.step.action.kind),
      )
    )
      path.splice(loop);
  }
  return path;
}
function references(value: Json, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => references(v, result));
  else if (value && typeof value === 'object') {
    if (typeof value.$input === 'string') result.add(value.$input);
    Object.values(value).forEach((v) => references(v, result));
  }
  return result;
}
function projectIntent(action: Action, state: Observation, host?: Host): Intent | undefined {
  const projected = host?.projectIntent?.(action);
  const kind = projected?.kind ?? action.kind;
  if (kind !== 'click' && kind !== 'fill') return;
  const element = elementFor(action.target, state);
  if (
    !element?.name ||
    element.sensitive ||
    element.disabled ||
    element.locator.index !== undefined ||
    element.locator.within ||
    element.locator.frames?.length
  )
    return;
  const { role, name } = element;
  if (elementFor({ role, name }, state) !== element) return;
  const value = projected?.value ?? action.value;
  const input = projected?.input ?? action.input;
  return kind === 'click'
    ? { kind, target: { role, name } }
    : typeof value === 'string'
      ? {
          kind: 'fill',
          target: { role, name },
          value,
          ...(input ? { input } : {}),
          ...(projected?.submit || action.submit ? { submit: true } : {}),
        }
      : undefined;
}

export function compileExperience(args: {
  key: string;
  scope: string;
  trace: TraceStep[];
  inputs: Inputs;
  goal: Check;
  episode: string;
  parent?: string;
  entryUrl?: string;
  constraints?: Json;
  factPlan?: import('./types.js').FactPlan;
  applicability?: Check;
  host?: Host;
  guards?: Record<string, Json>;
}): Experience {
  const path = successfulPath(args.trace);
  if (!path.length) throw new Error('No successful action path to remember');
  const steps = path.map(({ step, index }) => {
    const a = step.action;
    const content = ['fill', 'type', 'upload', 'select', 'check', 'navigate'].includes(a.kind);
    if (
      content &&
      a.value !== undefined &&
      !a.input &&
      Object.values(args.inputs).filter((v) => JSON.stringify(v) === JSON.stringify(a.value))
        .length > 1
    )
      throw new Error(
        'Ambiguous input binding; annotate the action with input: the parameter name',
      );
    if (
      a.input &&
      (!Object.hasOwn(args.inputs, a.input) ||
        JSON.stringify(args.inputs[a.input]) !== JSON.stringify(a.value))
    )
      throw new Error('Explicit input binding does not match the captured value');
    if (['fill', 'type', 'upload'].includes(step.action.kind)) {
      const encoded = a.input ? { $input: a.input } : encode(step.action.value, args.inputs);
      if (!references(encoded).size)
        throw new Error(
          'Input and upload values must be supplied as task inputs, not memorized as literals',
        );
    }
    const bindLocator = (target: Action['target']) => {
      if (!target) return undefined;
      let portable = target;
      if (
        target.name &&
        ['link', 'row', 'listitem', 'heading'].includes(target.role ?? '') &&
        Object.keys(target).every((key) =>
          ['role', 'name', 'index', 'frames', 'within'].includes(key),
        )
      ) {
        const identities = Object.values(args.inputs)
          .filter(
            (value): value is string =>
              typeof value === 'string' &&
              value.length >= 3 &&
              value !== target.name &&
              target.name!.includes(value) &&
              Object.values(args.inputs).filter((other) => other === value).length === 1,
          )
          .sort((a, b) => b.length - a.length);
        const identity = identities[0];
        if (identity && identity.length !== identities[1]?.length) {
          const { name: _name, index: _index, ...context } = target;
          const candidate = { ...context, nameIncludes: identity };
          const observed = elementFor(target, step.before);
          if (observed && elementFor(candidate, step.before) === observed) portable = candidate;
        }
      }
      if (portable === target) {
        const observed = elementFor(target, step.before);
        const alternative = observed?.alternatives?.find(
          (candidate) =>
            validPartialName(candidate) && elementFor(candidate, step.before) === observed,
        );
        if (alternative) portable = alternative;
      }
      return Object.fromEntries(
        Object.entries(portable).map(([k, v]) => [
          k,
          ['name', 'nameIncludes', 'label', 'placeholder', 'text', 'css', 'within'].includes(k)
            ? encode(v, args.inputs)
            : v,
        ]),
      );
    };
    const encoded: Record<string, unknown> = { ...a };
    for (const key of ['value', 'url', 'args'] as const)
      if (
        a[key] !== undefined &&
        !(key === 'args' && a.valuePaths) &&
        !(key === 'value' && !content)
      )
        encoded[key] = encode(a[key], args.inputs);
    if (a.valuePaths) {
      encoded.args = structuredClone(a.args ?? {});
      for (const path of a.valuePaths) {
        const value = getAt(a.args, path),
          explicit = a.argInputs?.[path];
        const matches = Object.entries(args.inputs).filter(
          ([, v]) =>
            JSON.stringify(v) === JSON.stringify(value) ||
            (typeof value === 'string' &&
              ['boolean', 'number'].includes(typeof v) &&
              String(v) === value),
        );
        if (!explicit && matches.length > 1)
          throw new Error(
            `Ambiguous tool argument ${path}; bind its parameter identity before finishing`,
          );
        const key = explicit ?? matches[0]?.[0];
        if (explicit && !Object.hasOwn(args.inputs, explicit))
          throw new Error(`Missing input ${explicit}`);
        if (
          explicit &&
          JSON.stringify(args.inputs[explicit]) !== JSON.stringify(value) &&
          !(typeof value === 'string' && String(args.inputs[explicit]) === value)
        )
          throw new Error(`Tool argument ${path} does not match its explicit input`);
        const bound = key
          ? {
              $input: key,
              ...(typeof value === 'string' && typeof args.inputs[key] !== 'string'
                ? { $codec: 'string' }
                : {}),
            }
          : encode(value, args.inputs);
        if (
          !references(bound).size &&
          path !== 'url' &&
          value !== '' &&
          value !== 'true' &&
          value !== 'false'
        )
          throw new Error(`Declare tool argument ${path} as a task input before saving it`);
        setAt(encoded.args, path, bound);
      }
    }
    if (a.input) encoded.value = { $input: a.input };
    if (a.target) encoded.target = bindLocator(a.target);
    if (a.to) encoded.to = bindLocator(a.to);
    if (a.bindings)
      encoded.bindings = Object.fromEntries(
        Object.entries(a.bindings).map(([k, t]) => [k, bindLocator(t)]),
      );
    for (const path of Object.keys(a.bindings ?? {})) setAt(encoded.args, path, null); // Live reference is rebound by its original adapter.
    if (a.tab)
      encoded.tab = { ...a.tab, ...(a.tab.url ? { url: encode(a.tab.url, args.inputs) } : {}) };
    const identity = (encoded.target as Action['target'])?.nameIncludes;
    const intent = identity === undefined ? projectIntent(a, step.before, args.host) : undefined;
    // A first-run match with task content is not proof that a portable target should vary.
    const semantic =
      intent &&
      !references(encode(intent.target.name, args.inputs)).size &&
      ({
        kind: intent.kind,
        target: intent.target,
        ...(intent.kind === 'fill'
          ? { value: intent.input ? { $input: intent.input } : encode(intent.value, args.inputs) }
          : {}),
        ...(intent.submit ? { submit: true } : {}),
      } as Json | undefined);
    return {
      action: JSON.parse(JSON.stringify(encoded)) as Json,
      ...(semantic ? { intent: semantic } : {}),
      sourceIndex: index,
      effect: !!a.effect,
    };
  });
  const goal = encode(args.goal, args.inputs);
  const needed = new Set<string>();
  steps.forEach((s) => {
    references(s.action, needed);
    if (s.intent) references(s.intent, needed);
  });
  references(goal, needed);
  const entryUrl = args.entryUrl ? encode(args.entryUrl, args.inputs) : undefined;
  const constraints =
    args.constraints === undefined ? undefined : encode(args.constraints, args.inputs);
  const factPlan = args.factPlan ? encode(args.factPlan, args.inputs) : undefined;
  const applicability = args.applicability ? encode(args.applicability, args.inputs) : undefined;
  if (entryUrl !== undefined) references(entryUrl, needed);
  if (constraints !== undefined) references(constraints, needed);
  if (factPlan !== undefined) references(factPlan, needed);
  if (applicability !== undefined) references(applicability, needed);
  let when: Record<string, Json> = {};
  const parameters: NonNullable<Experience['parameters']> = {};
  for (const { step } of path) {
    const value = step.action.input
      ? { $input: step.action.input }
      : encode(step.action.value, args.inputs);
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      typeof value.$input === 'string'
    ) {
      const kind =
        step.action.kind === 'check'
          ? 'boolean'
          : step.action.kind === 'select'
            ? 'select'
            : step.action.kind === 'upload'
              ? 'files'
              : 'text';
      const options =
        kind === 'select' ? elementFor(step.action.target, step.before)?.options : undefined;
      parameters[value.$input] = { kind, ...(options ? { options } : {}) };
    }
  }
  for (const { step } of path)
    if (
      ['check', 'select'].includes(step.action.kind) &&
      step.after &&
      step.before.layoutKey !== step.after.layoutKey
    ) {
      for (const [k, v] of Object.entries(args.inputs))
        if (
          step.action.input
            ? k === step.action.input
            : JSON.stringify(v) === JSON.stringify(step.action.value)
        )
          when[k] = v;
    }
  when = { ...when, ...args.guards };
  return {
    format: 2,
    id: randomUUID(),
    parent: args.parent,
    key: args.key,
    scope: args.scope,
    surface: path[0].step.before.surface,
    createdAt: new Date().toISOString(),
    ...(args.host ? { adapter: args.host.id } : {}),
    requiredInputs: [...needed],
    parameters,
    steps,
    goal,
    episode: args.episode,
    exploratoryActions: args.trace.length,
    eliminatedActions: args.trace.length - steps.length,
    capabilities: [...new Set(path.map((p) => p.step.action.kind))],
    ...(Object.keys(when).length ? { when } : {}),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(factPlan ? { factPlan } : {}),
    ...(applicability ? { applicability } : {}),
  };
}
export function archiveTrace(trace: TraceStep[], inputs: Inputs): Json {
  const seen = new Set<string>();
  const redaction = Object.fromEntries(
    Object.entries(inputs).filter(([, v]) => {
      const key = JSON.stringify(v);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  for (const [i, { action }] of trace.entries()) {
    const values = ['fill', 'type', 'upload'].includes(action.kind)
      ? [action.value]
      : (action.valuePaths ?? []).map((path) => getAt(action.args, path));
    for (const [j, value] of values.entries()) {
      if (value !== undefined && !references(encode(value, redaction)).size)
        redaction[`redacted-unbound-${i}-${j}`] = value as Json;
    }
  }
  return encode(trace, redaction);
}
export function check(state: Observation, condition: Check): boolean {
  if (!condition.text && !condition.urlIncludes && !condition.target) return false;
  if (condition.text && !state.text.includes(condition.text)) return false;
  if (condition.urlIncludes && !state.url?.includes(condition.urlIncludes)) return false;
  if (condition.target) {
    const e = elementFor(condition.target, state);
    if (!e) return false;
    if (condition.equals !== undefined && String(condition.equals) !== e.value) return false;
  }
  return true;
}
