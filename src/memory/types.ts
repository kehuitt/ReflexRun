export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Inputs = Record<string, Json>;
export type Surface = 'web' | 'native' | 'visual' | 'tool';
export type Locator = {
  role?: string;
  name?: string;
  /** Match a task-provided identity within a changing collection-entry name, without an ordinal. */
  nameIncludes?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  css?: string;
  text?: string;
  index?: number;
  frames?: string[];
  within?: string;
};
export type Target = Locator & { ref?: string };
export type Element = {
  ref: string;
  role: string;
  name: string;
  locator: Locator;
  value?: string;
  sensitive?: boolean;
  disabled?: boolean;
  type?: string;
  required?: boolean;
  invalid?: boolean;
  state?: Record<string, string | boolean>;
  alternatives?: Locator[];
  options?: { label: string; value: string }[];
  group?: string;
  box?: { x: number; y: number; width: number; height: number };
};
export type Observation = {
  surface: Surface;
  scope: string;
  url?: string;
  title: string;
  text: string;
  elements: Element[];
  stateKey: string;
  layoutKey: string;
  collections?: {
    ref: string;
    items: { key: string; title: string; text: string; href?: string; actions: string[] }[];
  }[];
};
export type ActionKind =
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'select'
  | 'check'
  | 'upload'
  | 'hover'
  | 'scroll'
  | 'drag'
  | 'navigate'
  | 'wait'
  | 'tool';
export type Action = {
  kind: ActionKind;
  target?: Target;
  to?: Target;
  value?: Json;
  url?: string;
  /** Explicit binding when two task inputs have the same first-run value. */
  input?: string;
  /** Fill the control and activate Enter as one recorded effect boundary. */
  submit?: boolean;
  tool?: string;
  args?: Record<string, Json>;
  /** Mark autosave inputs and other host-specific writes true to apply policy and intent guards. */
  effect?: boolean;
  bindings?: Record<string, Target>;
  valuePaths?: string[];
  argInputs?: Record<string, string>;
  tab?: { alias?: string; url?: string; title?: string };
  createsTab?: string;
};
export type Check = { text?: string; urlIncludes?: string; target?: Target; equals?: Json };
export type TraceStep = {
  action: Action;
  before: Observation;
  after?: Observation;
  error?: string;
  dispatched: boolean;
  durationMs: number;
};
export type Intent = Pick<Action, 'value' | 'input' | 'submit'> & {
  kind: 'click' | 'fill';
  target: { role: string; name: string };
};
export type MemoryStep = { action: Json; intent?: Json; sourceIndex: number; effect: boolean };
export type ParameterCandidate = { input: string; step: number; path: string };
export type LearningDetails = {
  factPlan?: FactPlan;
  applicability?: Check;
  parameterCandidates?: ParameterCandidate[];
};
export type Experience = {
  format: 2;
  id: string;
  parent?: string;
  key: string;
  scope: string;
  surface: Surface;
  adapter?: string;
  createdAt: string;
  requiredInputs: string[];
  steps: MemoryStep[];
  goal: Json;
  parameters?: Record<
    string,
    { kind: 'text' | 'boolean' | 'select' | 'files'; options?: { label: string; value: string }[] }
  >;
  when?: Record<string, Json>;
  episode: string;
  exploratoryActions: number;
  eliminatedActions: number;
  capabilities: ActionKind[];
  entryUrl?: Json;
  constraints?: Json;
  factPlan?: Json;
  applicability?: Json;
  parts?: { experience: string; segment: string; start: number; end: number }[];
};
export type Composition = {
  goal: Check;
  parts: {
    experience: string;
    segment: string;
    start: number;
    end: number;
    requires: Check;
    ensures: Check;
  }[];
};
export type Verification = 'attempt' | 'batch' | 'readback';
export type Readback = { status: 'confirmed' | 'rejected' | 'unknown'; source: string };
export type FactSource = {
  target?: Locator;
  from?: 'text' | 'value';
  pattern?: string;
  parse?: 'text' | 'number' | 'distance' | 'money' | 'boolean';
};
export type FactPlan = {
  identity?: FactSource & { expected: Json };
  fields: Record<string, FactSource>;
};
export type ProvisionalExperience = {
  batch: string;
  memory: Experience;
  representativeJob: string;
  validation: 'attempt' | 'ui-postcondition' | 'readback';
  status: 'provisional' | 'promoted' | 'quarantined';
  reason?: string;
};
export type Episode = {
  format: 2;
  id: string;
  key: string;
  scope: string;
  createdAt: string;
  inputNames: string[];
  trace: Json;
  success: boolean;
  source: 'explore' | 'repair' | 'composition';
  verified?: boolean;
  parameterCandidates?: ParameterCandidate[];
};
export interface Host {
  id: string;
  capabilities: readonly ActionKind[];
  observe(options?: { fresh?: boolean }): Promise<Observation>;
  /** Read fresh state until the replay target is ready or the host's bounded wait expires. */
  observeUntil?(
    ready: (state: Observation) => boolean,
    action: Action,
    initial?: Observation,
  ): Promise<Observation>;
  readField?(source: FactSource): Promise<string | null>;
  /** Only return an intent if it preserves the native call's meaning. */
  projectIntent?(action: Action): Intent | undefined;
  acceptsIntent?(intent: Intent): boolean;
  /** A host must reject unresolved/ambiguous targets rather than choosing the first. */
  act(action: Action): Promise<void>;
}
export type Task = {
  key: string;
  inputs: Inputs;
  job: string;
  experience?: string;
  constraints?: Json;
  allowedScopes?: string[];
  /** Caller-declared branch inputs. Their current values become exact guards. */
  guardInputs?: string[];
  /** Collect another verified example through the original agent. */
  learn?: boolean;
  context?: Json;
  verification?: 'task' | Verification;
  maxActions?: number;
  maxRepairs?: number;
  batch?: string;
  factPlan?: FactPlan;
  compose?: Composition;
  readback?: () => Promise<Readback>;
  signal?: AbortSignal;
  /** Cheap live policy fence; must not call a model on the normal path. */
  beforeEffect?: (
    action: Action,
    observation: Observation,
    plan?: FactPlan,
  ) => boolean | Promise<boolean>;
};
export type AgentTools = {
  observe(options?: { fresh?: boolean }): Promise<Observation>;
  act(action: Action): Promise<Observation>;
};
export type Explorer = (context: {
  task: Task;
  tools: AgentTools;
  memories: Experience[];
}) => Promise<{ goal: Check } & LearningDetails>;
export type Repairer = (context: {
  task: Task;
  observation: Observation;
  failed: Action;
  error: string;
  experience: Experience;
  step: number;
}) => Promise<Action[] | null>;
export type MemoryEvent = {
  type: 'recall' | 'explore' | 'action' | 'repair' | 'learned' | 'reused' | 'interrupted';
  message: string;
  data?: Record<string, unknown>;
};
export type RunTimings = {
  /** Exclusive elapsed time spent reading host observations. */
  observationMs: number;
  /** Completion verification, excluding observations performed by that verification. */
  checkMs: number;
  compileMs: number;
  /** Experience/episode writes; business intent journal writes remain on the action path. */
  persistMs: number;
  /** Milestones relative to this run's monotonic start, not component durations. */
  taskReadyMs?: number;
  memoryReadyMs?: number;
};
export type MemoryResult = {
  status: 'completed' | 'attempted' | 'uncertain' | 'skipped' | 'failed';
  evidence: 'ui-postcondition' | 'readback' | 'none';
  source: 'explore' | 'memory' | 'repair' | 'composition';
  experience?: string;
  actions: number;
  hostDelegations: number;
  repairs: number;
  effectAttempts?: number;
  outcome?: Readback['status'];
  verification?: 'task' | Verification;
  readbackSource?: string;
  learning?: 'pending' | 'ready' | 'failed';
  learningError?: string;
  timings?: RunTimings;
  elapsedMs: number;
  error?: string;
};
