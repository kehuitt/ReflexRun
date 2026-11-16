import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectDesktopSkill, installDesktopSkill } from '../src/setup.js';

const exports =
  'export class Reflex {} export class ExperienceStore {} export class AgentBridge {} export class BatchBridge {} export class CuaBrowserHost {} export class CuaAppHost {} export class CapabilityLibrary {} export class CapabilityCapture {}';

async function fixture(run: (sourceDirectory: string, skillDirectory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'reflex-setup-test-'));
  const sourceDirectory = join(root, 'source'),
    skillDirectory = join(root, 'skills', 'reflexrun');
  const files = {
    LICENSE: 'Test license text\n',
    'skills/reflexrun/SKILL.md':
      '---\nname: reflexrun\ndescription: Test skill\n---\nImport ./runtime/memory/index.js relative to this skill.\n',
    'dist/src/memory/index.js': 'import "../journal.js"; import "../policy.js"; ' + exports + '\n',
    'dist/src/memory/mcp.js': 'import "intentionally-excluded-external-package";\n',
    'dist/src/memory/action-schema.js': 'import "also-excluded";\n',
    'dist/src/memory/import.js': 'throw new Error("CLI-only migration");\n',
    'dist/src/journal.js': 'import { readFile } from "node:fs/promises"; export { readFile };\n',
    'dist/src/policy.js': 'export const policy = true;\n',
  };
  for (const [name, value] of Object.entries(files)) {
    await mkdir(dirname(join(sourceDirectory, name)), { recursive: true });
    await writeFile(join(sourceDirectory, name), value);
  }
  try {
    await run(sourceDirectory, skillDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('A clean skill installation imports without node_modules and is exactly idempotent', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    assert.equal((await inspectDesktopSkill({ skillDirectory })).ready, false);
    assert.equal((await installDesktopSkill({ sourceDirectory, skillDirectory })).installed, true);
    assert.deepEqual(await inspectDesktopSkill({ skillDirectory }), {
      ready: true,
      path: skillDirectory,
      issues: [],
    });
    assert.equal(await readFile(join(skillDirectory, 'LICENSE'), 'utf8'), 'Test license text\n');
    assert.deepEqual(await readdir(join(skillDirectory, 'runtime/memory')), ['index.js']);
    const receipt = await readFile(join(skillDirectory, 'receipt.json'), 'utf8');
    await mkdir(join(skillDirectory, 'memory'));
    await writeFile(join(skillDirectory, 'memory', 'user.json'), 'local experience');
    assert.equal((await installDesktopSkill({ sourceDirectory, skillDirectory })).installed, false);
    assert.equal(await readFile(join(skillDirectory, 'receipt.json'), 'utf8'), receipt);
    assert.equal(
      await readFile(join(skillDirectory, 'memory', 'user.json'), 'utf8'),
      'local experience',
    );
    assert.deepEqual(await readdir(dirname(skillDirectory)), ['reflexrun']);
  });
});

test('Unknown directories, local changes and different versions are preserved', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), 'user-authored skill');
    await assert.rejects(installDesktopSkill({ sourceDirectory, skillDirectory }), /preserved/);
    assert.equal(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'), 'user-authored skill');
    await rm(skillDirectory, { recursive: true });
    await installDesktopSkill({ sourceDirectory, skillDirectory });
    const original = await readFile(join(skillDirectory, 'runtime/policy.js'), 'utf8');
    await writeFile(join(sourceDirectory, 'dist/src/policy.js'), 'export const policy = false;\n');
    await assert.rejects(
      installDesktopSkill({ sourceDirectory, skillDirectory }),
      /different contents/,
    );
    assert.equal(await readFile(join(skillDirectory, 'runtime/policy.js'), 'utf8'), original);
    await writeFile(join(skillDirectory, 'runtime/policy.js'), 'user changed this file');
    assert.equal((await inspectDesktopSkill({ skillDirectory })).ready, false);
    await assert.rejects(installDesktopSkill({ sourceDirectory, skillDirectory }), /preserved/);
    assert.equal(
      await readFile(join(skillDirectory, 'runtime/policy.js'), 'utf8'),
      'user changed this file',
    );
    assert.deepEqual(await readdir(dirname(skillDirectory)), ['reflexrun']);
  });
});

test('Explicit upgrade replaces an intact installation and preserves unowned files', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    await installDesktopSkill({ sourceDirectory, skillDirectory });
    const installed = join(skillDirectory, 'runtime/policy.js');
    const source = join(sourceDirectory, 'dist/src/policy.js');
    const extra = join(skillDirectory, 'my-notes.txt');
    await writeFile(source, 'export const policy = false;\n');
    await writeFile(extra, 'keep');
    await assert.rejects(
      installDesktopSkill({ sourceDirectory, skillDirectory, upgrade: true }),
      /unowned path/,
    );
    assert.equal(await readFile(extra, 'utf8'), 'keep');
    assert.equal(await readFile(installed, 'utf8'), 'export const policy = true;\n');
    await rm(extra);
    assert.equal(
      (await installDesktopSkill({ sourceDirectory, skillDirectory, upgrade: true })).installed,
      true,
    );
    assert.equal(await readFile(installed, 'utf8'), 'export const policy = false;\n');
    assert.equal((await inspectDesktopSkill({ skillDirectory })).ready, true);
    assert.deepEqual(await readdir(dirname(skillDirectory)), ['reflexrun']);
  });
});

test('Unsafe source dependencies and symlinks are rejected before activating a skill', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    const index = join(sourceDirectory, 'dist/src/memory/index.js');
    await writeFile(
      index,
      'import "missing-node-package"; export class Reflex {} export class ExperienceStore {}\n',
    );
    await assert.rejects(
      installDesktopSkill({ sourceDirectory, skillDirectory }),
      /External runtime dependency/,
    );
    assert.equal((await inspectDesktopSkill({ skillDirectory })).ready, false);
    await rm(index);
    await symlink(join(sourceDirectory, 'dist/src/policy.js'), index);
    await assert.rejects(installDesktopSkill({ sourceDirectory, skillDirectory }), /regular file/);
  });
});

test('A failed import leaves no partial installation and inspection detects extra runtime files', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    const index = join(sourceDirectory, 'dist/src/memory/index.js');
    await writeFile(index, 'export const malformed = ;\n');
    await assert.rejects(
      installDesktopSkill({ sourceDirectory, skillDirectory }),
      /validation failed/,
    );
    assert.deepEqual(await readdir(dirname(skillDirectory)), []);
    await writeFile(index, exports);
    await installDesktopSkill({ sourceDirectory, skillDirectory });
    await writeFile(
      join(skillDirectory, 'runtime/memory/extra.js'),
      'export const extra = true;\n',
    );
    const state = await inspectDesktopSkill({ skillDirectory });
    assert.equal(state.ready, false);
    assert.match(state.issues[0], /Unowned file/);
    await assert.rejects(installDesktopSkill({ sourceDirectory, skillDirectory }), /preserved/);
    assert.equal(
      await readFile(join(skillDirectory, 'runtime/memory/extra.js'), 'utf8'),
      'export const extra = true;\n',
    );
  });
});

test('An incomplete runtime cannot be reported ready when a desktop adapter is missing', async () => {
  await fixture(async (sourceDirectory, skillDirectory) => {
    await writeFile(
      join(sourceDirectory, 'dist/src/memory/index.js'),
      exports.replace('export class CuaAppHost {}', ''),
    );
    await assert.rejects(
      installDesktopSkill({ sourceDirectory, skillDirectory }),
      /Missing desktop export CuaAppHost/,
    );
    assert.equal((await inspectDesktopSkill({ skillDirectory })).ready, false);
    assert.deepEqual(await readdir(dirname(skillDirectory)), []);
  });
});
