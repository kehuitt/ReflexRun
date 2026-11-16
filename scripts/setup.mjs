import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (args) =>
  new Promise((resolveRun, reject) => {
    const npm = process.env.npm_execpath;
    const child = npm
      ? spawn(process.execPath, [npm, ...args], { cwd: root, stdio: 'inherit' })
      : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`npm ${args[0]} failed (${code})`)),
    );
  });

try {
  if (Number(process.versions.node.split('.')[0]) < 20)
    throw new Error('ReflexRun setup requires Node.js 20 or later.');
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'skill-directory': { type: 'string' },
      upgrade: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run setup:codex -- [--skill-directory PATH] [--upgrade]\nInstalls the desktop skill. Source checkouts install build dependencies when needed.',
    );
    process.exit(0);
  }
  let sourceCheckout = true;
  try {
    await access(resolve(root, 'tsconfig.json'));
  } catch (error) {
    if (error.code === 'ENOENT') sourceCheckout = false;
    else throw error;
  }
  if (sourceCheckout) {
    try {
      await access(resolve(root, 'package-lock.json'));
    } catch {
      throw new Error(
        'Source installation requires package-lock.json. Download the complete source archive again.',
      );
    }
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    try {
      await Promise.all(
        dependencies.map((name) => access(resolve(root, 'node_modules', name, 'package.json'))),
      );
    } catch {
      await run(['ci', '--include=dev', '--ignore-scripts']);
    }
    await run(['run', 'build']);
  } else {
    try {
      await access(resolve(root, 'dist/src/setup.js'));
    } catch {
      throw new Error(
        'Compiled installer missing. Use the complete source archive or a built package.',
      );
    }
  }
  const { installDesktopSkill } = await import(new URL('../dist/src/setup.js', import.meta.url));
  const options = {
    sourceDirectory: root,
    upgrade: values.upgrade,
    ...(values['skill-directory'] ? { skillDirectory: resolve(values['skill-directory']) } : {}),
  };
  const installed = await installDesktopSkill(options);
  console.log(JSON.stringify({ ...installed, issues: [] }, null, 2));
  console.log(
    'Open a new Codex Desktop chat and describe the Computer Use task you want to complete.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
