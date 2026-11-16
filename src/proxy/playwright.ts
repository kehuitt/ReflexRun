import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import { elementFor, observation, setAt } from '../memory/compiler.js';
import type {
  Action,
  FactSource,
  Host,
  Intent,
  Json,
  Observation,
  Target,
} from '../memory/types.js';

export type NativeCall = { name: string; arguments: Record<string, Json> };
export type ToolPort = {
  callTool(call: NativeCall): Promise<CallToolResult>;
  listTools(): Promise<{ tools: Tool[] }>;
};
export type ProxyTiming = {
  stage: 'upstream' | 'authorization' | 'parse' | 'translate';
  tool: string;
  startedMs: number;
  endedMs: number;
  elapsedMs: number;
  /** Translate may include upstream reads; leaf stages must not be added to it. */
  inclusive: boolean;
};
export type ProxyOptions = { literalText?: boolean; onTiming?: (event: ProxyTiming) => void };
export type Authorize = (
  call: NativeCall,
  phase: 'capture' | 'replay' | 'passthrough',
) => boolean | Promise<boolean>;
const body = (result: CallToolResult) =>
  result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const refPattern = /^(?:f\d+)?e\d+$/;
const replayable = new Set([
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_navigate',
  'browser_navigate_back',
  'browser_tabs',
  'browser_file_upload',
  'browser_handle_dialog',
  'browser_wait_for',
]);

/** Full upstream snapshots are normalized without attaching a second browser or changing pages. */
export function fromPlaywrightSnapshot(text: string): Observation {
  const url = text.match(/^- Page URL: (.+)$/m)?.[1] ?? 'about:blank';
  const title = text.match(/^- Page Title: (.*)$/m)?.[1] ?? '';
  const elements: Observation['elements'] = [];
  const stack: {
    indent: number;
    role: string;
    name: string;
    key?: string;
    identity?: string;
    identityLabels?: string[];
    frame?: string;
    element?: Observation['elements'][number];
  }[] = [];
  const frameCounts = new Map<string, number>();
  const groups = new Map<Observation['elements'][number], (typeof stack)[number]>();
  const countersByControl = new Map<Observation['elements'][number], string[]>();
  for (const line of text.split('\n')) {
    let node = line;
    // YAML quotes an entire node when its accessible name contains ": ".
    const scalar = line.match(/^(\s*-\s+)('(?:[^']|'')*'|"(?:\\.|[^"\\])*")(:.*)?$/);
    if (scalar) {
      try {
        const value = scalar[2].startsWith("'")
          ? scalar[2].slice(1, -1).replace(/''/g, "'")
          : JSON.parse(scalar[2]);
        node = scalar[1] + value + (scalar[3] ?? '');
      } catch {
        continue;
      }
    }
    const match = node.match(/^(\s*)-\s+([a-z][\w-]*)(?:\s+("(?:\\.|[^"\\])*"))?(.*)$/);
    if (!match) continue;
    const [, spaces, role, quoted, tail] = match;
    while (stack.length && stack.at(-1)!.indent >= spaces.length) stack.pop();
    let name = role;
    if (quoted) {
      try {
        name = JSON.parse(quoted);
      } catch {
        name = quoted.slice(1, -1);
      }
    }
    const group = [...stack]
      .reverse()
      .find((s) => ['row', 'listitem', 'article', 'listbox'].includes(s.role));
    if (group && !group.key && ['cell', 'rowheader', 'heading', 'link'].includes(role) && quoted)
      group.key = name;
    if (group && quoted && ['checkbox', 'radio', 'rowheader', 'heading', 'link'].includes(role))
      (group.identityLabels ??= []).push(name);
    if (group?.role === 'listbox' && quoted && ['textbox', 'searchbox'].includes(role))
      group.key = name;
    const ref = tail.match(/\[ref=([^\]]+)\]/)?.[1];
    let element: Observation['elements'][number] | undefined;
    if (ref) {
      const frames = stack.flatMap((s) => (s.frame ? [s.frame] : []));
      element = {
        ref,
        role,
        name,
        locator: { role, name, ...(frames.length ? { frames } : {}) },
        disabled: tail.includes('[disabled]'),
        required: tail.includes('[required]'),
        ...(['checkbox', 'radio'].includes(role)
          ? { value: String(tail.includes('[checked]')) }
          : tail.match(/:\s*(.*)$/)
            ? { value: tail.match(/:\s*(.*)$/)![1] }
            : {}),
      };
      elements.push(element);
      if (group) groups.set(element, group);
    }
    // A named count child is evidence; an arbitrary number in an action name is not.
    if (/^(?:unread|unseen|new)\s+(?:messages?|notifications?|alerts?)(?:\s+count)?$/i.test(name)) {
      const count = tail.match(/:\s*"?(\d+(?:,\d{3})*)"?\s*$/)?.[1];
      const control = [...stack]
        .reverse()
        .find((parent) => ['button', 'link', 'tab', 'menuitem'].includes(parent.role))?.element;
      if (count && control)
        countersByControl.set(control, [...(countersByControl.get(control) ?? []), count]);
    }
    const parent = stack.flatMap((s) => (s.frame ? [s.frame] : [])).join('/');
    const frame = role === 'iframe' ? `snapshot-frame-${frameCounts.get(parent) ?? 0}` : undefined;
    if (frame) frameCounts.set(parent, (frameCounts.get(parent) ?? 0) + 1);
    stack.push({ indent: spaces.length, role, name, element, ...(frame ? { frame } : {}) });
  }
  const containers = [...new Set(groups.values())];
  const repeatedKeys = new Set(
    containers
      .filter(
        (group) =>
          group.key &&
          containers.filter((other) => other.role === group.role && other.key === group.key)
            .length > 1,
      )
      .map((group) => `${group.role}:${group.key}`),
  );
  for (const group of containers) {
    if (!group.key || !repeatedKeys.has(`${group.role}:${group.key}`)) continue;
    const identity = group.identityLabels?.find(
      (label) =>
        containers.filter(
          (other) => other.role === group.role && other.identityLabels?.includes(label),
        ).length === 1,
    );
    if (identity) group.identity = identity;
  }
  for (const [element, group] of groups) {
    if (group.identity)
      element.locator.within = `snapshot:identity:${group.role}:${group.identity}`;
    else if (group.key) element.locator.within = `snapshot:${group.role}:${group.key}`;
  }
  for (const [control, counts] of countersByControl) {
    if (counts.length !== 1) continue;
    const suffix = [` ${counts[0]}`, ` (${counts[0]})`, ` [${counts[0]}]`].find((text) =>
      control.name.endsWith(text),
    );
    const name = suffix ? control.name.slice(0, -suffix.length).trim() : '';
    // Only decorative counts on clear navigation labels can vary automatically.
    // Business quantities (for example Delete 3 or Approve 3) remain exact.
    const words = name.replace(/^[^\p{L}\p{N}]+/u, '');
    if (!/^(?:(?:back|return)\s+to\b|(?:home|inbox|notifications?)\b)/i.test(words)) continue;
    const { name: _name, index: _index, ...context } = control.locator;
    control.alternatives = [{ ...context, nameIncludes: name }];
  }
  const signatures = new Map<string, number>();
  for (const e of elements) {
    const key = JSON.stringify(e.locator);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  const counters = new Map<string, number>();
  for (const e of elements) {
    const key = JSON.stringify(e.locator);
    if (signatures.get(key)! > 1) {
      e.locator.index = counters.get(key) ?? 0;
      counters.set(key, e.locator.index + 1);
    }
  }
  return observation({
    surface: 'web',
    scope: url === 'about:blank' ? url : new URL(url).origin,
    url,
    title,
    text,
    elements,
  });
}

/** Reuses the original MCP connection. Replayed calls keep upstream tool names and argument shapes. */
export class PlaywrightMcpHost implements Host {
  id = 'playwright-mcp-proxy';
  readonly capabilities = ['tool', 'navigate', 'click', 'fill'] as const;
  phase: 'capture' | 'replay' = 'capture';
  lastResult?: CallToolResult;
  private state?: Observation;
  private dirty = true;
  private routeChangedAt = -Infinity;
  private modal = false;
  private tools = new Map<string, Tool>();
  private tabs: { index: number; current: boolean; title: string; url: string }[] = [];
  private aliases = new Map<string, number>();
  private created = 0;
  private grants = new Set<string>();
  constructor(
    readonly port: ToolPort,
    readonly authorize?: Authorize,
    readonly options: ProxyOptions = {},
  ) {}
  private report(stage: ProxyTiming['stage'], tool: string, startedMs: number) {
    const endedMs = performance.now();
    this.options.onTiming?.({
      stage,
      tool,
      startedMs,
      endedMs,
      elapsedMs: endedMs - startedMs,
      inclusive: stage === 'translate',
    });
  }
  private async timed<T>(stage: ProxyTiming['stage'], tool: string, run: () => Promise<T>) {
    const at = performance.now();
    try {
      return await run();
    } finally {
      this.report(stage, tool, at);
    }
  }
  private authorized(call: NativeCall, phase: Parameters<Authorize>[1]) {
    return this.authorize
      ? this.timed('authorization', call.name, async () => this.authorize!(call, phase))
      : Promise.resolve(true);
  }
  private dispatch(call: NativeCall) {
    return this.timed('upstream', call.name, () => this.port.callTool(call));
  }
  async initialize() {
    const { tools } = await this.timed('upstream', 'tools/list', () => this.port.listTools());
    for (const tool of tools) this.tools.set(tool.name, tool);
    return tools;
  }
  reset() {
    this.created = 0;
    this.aliases.clear();
    this.grants.clear();
  }
  private update(result: CallToolResult) {
    const at = performance.now();
    try {
      this.parseUpdate(result);
    } finally {
      this.report('parse', 'snapshot/result', at);
    }
  }
  private parseUpdate(result: CallToolResult) {
    const text = body(result);
    if (text.includes('### Open tabs') || /- \d+:/.test(text)) {
      this.tabs = [...text.matchAll(/^- (\d+): (?:(\(current\)) )?\[([^\]]*)\]\((.*)\)$/gm)].map(
        (m) => ({ index: Number(m[1]), current: !!m[2], title: m[3], url: m[4] }),
      );
    }
    if (/file chooser|dialog.*open/i.test(text) && text.includes('### Modal state'))
      this.modal = true;
    const section = text
      .split(/^### Snapshot[ \t]*\r?$/m)[1]
      ?.split(/^### /m)[0]
      .trim();
    const fenced = section?.match(/^```(?:yaml)?\r?\n([\s\S]*?)```$/);
    const yaml = (fenced?.[1] ?? section)?.trim();
    const inline = (fenced && !yaml) || /^-\s+(?:[a-z][\w-]*(?=[:\s]|$)|['"])/.test(yaml ?? '');
    if (inline && !text.includes('<changed>') && !text.includes('<removed>')) {
      const state = fromPlaywrightSnapshot(text);
      if (this.state && this.state.url !== state.url) this.routeChangedAt = performance.now();
      this.state = state;
      this.dirty = false;
    } else this.dirty = true;
  }
  async forward(call: NativeCall, phase: 'capture' | 'replay' | 'passthrough' = 'passthrough') {
    if (this.authorize && !(await this.authorized(call, phase)))
      throw new Error('The original host denied this tool call');
    const result = await this.dispatch(call);
    this.lastResult = result;
    this.update(result);
    return result;
  }
  async observe(options: { fresh?: boolean } = {}) {
    if ((!this.state || this.dirty || options.fresh) && !this.modal) {
      const result = await this.forward({ name: 'browser_snapshot', arguments: {} });
      if (result.isError) throw new Error(body(result));
    }
    if (!this.state || (this.dirty && !this.modal))
      throw new Error('Upstream browser has no usable inline snapshot');
    return this.state;
  }
  async observeUntil(
    ready: (state: Observation) => boolean,
    action: Action,
    initial?: Observation,
  ) {
    const editing =
      ['fill', 'type', 'select', 'check'].includes(action.kind) ||
      ['browser_type', 'browser_fill_form', 'browser_select_option'].includes(action.tool ?? '');
    const deadline = performance.now() + 500;
    let state =
      initial && initial === this.state && !this.dirty && !this.modal
        ? initial
        : await this.observe({ fresh: true });
    for (;;) {
      const now = performance.now();
      const targetReady = ready(state);
      // Some newly mounted editors are actionable before they accept writes. Browser
      // snapshots cannot prove internal readiness, so bound that settling time per route.
      const editorWait = editing ? this.routeChangedAt + 250 - now : 0;
      if (targetReady && editorWait <= 0) return state;
      if (now >= deadline || this.modal) {
        if (targetReady) throw new Error('The editing surface did not settle before dispatch');
        return state;
      }
      await delay(Math.min(deadline - now, targetReady ? editorWait : 25));
      state = await this.observe({ fresh: true });
    }
  }
  async readField(source: FactSource) {
    const state = await this.observe({ fresh: true });
    if (!source.target) return state.text;
    const e = elementFor(source.target, state);
    return e ? (source.from === 'value' ? (e.value ?? null) : e.name) : null;
  }
  isReadOnly(call: NativeCall) {
    return (
      call.name !== 'browser_wait_for' &&
      (this.tools.get(call.name)?.annotations?.readOnlyHint === true ||
        (call.name === 'browser_tabs' && call.arguments.action === 'list'))
    );
  }
  private async tabList() {
    const result = await this.forward({ name: 'browser_tabs', arguments: { action: 'list' } });
    if (result.isError) throw new Error(body(result));
  }
  async translate(call: NativeCall): Promise<Action> {
    return this.timed('translate', call.name, () => this.translateCall(call));
  }
  private async translateCall(call: NativeCall): Promise<Action> {
    if (!replayable.has(call.name))
      throw new Error(`This native tool is forwarded but is not replayable: ${call.name}`);
    const state = await this.observe();
    const bindings: Record<string, Target> = {},
      values: string[] = [];
    const walk = (value: Json, path: string) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i)));
      else if (value && typeof value === 'object')
        for (const [key, v] of Object.entries(value)) {
          const next = path ? `${path}.${key}` : key;
          if (
            ['target', 'ref', 'startRef', 'endRef', 'startTarget', 'endTarget'].includes(key) &&
            typeof v === 'string'
          ) {
            const element = state.elements.find((e) => e.ref === v);
            if (element) bindings[next] = element.locator;
            else if (refPattern.test(v))
              throw new Error(`Unknown upstream snapshot reference ${v}`);
            else
              throw new Error(
                'CSS targets need an observed reference before this task can be learned',
              );
          } else walk(v, next);
        }
    };
    walk(call.arguments, '');
    if (call.name === 'browser_type') values.push('text');
    if (call.name === 'browser_fill_form')
      for (let i = 0; i < (call.arguments.fields as Json[]).length; i++)
        values.push(`fields.${i}.value`);
    if (call.name === 'browser_select_option') values.push('values');
    if (call.name === 'browser_file_upload' && call.arguments.paths) values.push('paths');
    if (typeof call.arguments.url === 'string') values.push('url');
    let tab: Action['tab'], createsTab: string | undefined;
    if (call.name === 'browser_tabs') {
      await this.tabList();
      if (call.arguments.action === 'new') createsTab = 'created-' + ++this.created;
      else if (['select', 'close'].includes(String(call.arguments.action))) {
        const current = this.tabs.find((t) =>
          call.arguments.index === undefined ? t.current : t.index === call.arguments.index,
        );
        if (!current) throw new Error('The requested upstream tab does not exist');
        const alias = [...this.aliases].find(([, index]) => index === current.index)?.[0];
        tab = alias ? { alias } : { url: current.url, title: current.title };
      }
    }
    const target = Object.values(bindings)[0];
    // Treat input tools as possible writes too: an existing site may autosave.
    const effect = ![
      'browser_navigate',
      'browser_navigate_back',
      'browser_tabs',
      'browser_wait_for',
      'browser_hover',
    ].includes(call.name);
    return {
      kind: 'tool',
      tool: call.name,
      args: structuredClone(call.arguments),
      bindings,
      valuePaths: values,
      effect,
      ...(target ? { target } : {}),
      ...(typeof call.arguments.url === 'string' ? { url: call.arguments.url } : {}),
      ...(tab ? { tab } : {}),
      ...(createsTab ? { createsTab } : {}),
    };
  }
  acceptsIntent(intent: Intent) {
    return intent.kind === 'click'
      ? this.tools.has('browser_click')
      : !!this.options.literalText && this.tools.has('browser_type');
  }
  projectIntent(action: Action): Intent | undefined {
    const args = action.args,
      target = action.target;
    if (!args || !target?.role || !target.name || Object.keys(action.bindings ?? {}).length !== 1)
      return;
    const refKey = Object.keys(action.bindings!)[0];
    if (refKey !== 'target') return;
    const semantic = { role: target.role, name: target.name };
    if (
      action.tool === 'browser_click' &&
      Object.keys(args).every((key) =>
        ['target', 'element', 'doubleClick', 'button', 'modifiers'].includes(key),
      ) &&
      !args.doubleClick &&
      (!args.button || args.button === 'left') &&
      (!args.modifiers || (Array.isArray(args.modifiers) && !args.modifiers.length))
    )
      return { kind: 'click', target: semantic };
    if (
      this.options.literalText &&
      action.tool === 'browser_type' &&
      Object.keys(args).every((key) =>
        ['target', 'element', 'text', 'submit', 'slowly'].includes(key),
      ) &&
      !args.slowly &&
      typeof args.text === 'string'
    )
      return {
        kind: 'fill',
        target: semantic,
        value: args.text,
        input: action.argInputs?.text,
        submit: args.submit === true,
      };
  }
  private async native(action: Action): Promise<NativeCall> {
    const state = await this.observe();
    if (action.kind === 'click' || action.kind === 'fill') {
      if (!this.acceptsIntent(action as Intent))
        throw new Error('The upstream does not expose this semantic action');
      const target = elementFor(action.target, state);
      if (!target || target.disabled) throw new Error('Native target changed or is ambiguous');
      const args = { target: target.ref, element: target.name };
      return action.kind === 'click'
        ? { name: 'browser_click', arguments: args }
        : {
            name: 'browser_type',
            arguments: {
              ...args,
              text: String(action.value ?? ''),
              ...(action.submit ? { submit: true } : {}),
            },
          };
    }
    if (!action.tool || !replayable.has(action.tool))
      throw new Error('A replay cannot add an unsupported native tool');
    const args = structuredClone(action.args ?? {});
    for (const [path, target] of Object.entries(action.bindings ?? {})) {
      const e = elementFor(target, state);
      if (!e) throw new Error('Native target changed or is ambiguous');
      setAt(args, path, e.ref);
    }
    if (action.tab) {
      await this.tabList();
      const matches = action.tab.alias
        ? this.tabs.filter((t) => t.index === this.aliases.get(action.tab!.alias!))
        : this.tabs.filter((t) => t.url === action.tab!.url && t.title === action.tab!.title);
      if (matches.length !== 1) throw new Error('Native tab identity is missing or ambiguous');
      args.index = matches[0].index;
    }
    return { name: action.tool, arguments: args };
  }
  async authorizeEffect(action: Action) {
    if (!this.authorize) return true;
    const call = await this.native(action),
      key = JSON.stringify(call);
    if (this.grants.has(key)) return true;
    if (!(await this.authorized(call, this.phase))) return false;
    this.grants.add(key);
    return true;
  }
  async act(action: Action) {
    if (action.kind === 'navigate') {
      const result = await this.forward(
        { name: 'browser_navigate', arguments: { url: action.url! } },
        this.phase,
      );
      if (result.isError) throw new Error(body(result));
      return;
    }
    const call = await this.native(action);
    const key = JSON.stringify(call);
    if (this.authorize && !this.grants.has(key) && !(await this.authorized(call, this.phase)))
      throw new Error('The original host denied replay');
    this.grants.delete(key);
    const result = await this.dispatch(call);
    this.lastResult = result;
    this.update(result);
    if (['browser_file_upload', 'browser_handle_dialog'].includes(call.name)) {
      this.modal = false;
      this.dirty = true;
    }
    if (result.isError) throw new Error(body(result));
    if (action.createsTab) {
      await this.tabList();
      const current = this.tabs.find((t) => t.current);
      if (!current) throw new Error('New tab identity is unavailable');
      this.aliases.set(action.createsTab, current.index);
    }
    if (call.name === 'browser_tabs' && call.arguments.action === 'close') {
      const index = Number(call.arguments.index);
      for (const [alias, old] of this.aliases)
        if (old === index) this.aliases.delete(alias);
        else if (old > index) this.aliases.set(alias, old - 1);
    }
    this.lastResult = result; // Internal tab-list reads never replace the original tool's response.
  }
}
