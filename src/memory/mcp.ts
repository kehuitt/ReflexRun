import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentBridge, BatchBridge, type BatchNotice, type Notice } from './gateway.js';
import { BrowserHost } from './browser.js';
import { ExperienceStore } from './store.js';
import { actionSchema, checkSchema, locator } from './action-schema.js';
import { settleMemoryBatch } from './batch.js';
import { readRecord, type ReadbackPlan } from './readback.js';
import type { Action, Check, FactPlan } from './types.js';
import type { Policy } from '../types.js';

const reply = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});
const fact = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const policySchema = z.object({
  revision: z.number().int().positive(),
  rules: z.array(
    z.object({
      field: z.string(),
      op: z.enum(['eq', 'lte', 'gte', 'in', 'not-in']),
      value: z.union([fact, z.array(fact)]),
    }),
  ),
});
const source = z.object({
  target: locator.optional(),
  from: z.enum(['text', 'value']).optional(),
  pattern: z.string().optional(),
  parse: z.enum(['text', 'number', 'distance', 'money', 'boolean']).optional(),
});
const identity = source.extend({ expected: z.json() });
const factsSchema = z.object({
  identity: identity.optional(),
  fields: z.record(z.string(), source),
});
const readbackSchema = z.object({
  url: z.string(),
  identity,
  fields: z.record(z.string(), identity),
});
const verification = z.enum(['task', 'attempt', 'batch', 'readback']);
const composition = z.object({
  goal: checkSchema,
  parts: z
    .array(
      z.object({
        experience: z.string(),
        segment: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        requires: checkSchema,
        ensures: checkSchema,
      }),
    )
    .min(1),
});
const parameterCandidates = z
  .array(z.object({ input: z.string(), step: z.number().int().nonnegative(), path: z.string() }))
  .max(32);

export function registerMemoryTools(
  server: McpServer,
  config: { memory: string; context(): Promise<BrowserContext> },
) {
  const store = new ExperienceStore(config.memory);
  const sessions = new Map<string, { bridge: AgentBridge; page: Page; mode: Notice['mode'] }>();
  const reportedLearningFailures = new Set<string>();
  let activePolicy: Policy | undefined,
    activeBatch: { id: string; bridge: BatchBridge; page: Page } | undefined;
  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error('Unknown Computer Use task session');
    return s;
  };
  const answer = (id: string, notice: Notice) => {
    session(id).mode = notice.mode;
    return reply({ session: id, ...notice });
  };
  const waitForCompleted = async () => {
    for (const [id, s] of sessions) {
      if (s.mode !== 'done') continue;
      const result = await s.bridge.waitForLearning();
      if (result.learning === 'failed' && !reportedLearningFailures.has(id)) {
        reportedLearningFailures.add(id);
        throw new Error(
          `Task completed, but experience processing failed: ${result.learningError}`,
        );
      }
    }
  };
  const closeBatch = async (id: string) => {
    if (activeBatch?.id !== id) return;
    const { page } = activeBatch;
    activeBatch = undefined;
    await page.close();
  };
  const batchAnswer = async (id: string, notice: BatchNotice) => {
    if (notice.mode === 'done') await closeBatch(id);
    return reply({
      session: id,
      ...notice,
      ...(notice.mode === 'done' && notice.batch ? notice.batch : {}),
    });
  };
  const reader = (
    template: ReadbackPlan | undefined,
    inputs: import('./types.js').Inputs,
    scopes: string[],
  ) =>
    template
      ? async () => {
          const page = await (await config.context()).newPage();
          try {
            return await readRecord(new BrowserHost(page), template, inputs, scopes);
          } finally {
            await page.close();
          }
        }
      : undefined;
  server.registerTool(
    'reflex_task',
    {
      description:
        'Memory layer for Computer Use. No site map or demonstration needed. On a memory hit, executes the whole learned task. On a miss, returns live UI targets: use reflex_act as your normal Computer Use tool, then reflex_complete once the task succeeds. Exploratory and successful paths are persisted automatically. On drift returns a bounded repair request to the original agent.',
      inputSchema: {
        url: z.string().url(),
        key: z.string().min(1),
        job: z.string().min(1),
        inputs: z.record(z.string(), z.json()),
        constraints: z.json().optional(),
        allowedScopes: z.array(z.string()).optional(),
        verification: verification.default('task'),
        readback: readbackSchema.optional(),
        compose: composition.optional(),
        guardInputs: z.array(z.string()).optional(),
        learn: z.boolean().optional(),
      },
    },
    async (input) => {
      if (activeBatch)
        throw new Error(
          'Finish the active batch before opening another task on its shared browser',
        );
      await waitForCompleted();
      for (const [id, s] of sessions)
        if (s.mode === 'done' && sessions.size >= 16) {
          await s.page.close();
          sessions.delete(id);
          reportedLearningFailures.delete(id);
        }
      if (sessions.size >= 16)
        throw new Error('Complete or cancel the pending task sessions first');
      const page = await (await config.context()).newPage();
      await page.goto(input.url);
      const scopes = input.allowedScopes ?? [new URL(input.url).origin];
      const bridge = new AgentBridge(new BrowserHost(page), store, {
        ...input,
        readback: reader(input.readback, input.inputs, scopes),
      });
      const id = randomUUID();
      sessions.set(id, { bridge, page, mode: 'explore' });
      return answer(id, await bridge.start());
    },
  );
  server.registerTool(
    'reflex_observe',
    {
      description:
        'Read the current visible UI of an exploring or changed task. This is a normal Computer Use observation, not a recording mode.',
      inputSchema: { session: z.string() },
    },
    async ({ session: id }) => reply(await session(id).bridge.observe()),
  );
  server.registerTool(
    'reflex_act',
    {
      description:
        'Perform a normal Computer Use action. Supports input, keys, checks, selects, uploads, drag, navigation and clicks. A live target ref is grounded automatically; no site-specific selectors are required. Prefer input: parameterName instead of a literal value, especially when two parameters currently have the same value. Task inputs are bound rather than saved literally.',
      inputSchema: { session: z.string(), action: actionSchema },
    },
    async ({ session: id, action }) => reply(await session(id).bridge.act(action as Action)),
  );
  server.registerTool(
    'reflex_complete',
    {
      description:
        'Normal completion hook: supply the UI goal and optionally a reusable fact extraction plan, applicability condition, or candidate parameter bindings for study.',
      inputSchema: {
        session: z.string(),
        goal: checkSchema,
        factPlan: factsSchema.optional(),
        applicability: checkSchema.optional(),
        parameterCandidates: parameterCandidates.optional(),
      },
    },
    async ({ session: id, goal, factPlan, applicability, parameterCandidates }) =>
      answer(
        id,
        await session(id).bridge.complete(goal as Check, {
          factPlan: factPlan as FactPlan,
          applicability: applicability as Check,
          parameterCandidates,
        }),
      ),
  );
  server.registerTool(
    'reflex_wait',
    {
      description:
        'Wait for local experience processing after a task is verified. Performs no UI actions. Returns final learning status, errors and measured timings.',
      inputSchema: { session: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ session: id }) => reply(await session(id).bridge.waitForLearning()),
  );
  server.registerTool(
    'reflex_study',
    {
      description:
        'Inspect aligned verified examples and unresolved workflow candidates without dispatching actions.',
      inputSchema: { key: z.string(), scope: z.string() },
    },
    async ({ key, scope }) => reply(await store.study(key, scope)),
  );
  server.registerTool(
    'reflex_repair',
    {
      description:
        'Patch a changed task or the representative item of a paused batch. A batch reuses the candidate immediately for remaining items; final reconciliation gates long-term promotion. Cannot expand the effect boundary.',
      inputSchema: { session: z.string(), actions: z.array(actionSchema).max(20).nullable() },
    },
    async ({ session: id, actions }) =>
      activeBatch?.id === id
        ? batchAnswer(id, await activeBatch.bridge.patch(actions as Action[] | null))
        : answer(id, await session(id).bridge.patch(actions as Action[] | null)),
  );
  server.registerTool(
    'reflex_memories',
    {
      description:
        'List persistent, parameterized experiences. This does not expose typed input values or hidden model reasoning.',
      inputSchema: { key: z.string().optional() },
    },
    async ({ key }) =>
      reply(
        (await store.list())
          .filter((m) => !key || m.key === key)
          .map((m) => ({
            id: m.id,
            parent: m.parent,
            key: m.key,
            scope: m.scope,
            surface: m.surface,
            inputs: m.requiredInputs,
            guardInputs: Object.keys(m.when ?? {}),
            steps: m.steps.length,
            pruned: m.eliminatedActions,
            createdAt: m.createdAt,
          })),
      ),
  );
  server.registerTool(
    'reflex_batch',
    {
      description:
        'Execute a whole queue using an experience learned by reflex_task. One bounded authorization envelope, live preferences, failed items continue, durable resume. Results remain attempted until one final host audit; no success claim is inferred from clicks. The original agent can discover queue items from reflex_observe collections without a hand-written site template.',
      inputSchema: {
        url: z.string().url(),
        id: z.string().min(1),
        operation: z.string(),
        policy: policySchema,
        verification: z.enum(['attempt', 'batch', 'readback']).default('batch'),
        factPlan: factsSchema.optional(),
        fixedFacts: z.record(z.string(), fact).optional(),
        readback: readbackSchema.optional(),
        maxItems: z.number().int().min(1).max(500).default(100),
        items: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              inputs: z.record(z.string(), z.json()),
              facts: z.record(z.string(), fact),
            }),
          )
          .max(500),
      },
    },
    async (input) => {
      if (activeBatch || [...sessions.values()].some((s) => s.mode !== 'done'))
        throw new Error(
          'Finish the active exploration/repair before using its experience in a batch',
        );
      await waitForCompleted();
      const page = await (await config.context()).newPage();
      await page.goto(input.url);
      activePolicy = input.policy;
      const scopes = [new URL(input.url).origin];
      const bridge = new BatchBridge(new BrowserHost(page), store, {
        ...input,
        factPlan: input.factPlan as FactPlan,
        policy: () => activePolicy!,
        readback: input.readback
          ? (item) => reader(input.readback, item.inputs, scopes)!()
          : undefined,
      });
      const id = randomUUID();
      activeBatch = { id, bridge, page };
      return batchAnswer(id, await bridge.start());
    },
  );
  server.registerTool(
    'reflex_batch_policy',
    {
      description:
        'Change preferences of the active learned batch with a newer revision. Local rules are checked before the next effect; there is no per-item model deliberation.',
      inputSchema: { policy: policySchema },
    },
    async ({ policy }) => {
      if (!activeBatch || !activePolicy || policy.revision <= activePolicy.revision)
        throw new Error('An active batch and a newer policy revision are required');
      activePolicy = policy;
      return reply({ revision: policy.revision });
    },
  );
  server.registerTool(
    'reflex_settle_batch',
    {
      description:
        'After the original agent checks the final history/result page once, reconcile pending items. Provide the observed audit source. Unreported items remain unknown; this never dispatches or retries an action.',
      inputSchema: {
        id: z.string(),
        source: z.string().min(1),
        outcomes: z.array(z.object({ id: z.string(), status: z.enum(['confirmed', 'rejected']) })),
      },
    },
    async ({ id, source, outcomes }) =>
      reply(
        await settleMemoryBatch(store, id, new Map(outcomes.map((r) => [r.id, r.status])), source),
      ),
  );
  server.registerTool(
    'reflex_cancel',
    {
      description:
        'Cancel a pending experience task or the active batch. Dispatched effects may finish and remain available for reconciliation.',
      inputSchema: { session: z.string().optional() },
    },
    async ({ session: id }) => {
      const batch = activeBatch;
      if (id && batch?.id !== id) {
        const s = session(id);
        s.bridge.cancel();
        try {
          await s.bridge.waitForLearning();
        } finally {
          s.mode = 'done';
        }
      } else if (batch) {
        batch.bridge.cancel();
        try {
          await batch.bridge.waitForCompletion();
        } finally {
          await closeBatch(batch.id);
        }
      }
      return reply({ cancellationRequested: true });
    },
  );
  return {
    async close() {
      const batch = activeBatch?.bridge;
      batch?.cancel();
      for (const s of sessions.values()) s.bridge.cancel();
      await Promise.allSettled([
        ...[...sessions.values()].map((s) => s.bridge.waitForLearning()),
        batch?.waitForCompletion(),
      ]);
    },
  };
}
