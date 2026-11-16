#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultMemoryDirectory, ExperienceStore } from './memory/store.js';

const help = `ReflexRun 0.3 — Computer Use remembers.

  reflexrun setup [--skill-directory PATH] [--upgrade]
  reflexrun doctor [--skill-directory PATH]
  reflexrun memories [--memory PATH]
  reflexrun memories import --memory SOURCE
  reflexrun mcp [--memory PATH] [--headed] [--profile DIR]
  reflexrun proxy [--memory PATH] [--literal-text] --upstream http://127.0.0.1:8931/mcp
  reflexrun proxy [--memory PATH] -- node /path/to/playwright-mcp/cli.js [options]

MCP lets your existing agent explore, learn, replay and repair without a site contract.
Desktop skill setup uses the current Computer Use host. Memory defaults to ~/.reflexrun/memory.
For standalone browser MCP, install Chromium once:
  npx playwright install chromium`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      memory: { type: 'string' },
      headed: { type: 'boolean' },
      profile: { type: 'string' },
      upstream: { type: 'string' },
      'literal-text': { type: 'boolean' },
      'skill-directory': { type: 'string' },
      upgrade: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (command === 'setup' || command === 'doctor') {
    const { installDesktopSkill, inspectDesktopSkill } = await import('./setup.js');
    const options = values['skill-directory']
      ? { skillDirectory: resolve(values['skill-directory']) }
      : {};
    const status =
      command === 'setup'
        ? await installDesktopSkill({ ...options, upgrade: values.upgrade })
        : await inspectDesktopSkill(options);
    console.log(JSON.stringify(status, null, 2));
    if (!status.ready) process.exitCode = 1;
    else
      console.log(
        'Skill files and runtime verified. Open a new chat and describe your Computer Use task. Use $reflexrun to select the skill explicitly.',
      );
    return;
  }
  const memory = values.memory ? resolve(values.memory) : defaultMemoryDirectory();
  if (command === 'mcp') {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp({
      memory,
      headed: values.headed,
      profile: values.profile ? resolve(values.profile) : undefined,
    });
    return;
  }
  if (command === 'proxy') {
    const { serveToolProxy } = await import('./proxy/server.js');
    if (!values.upstream && !positionals[1])
      throw new Error('A running upstream MCP URL or command is required');
    await serveToolProxy({
      memory,
      url: values.upstream,
      command: positionals[1],
      args: positionals.slice(2),
      literalText: values['literal-text'],
    });
    return;
  }
  if (command === 'memories') {
    if (positionals[1] === 'import') {
      if (!values.memory || positionals.length !== 2)
        throw new Error('Usage: reflexrun memories import --memory SOURCE');
      const { importExperiences } = await import('./memory/import.js');
      const target = defaultMemoryDirectory();
      const result = await importExperiences(memory, target);
      console.log(JSON.stringify({ source: memory, target, ...result }, null, 2));
      return;
    }
    if (positionals.length !== 1) throw new Error(`Unknown memories command: ${positionals[1]}`);
    const memories = await new ExperienceStore(memory).list();
    console.log(
      JSON.stringify(
        memories.map((m) => ({
          id: m.id,
          key: m.key,
          scope: m.scope,
          surface: m.surface,
          inputs: m.requiredInputs,
          steps: m.steps.length,
          parent: m.parent,
        })),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`Unknown command: ${command}\n${help}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
