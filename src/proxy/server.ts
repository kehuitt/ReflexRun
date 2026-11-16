import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ExperienceStore } from '../memory/store.js';
import { ToolProxy } from './index.js';
import type { Check, Task, FactPlan, ParameterCandidate } from '../memory/types.js';
import type { Authorize, NativeCall, ToolPort } from './playwright.js';

const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});
const target = object({
  role: { type: 'string' },
  name: { type: 'string' },
  within: { type: 'string' },
  frames: { type: 'array', items: { type: 'string' } },
  index: { type: 'integer', minimum: 0 },
});
const condition = object({
  text: { type: 'string' },
  urlIncludes: { type: 'string' },
  target,
  equals: {},
});
const source = {
  target,
  from: { enum: ['text', 'value'] },
  pattern: { type: 'string' },
  parse: { enum: ['text', 'number', 'distance', 'money', 'boolean'] },
};
const factPlan = object(
  {
    identity: object({ ...source, expected: {} }, ['expected']),
    fields: { type: 'object', additionalProperties: object(source) },
  },
  ['fields'],
);
const parameterCandidates = {
  type: 'array',
  maxItems: 32,
  items: object(
    { input: { type: 'string' }, step: { type: 'integer', minimum: 0 }, path: { type: 'string' } },
    ['input', 'step', 'path'],
  ),
};
const tools: Tool[] = [
  {
    name: 'reflex_begin',
    description:
      'Task boundary for the original browser tools. On a hit, runs the learned native calls in the existing upstream session. On a miss, continue using the unchanged browser tools, then reflex_finish. No new browser/profile/page is created by this proxy.',
    inputSchema: object(
      {
        key: { type: 'string' },
        job: { type: 'string' },
        inputs: { type: 'object', additionalProperties: true },
        constraints: {},
        allowedScopes: { type: 'array', items: { type: 'string' } },
        verification: { enum: ['task', 'attempt'] },
        guardInputs: { type: 'array', items: { type: 'string' } },
        learn: { type: 'boolean' },
      },
      ['key', 'job', 'inputs'],
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'reflex_finish',
    description:
      'Declare the visible completion condition after a normal first run. Optional bindings resolve equal first-run values; factPlan and applicability retain local extraction and reuse conditions. This adds no fields to native browser calls.',
    inputSchema: object(
      {
        goal: condition,
        bindings: {
          type: 'object',
          additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
        },
        factPlan,
        applicability: condition,
        parameterCandidates,
      },
      ['goal'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'reflex_wait',
    description:
      'Wait for local experience processing after task completion. Performs no UI actions. Returns the final learning status, errors and measured timings; task success does not imply that memory is ready.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'reflex_study',
    description:
      'Inspect aligned successful experiences, evidence for input variation, and unresolved parameter, branch and repetition candidates.',
    inputSchema: object({ key: { type: 'string' }, scope: { type: 'string' } }, ['key', 'scope']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reflex_patch',
    description:
      'Repair a changed step using the original upstream {name, arguments} call format. Replays only the bounded patch and preserves the original host authorization hook.',
    inputSchema: object(
      {
        calls: {
          anyOf: [
            {
              type: 'array',
              maxItems: 20,
              items: object(
                {
                  name: { type: 'string' },
                  arguments: { type: 'object', additionalProperties: true },
                },
                ['name', 'arguments'],
              ),
            },
            { type: 'null' },
          ],
        },
      },
      ['calls'],
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'reflex_cancel',
    description:
      'Cancel the current memory task; already dispatched effects still need reconciliation.',
    inputSchema: object({}),
    annotations: { destructiveHint: false },
  },
];

/** Exposed separately so protocol tests can use the real upstream MCP server in an existing context. */
export async function createToolProxyServer(
  port: ToolPort,
  directory: string,
  authorize?: Authorize,
  options?: { literalText?: boolean },
) {
  const proxy = new ToolProxy(port, new ExperienceStore(directory), authorize, options);
  const native = await proxy.host.initialize();
  for (const tool of native)
    if (tools.some((meta) => meta.name === tool.name))
      throw new Error('Upstream tool name collides with a ReflexRun lifecycle hook');
  const server = new Server(
    { name: 'reflexrun-tool-proxy', version: '0.3.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Keep using the original browser tools. For a new reusable task, call reflex_begin with its inputs. If it returns explore, use ordinary browser tools and finish with reflex_finish. A completed task may still have learning pending: reflex_wait waits for local persistence without any UI action; the next reflex_begin also waits before reuse. A hit executes native tools locally; a changed step requests reflex_patch. Native tool descriptions and annotations are preserved. Replay is an explicit effectful tool and needs the host client approval rules.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(await port.listTools()).tools, ...tools],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    extra.signal.addEventListener('abort', () => proxy.cancel(), { once: true });
    try {
      let result: unknown;
      switch (request.params.name) {
        case 'reflex_begin':
          result = await proxy.begin(args as Task);
          break;
        case 'reflex_finish':
          result = await proxy.finish(
            args.goal as Check,
            args.bindings as Record<string, Record<string, string>> | undefined,
            {
              factPlan: args.factPlan as FactPlan | undefined,
              applicability: args.applicability as Check | undefined,
              parameterCandidates: args.parameterCandidates as ParameterCandidate[] | undefined,
            },
          );
          break;
        case 'reflex_study':
          result = await proxy.store.study(String(args.key), String(args.scope));
          break;
        case 'reflex_wait':
          result = await proxy.waitForLearning();
          break;
        case 'reflex_patch':
          result = await proxy.patch(args.calls as NativeCall[] | null);
          break;
        case 'reflex_cancel':
          await proxy.cancel();
          result = { canceled: true };
          break;
        default:
          return await proxy.call({ name: request.params.name, arguments: args } as NativeCall);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      };
    }
  });
  return { server, proxy };
}

export async function serveToolProxy(config: {
  memory: string;
  url?: string;
  command?: string;
  args?: string[];
  literalText?: boolean;
}) {
  const client = new Client({ name: 'reflexrun-upstream-client', version: '0.3.0' });
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url))
    : new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        stderr: 'inherit',
      });
  await client.connect(transport);
  const port: ToolPort = {
    listTools: () => client.listTools(),
    callTool: async (call) => (await client.callTool(call)) as CallToolResult,
  };
  const { server, proxy } = await createToolProxyServer(port, config.memory, undefined, {
    literalText: config.literalText,
  });
  const stop = async () => {
    await proxy.cancel();
    try {
      await proxy.waitForLearning();
    } finally {
      await server.close();
      await client.close();
      await transport.close();
    }
  };
  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
  await server.connect(new StdioServerTransport());
}
