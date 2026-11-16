import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CodexToolAgent, type ModelEvent } from '../src/model/codex.js';

async function runtime(body: string, run: (command: string, cwd: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'reflex-rpc-test-')),
    command = join(directory, 'codex-mock');
  await writeFile(
    command,
    `#!/usr/bin/env node\nconst readline=require('node:readline');const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);${body}});`,
    { mode: 0o700 },
  );
  try {
    await run(command, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const startup = `if(message.method==='initialize')send({id:message.id,result:{}});if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'test-thread'},model:'test-model',modelProvider:'test-provider',reasoningEffort:'max'}});`;
const tool = {
  name: 'visible_action',
  description: 'One original host tool',
  inputSchema: { type: 'object' },
};

test('Live benchmarks reject missing portable inputs before starting an app or model', () => {
  const script = fileURLToPath(new URL('../scripts/benchmark-live.ts', import.meta.url));
  const cases: [string[], RegExp][] = [
    [[], /Error: --app is required/],
    [['--app', '/unused'], /Error: --out is required/],
    [
      ['--reflex-only', '--app', '/unused', '--out', '/unused', '--items', '1'],
      /Error: items must be 2\.\.100/,
    ],
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
  }
});

test('Codex driver routes the original tool arguments, preserves usage/model provenance and waits for completed', async () => {
  await runtime(
    startup +
      `if(message.method==='turn/start'){send({id:message.id,result:{}});send({id:'host-call',method:'item/tool/call',params:{tool:'visible_action',arguments:{target:'e7',text:'synthetic'}}});}if(message.id==='host-call'){if(!message.result.success)process.exit(2);send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:12,outputTokens:4}}}});send({method:'item/completed',params:{item:{type:'agentMessage',text:'done'}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});}`,
    async (command, cwd) => {
      let calls = 0;
      const events: ModelEvent[] = [];
      const result = await new CodexToolAgent({
        command,
        cwd,
        onEvent: (event) => events.push(event),
      }).run('Synthetic RPC test', [tool], async (name, args) => {
        calls++;
        assert.equal(name, tool.name);
        assert.deepEqual(args, { target: 'e7', text: 'synthetic' });
        return [{ type: 'inputText', text: 'received' }];
      });
      assert.equal(calls, 1);
      assert.equal(result.model, 'test-model');
      assert.equal(result.reasoningEffort, 'max');
      assert.equal(result.toolCalls, 1);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.messages, ['done']);
      assert.deepEqual(result.usage, { total: { inputTokens: 12, outputTokens: 4 } });
      const request = events.find((event) => event.type === 'tool-request')!;
      const response = events.find((event) => event.type === 'tool-response-sent')!;
      assert.equal(request.sequence, response.sequence);
      assert.ok(Number(response.monotonicMs) >= Number(request.monotonicMs));
      assert.ok(
        events.some((event) => event.type === 'rpc-result' && event.method === 'thread/start'),
      );
      assert.ok(result.timings.startupMs > 0);
      assert.ok(result.timings.toolHandlerMs >= 0);
      assert.ok(result.timings.modelAndTransportWaitMs >= 0);
      assert.ok(
        result.timings.startupMs +
          result.timings.toolHandlerMs +
          result.timings.modelAndTransportWaitMs <=
          result.elapsedMs,
        'Measured non-overlapping startup, handler and outside-handler intervals fit the real wall clock',
      );
    },
  );
});

test('A bounded proposal closes the model without dispatching queued or later host actions', async () => {
  const proposal = { ...tool, name: 'submit_patch' };
  await runtime(
    startup +
      `if(message.method==='turn/start'){send({id:message.id,result:{}});send({id:'proposal',method:'item/tool/call',params:{tool:'submit_patch',arguments:{valid:true}}});send({id:'queued',method:'item/tool/call',params:{tool:'visible_action',arguments:{}}});}if(message.id==='proposal'){send({id:'late',method:'item/tool/call',params:{tool:'visible_action',arguments:{}}});}`,
    async (command, cwd) => {
      const calls: string[] = [],
        events: ModelEvent[] = [];
      const result = await new CodexToolAgent({
        command,
        cwd,
        onEvent: (event) => events.push(event),
      }).runUntilTool(
        'Propose one bounded patch',
        [tool, proposal],
        async (name, args) => {
          calls.push(name);
          assert.equal(args.valid, true);
          return [{ type: 'inputText', text: 'validated' }];
        },
        'submit_patch',
      );
      assert.deepEqual(calls, ['submit_patch']);
      assert.equal(result.status, 'bounded-result');
      assert.equal(result.completedBy, 'tool');
      assert.equal(result.completedTool, 'submit_patch');
      assert.equal(result.timings.responseTailMs, undefined);
      assert.ok(events.some((event) => event.type === 'bounded-result'));
      assert.ok(!events.some((event) => event.type === 'turn-completed'));
    },
  );
});

test('A rejected proposal does not end the bounded turn; a valid correction can end it', async () => {
  const proposal = { ...tool, name: 'submit_patch' };
  await runtime(
    startup +
      `if(message.method==='turn/start'){send({id:message.id,result:{}});send({id:'invalid',method:'item/tool/call',params:{tool:'submit_patch',arguments:{valid:false}}});}if(message.id==='invalid'){if(message.result.success)process.exit(2);send({id:'valid',method:'item/tool/call',params:{tool:'submit_patch',arguments:{valid:true}}});}`,
    async (command, cwd) => {
      let calls = 0;
      const result = await new CodexToolAgent({ command, cwd }).runUntilTool(
        'Propose one bounded patch',
        [proposal],
        async (_name, args) => {
          calls++;
          if (!args.valid) throw new Error('Patch validation failed');
          return [{ type: 'inputText', text: 'validated' }];
        },
        'submit_patch',
      );
      assert.equal(calls, 2);
      assert.equal(result.status, 'bounded-result');
      assert.equal(result.toolCalls, 2);
    },
  );
});

test('A bounded result still settles an out-of-order turn-start response', async () => {
  await runtime(
    startup +
      `if(message.method==='turn/start'){global.turnStartId=message.id;send({id:'proposal',method:'item/tool/call',params:{tool:'visible_action',arguments:{}}});}if(message.id==='proposal')send({id:global.turnStartId,result:{}});`,
    async (command, cwd) => {
      const result = await new CodexToolAgent({ command, cwd, timeoutMs: 5_000 }).runUntilTool(
        'Return one proposal',
        [tool],
        async () => [{ type: 'inputText', text: 'validated' }],
        'visible_action',
      );
      assert.equal(result.status, 'bounded-result');
      assert.equal(result.toolCalls, 1);
    },
  );
});

test('A bounded model failure, timeout or completion without a proposal is not success', async () => {
  for (const status of ['failed', 'completed', 'timeout'])
    await runtime(
      startup +
        `if(message.method==='turn/start'){send({id:message.id,result:{}});${status === 'timeout' ? '' : `send({method:'turn/completed',params:{turn:{status:'${status}'}}});`}}`,
      async (command, cwd) => {
        await assert.rejects(
          new CodexToolAgent({
            command,
            cwd,
            timeoutMs: status === 'timeout' ? 500 : 5_000,
          }).runUntilTool('Propose one bounded patch', [tool], async () => [], 'visible_action'),
          status === 'failed'
            ? /ended failed/
            : status === 'timeout'
              ? /deadline/
              : /without a validated/,
        );
      },
    );
});

test('An unoffered builtin invalidates a model trial instead of being reported as autonomous browser learning', async () => {
  await runtime(
    startup +
      `if(message.method==='turn/start'){send({id:message.id,result:{}});send({method:'item/started',params:{item:{type:'commandExecution'}}});}`,
    async (command, cwd) => {
      await assert.rejects(
        new CodexToolAgent({ command, cwd }).run(
          'Synthetic forbidden-capability test',
          [tool],
          async () => [],
        ),
        /unoffered capability/,
      );
    },
  );
});

test('A failed model turn cannot be mistaken for a completed task', async () => {
  await runtime(
    startup +
      `if(message.method==='turn/start'){send({id:message.id,result:{}});send({method:'turn/completed',params:{turn:{status:'failed',error:{message:'test failure'}}}});}`,
    async (command, cwd) => {
      await assert.rejects(
        new CodexToolAgent({ command, cwd }).run(
          'Synthetic failed-turn test',
          [tool],
          async () => [],
        ),
        /ended failed/,
      );
    },
  );
});
