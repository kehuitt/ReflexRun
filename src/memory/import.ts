import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileJournal } from '../journal.js';
import { CapabilityLibrary } from './capabilities.js';
import { StepAtoms, writeRecord, type Health, type StoredExperience } from './store.js';
import type { MemoryStep } from './types.js';

async function exists(path: string) {
  return lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
}

async function readRecord(path: string): Promise<unknown> {
  const entry = await exists(path);
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error('Expected a regular memory record');
  return JSON.parse(await readFile(path, 'utf8'));
}

function validExperience(data: unknown, id: string): data is StoredExperience {
  if (!data || typeof data !== 'object') return false;
  const entry = data as StoredExperience;
  return (
    [2, 3].includes(entry.format) &&
    entry.id === id &&
    typeof entry.key === 'string' &&
    !!entry.key.trim() &&
    typeof entry.scope === 'string' &&
    !!entry.scope.trim() &&
    ['web', 'native', 'visual', 'tool'].includes(entry.surface) &&
    (entry.adapter === undefined || typeof entry.adapter === 'string') &&
    typeof entry.createdAt === 'string' &&
    Array.isArray(entry.requiredInputs) &&
    entry.requiredInputs.every((input) => typeof input === 'string') &&
    Array.isArray(entry.steps) &&
    entry.steps.length > 0 &&
    entry.goal !== undefined
  );
}

function validSteps(steps: MemoryStep[]) {
  return steps.every(
    (step) =>
      step &&
      Number.isInteger(step.sourceIndex) &&
      step.sourceIndex >= 0 &&
      typeof step.effect === 'boolean' &&
      !!step.action &&
      typeof step.action === 'object' &&
      !Array.isArray(step.action) &&
      typeof step.action.kind === 'string',
  );
}

function validHealth(data: unknown, id: string): data is Health & { id: string } {
  if (!data || typeof data !== 'object') return false;
  const health = data as Health & { id: string };
  return (
    health.id === id &&
    Number.isInteger(health.successes) &&
    health.successes >= 0 &&
    Number.isInteger(health.failures) &&
    health.failures >= 0 &&
    typeof health.quarantined === 'boolean' &&
    (health.reason === undefined || typeof health.reason === 'string')
  );
}

/** Import published workflows and safety state from a known project store. */
export async function importExperiences(sourceDirectory: string, targetDirectory: string) {
  const source = await realpath(sourceDirectory);
  if (!(await lstat(source)).isDirectory()) throw new Error('Expected a source memory directory');
  const target = resolve(targetDirectory);
  if (source === target || ((await exists(target)) && (await realpath(target)) === source))
    throw new Error('Source and destination memory directories must differ');
  for (const journal of ['intents.jsonl', 'capability-intents.jsonl'])
    if (await exists(join(source, journal + '.lock')))
      throw new Error('Source memory is in use. Finish its active task before importing.');

  const entries = await readdir(join(source, 'experiences')).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  });
  const pending = await FileJournal.load(join(source, 'intents.jsonl'));
  const sourceAtoms = new StepAtoms(source);
  const targetAtoms = new StepAtoms(target);
  const result = { imported: 0, skipped: 0, invalid: 0 };
  if (entries.length || pending.entries().length) {
    const { journal, release } = await FileJournal.openLocked(join(target, 'intents.jsonl'));
    try {
      await journal.importFences(pending);
      for (const filename of entries) {
        if (!/^[a-zA-Z0-9-]+\.json$/.test(filename)) continue;
        const id = filename.slice(0, -5);
        if (await exists(join(target, 'experiences', filename))) {
          result.skipped++;
          continue;
        }
        const memory = await readSourceExperience(source, sourceAtoms, id);
        if (!memory) {
          result.skipped++;
          result.invalid++;
          continue;
        }
        const { experience, steps, health } = memory;
        const stored = {
          ...experience,
          format: 3,
          steps: await targetAtoms.store(experience, steps),
        };
        // Publish health first so a quarantined workflow cannot become visible as healthy.
        if (health) await writeRecord(target, 'health', id, health, true);
        if (await writeRecord(target, 'experiences', id, stored, true)) result.imported++;
        else result.skipped++;
      }
    } finally {
      await release();
    }
  }
  await new CapabilityLibrary(target).importFrom(new CapabilityLibrary(source));
  return result;
}

async function readSourceExperience(source: string, atoms: StepAtoms, id: string) {
  try {
    const experience = await readRecord(join(source, 'experiences', id + '.json'));
    if (!validExperience(experience, id)) return undefined;
    const health = await readRecord(join(source, 'health', id + '.json'));
    if (health !== undefined && !validHealth(health, id)) return undefined;
    const steps =
      experience.format === 3
        ? await atoms.hydrate(experience, experience.steps)
        : experience.steps;
    return validSteps(steps) ? { experience, steps, health } : undefined;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== undefined &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw error;
    return undefined;
  }
}
