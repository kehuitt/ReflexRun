import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

type Options = { skillDirectory?: string };
type Receipt = { format: 1; files: Record<string, string>; installedAt: string };
type Inspection = { ready: boolean; path: string; issues: string[] };
const execute = promisify(execFile);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const destination = (options: Options) =>
  resolve(options.skillDirectory ?? join(homedir(), '.agents', 'skills', 'reflexrun'));
const ownedPath = (name: string) =>
  name === 'SKILL.md' ||
  name === 'LICENSE' ||
  name === 'runtime/package.json' ||
  /^runtime\/(?:journal|policy)\.js$/.test(name) ||
  /^runtime\/memory\/[a-z][a-z-]*\.js$/.test(name);

async function regularFile(root: string, name: string) {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = await lstat(join(root, ...parts.slice(0, i)));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error(`Expected a real directory for: ${name}`);
  }
  const file = join(root, name),
    stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${name}`);
  const resolved = relative(await realpath(root), await realpath(file));
  if (resolved.startsWith('..') || isAbsolute(resolved))
    throw new Error(`File leaves its source directory: ${name}`);
  return readFile(file);
}

function validateRuntime(files: Map<string, Buffer>) {
  for (const name of [
    'SKILL.md',
    'LICENSE',
    'runtime/package.json',
    'runtime/memory/index.js',
    'runtime/journal.js',
    'runtime/policy.js',
  ])
    if (!files.has(name)) throw new Error(`Missing required skill file: ${name}`);
  if (!files.get('SKILL.md')!.toString().includes('runtime/memory/index.js'))
    throw new Error('SKILL.md must reference its relative runtime/memory/index.js');
  const config = JSON.parse(files.get('runtime/package.json')!.toString());
  if (config.type !== 'module') throw new Error('The skill runtime must use ES modules');
  for (const [name, data] of files) {
    if (!name.endsWith('.js')) continue;
    const source = data.toString();
    const imports = [
      ...source.matchAll(
        /\b(?:import|export)\s+(?:[^'";\n]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ),
    ];
    const literalDynamic = imports.filter((match) => match[2]).length;
    if (
      [...source.matchAll(/\bimport\s*\(/g)].length !== literalDynamic ||
      /\brequire\s*\(/.test(source)
    )
      throw new Error(`Unsupported runtime dependency in ${name}`);
    for (const imported of imports) {
      const specifier = imported[1] ?? imported[2];
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.'))
        throw new Error(`External runtime dependency in ${name}: ${specifier}`);
      const target = relative('/', resolve('/', dirname(name), specifier)).replaceAll('\\', '/');
      if (!target.startsWith('runtime/') || !files.has(target))
        throw new Error(`Missing or unsafe runtime dependency in ${name}: ${specifier}`);
    }
  }
}

async function runtimeFiles(root: string, prefix = 'runtime'): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix + '/' + entry.name;
    if (entry.isDirectory()) found.push(...(await runtimeFiles(root, name)));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`Unsupported runtime entry: ${name}`);
  }
  return found;
}

/** Inspect only this skill's receipt and runtime. Does not open a browser or call a model. */
export async function inspectDesktopSkill(options: Options = {}): Promise<Inspection> {
  const path = destination(options),
    issues: string[] = [];
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('The skill path must be a real directory');
    const receipt = JSON.parse((await regularFile(path, 'receipt.json')).toString()) as Receipt;
    if (
      receipt.format !== 1 ||
      !receipt.files ||
      Array.isArray(receipt.files) ||
      typeof receipt.files !== 'object' ||
      typeof receipt.installedAt !== 'string' ||
      !Number.isFinite(Date.parse(receipt.installedAt))
    )
      throw new Error('Invalid ReflexRun installation receipt');
    const files = new Map<string, Buffer>();
    for (const [name, expected] of Object.entries(receipt.files)) {
      if (!ownedPath(name) || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error('Invalid file entry in the installation receipt');
      const data = await regularFile(path, name);
      if (hash(data) !== expected) throw new Error(`Installed file was changed: ${name}`);
      files.set(name, data);
    }
    for (const name of await runtimeFiles(path))
      if (!files.has(name)) throw new Error(`Unowned file conflicts with the runtime: ${name}`);
    validateRuntime(files);
    const exports = [
      'Reflex',
      'ExperienceStore',
      'AgentBridge',
      'BatchBridge',
      'CapabilityLibrary',
      'CapabilityCapture',
      'CuaBrowserHost',
      'CuaAppHost',
    ];
    const probe =
      'const sdk = await import(process.argv[1]); for (const name of ' +
      JSON.stringify(exports) +
      ') if (typeof sdk[name] !== "function") { console.error("Missing desktop export " + name); process.exit(1); }';
    await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        probe,
        pathToFileURL(join(path, 'runtime/memory/index.js')).href,
      ],
      { timeout: 10_000, maxBuffer: 64_000, windowsHide: true },
    );
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    issues.push(failure.stderr?.trim().slice(0, 600) || failure.message);
  }
  return { ready: issues.length === 0, path, issues };
}

/** Install a self-contained skill. Updates require an intact, installer-owned directory. */
export async function installDesktopSkill(
  options: Options & { sourceDirectory?: string; upgrade?: boolean } = {},
) {
  const path = destination(options);
  const source = resolve(
    options.sourceDirectory ?? fileURLToPath(new URL('../../', import.meta.url)),
  );
  const files = new Map<string, Buffer>([
    ['SKILL.md', await regularFile(source, 'skills/reflexrun/SKILL.md')],
    ['LICENSE', await regularFile(source, 'LICENSE')],
    ['runtime/package.json', Buffer.from('{"type":"module"}\n')],
    ['runtime/journal.js', await regularFile(source, 'dist/src/journal.js')],
    ['runtime/policy.js', await regularFile(source, 'dist/src/policy.js')],
  ]);
  const memory = join(source, 'dist/src/memory');
  for (const name of (await readdir(memory)).sort()) {
    // Standalone server and import commands run through the CLI.
    if (!name.endsWith('.js') || ['mcp.js', 'action-schema.js', 'import.js'].includes(name))
      continue;
    if (!/^[a-z][a-z-]*\.js$/.test(name)) throw new Error(`Invalid runtime filename: ${name}`);
    files.set('runtime/memory/' + name, await regularFile(source, 'dist/src/memory/' + name));
  }
  validateRuntime(files);
  const hashes = Object.fromEntries([...files].map(([name, data]) => [name, hash(data)]));
  await mkdir(dirname(path), { recursive: true });
  const lockPath = path + '.install.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  let staging: string | undefined;
  try {
    let exists = true;
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (exists) {
      const state = await inspectDesktopSkill({ skillDirectory: path });
      if (!state.ready) throw new Error(`Existing skill was preserved: ${state.issues.join('; ')}`);
      const receipt = JSON.parse((await regularFile(path, 'receipt.json')).toString()) as Receipt;
      const same =
        Object.keys(receipt.files).length === files.size &&
        Object.entries(hashes).every(([name, value]) => receipt.files[name] === value);
      if (same) return { ready: true as const, path, installed: false };
      if (!options.upgrade)
        throw new Error(
          'Existing skill has different contents and was preserved. Pass --upgrade to update an unmodified installation.',
        );
      const owned = new Set(['receipt.json', ...Object.keys(receipt.files)]);
      const verifyOwned = async (directory: string, prefix = '') => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const name = prefix + entry.name;
          if (entry.isDirectory() && [...owned].some((file) => file.startsWith(name + '/')))
            await verifyOwned(join(directory, entry.name), name + '/');
          else if (!entry.isFile() || !owned.has(name))
            throw new Error(
              `Existing skill was preserved because it contains an unowned path: ${name}`,
            );
        }
      };
      await verifyOwned(path);
    }
    staging = await mkdtemp(join(dirname(path), '.reflexrun-install-'));
    for (const [name, data] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await writeFile(join(staging, name), data, { flag: 'wx', mode: 0o600 });
    }
    const receipt: Receipt = { format: 1, files: hashes, installedAt: new Date().toISOString() };
    await writeFile(join(staging, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const state = await inspectDesktopSkill({ skillDirectory: staging });
    if (!state.ready) throw new Error(`Skill validation failed: ${state.issues.join('; ')}`);
    if (exists) {
      const backup = await mkdtemp(join(dirname(path), '.reflexrun-replaced-'));
      const previous = join(backup, 'previous');
      try {
        await rename(path, previous);
      } catch (error) {
        await rm(backup, { recursive: true, force: true });
        throw error;
      }
      try {
        await rename(staging, path);
      } catch (error) {
        await rename(previous, path);
        await rm(backup, { recursive: true, force: true });
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } else await rename(staging, path);
    staging = undefined;
    return { ready: true as const, path, installed: true };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await unlink(lockPath);
  }
}
