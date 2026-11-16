import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  Episode,
  Experience,
  Inputs,
  Json,
  MemoryResult,
  MemoryStep,
  ProvisionalExperience,
} from './types.js';
import { check, decode } from './compiler.js';
import { studyWorkflow, type Sample } from './program.js';

export type Health = { successes: number; failures: number; quarantined: boolean; reason?: string };
type IndexEntry = Pick<
  Experience,
  'id' | 'key' | 'scope' | 'createdAt' | 'requiredInputs' | 'when' | 'constraints' | 'applicability'
> & { health?: Health };
type Index = { signature: string; entries: IndexEntry[] };
type Atom = Omit<MemoryStep, 'sourceIndex'>;
type AtomOwner = Pick<Experience, 'scope' | 'surface' | 'adapter'>;
export type StepAtomRef = { atom: string; sourceIndex: number };
export type StoredExperience =
  | Experience
  | (Omit<Experience, 'format' | 'steps'> & {
      format: 3;
      steps: StepAtomRef[];
    });
type StoredProvisional = Omit<ProvisionalExperience, 'memory'> & { memory: StoredExperience };

function atomId({ scope, surface, adapter }: AtomOwner, atom: Atom) {
  const program = JSON.stringify([scope, surface, adapter, atom], (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
  return createHash('sha256').update(program).digest('hex');
}

export async function writeRecord(
  directory: string,
  folder: string,
  id: string,
  value: unknown,
  immutable = false,
) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid memory record identifier');
  const dir = join(directory, folder);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, id + '.json'),
    temp = target + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.write(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    if (!immutable) await rename(temp, target);
    else {
      try {
        await link(temp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        return false;
      }
    }
    return true;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Internal shared storage for parameterized steps. Authorization belongs to the owner record. */
export class StepAtoms {
  private atoms = new Map<string, Promise<Atom>>();
  constructor(private readonly directory: string) {}
  async store(owner: AtomOwner, steps: MemoryStep[]): Promise<StepAtomRef[]> {
    const atoms = new Map<string, Atom>();
    const refs = steps.map(({ sourceIndex, ...program }) => {
      const atom = atomId(owner, program);
      atoms.set(atom, program);
      return { atom, sourceIndex };
    });
    await Promise.all(
      [...atoms].map(async ([id, atom]) => {
        if (this.atoms.has(id)) return;
        try {
          await stat(join(this.directory, 'atoms', id + '.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await writeRecord(this.directory, 'atoms', id, atom, true);
        }
      }),
    );
    return refs;
  }
  async hydrate(owner: AtomOwner, refs: StepAtomRef[]): Promise<MemoryStep[]> {
    return Promise.all(
      refs.map(async ({ atom: id, sourceIndex }) => {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid memory atom reference');
        let cached = this.atoms.get(id);
        if (!cached) {
          cached = readFile(join(this.directory, 'atoms', id + '.json'), 'utf8')
            .then((body) => JSON.parse(body) as Atom)
            .catch((error) => {
              this.atoms.delete(id);
              throw error;
            });
          this.atoms.set(id, cached);
        }
        const atom = await cached;
        if (atomId(owner, atom) !== id) throw new Error('Memory atom does not match its reference');
        return { ...structuredClone(atom), sourceIndex };
      }),
    );
  }
}

export const defaultMemoryDirectory = () => join(homedir(), '.reflexrun', 'memory');

/** Immutable experiences plus a rebuildable metadata index; no vector database is required. */
export class ExperienceStore {
  private index?: Index;
  private bodies = new Map<string, StoredExperience>();
  private atoms: StepAtoms;
  private sampleKey?: Promise<Buffer>;
  readonly stats = { indexBuilds: 0, bodyReads: 0, indexHits: 0 };
  constructor(readonly directory: string = defaultMemoryDirectory()) {
    this.atoms = new StepAtoms(directory);
  }
  private write(folder: string, id: string, value: unknown) {
    return writeRecord(this.directory, folder, id, value);
  }
  private async records<T>(folder: string): Promise<T[]> {
    let files: string[];
    try {
      files = await readdir(join(this.directory, folder));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    return Promise.all(
      files
        .filter((f) => /^[a-zA-Z0-9-]+\.json$/.test(f))
        .map(async (f) => JSON.parse(await readFile(join(this.directory, folder, f), 'utf8')) as T),
    );
  }
  private async signature() {
    const values = await Promise.all(
      ['experiences', 'health'].map(async (folder) => {
        try {
          const s = await stat(join(this.directory, folder), { bigint: true });
          return String(s.mtimeNs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
          throw e;
        }
      }),
    );
    return values.join(':');
  }
  private async catalog(): Promise<Index> {
    const signature = await this.signature();
    if (this.index?.signature === signature) {
      this.stats.indexHits++;
      return this.index;
    }
    let prior = this.index;
    try {
      const saved =
        prior ??
        (JSON.parse(
          await readFile(join(this.directory, 'catalog', 'index.json'), 'utf8'),
        ) as Index);
      if (saved.signature === signature && Array.isArray(saved.entries)) {
        this.stats.indexHits++;
        return (this.index = saved);
      }
      if (Array.isArray(saved.entries)) prior = saved;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    if (prior?.signature.split(':')[0] === signature.split(':')[0]) {
      const health = new Map(
        (await this.records<Health & { id: string }>('health')).map((h) => [h.id, h]),
      );
      const index = {
        signature,
        entries: prior.entries.map((e) => ({ ...e, health: health.get(e.id) })),
      };
      if (signature !== (await this.signature())) return this.catalog();
      this.stats.indexHits++;
      await this.write('catalog', 'index', index);
      return (this.index = index);
    }
    this.bodies.clear();
    const memories = (await this.records<StoredExperience>('experiences')).filter(
      (m) => (m.format === 2 || m.format === 3) && Array.isArray(m.steps),
    );
    const health = new Map(
      (await this.records<Health & { id: string }>('health')).map((h) => [h.id, h]),
    );
    this.stats.indexBuilds++;
    this.stats.bodyReads += memories.length;
    for (const m of memories) this.bodies.set(m.id, m);
    const index: Index = {
      signature,
      entries: memories.map((m) => ({
        id: m.id,
        key: m.key,
        scope: m.scope,
        createdAt: m.createdAt,
        requiredInputs: m.requiredInputs,
        when: m.when,
        constraints: m.constraints,
        applicability: m.applicability,
        health: health.get(m.id),
      })),
    };
    // A concurrent append invalidates this snapshot; never publish a falsely current index.
    if (signature !== (await this.signature())) return this.catalog();
    await this.write('catalog', 'index', index);
    this.index = index;
    return index;
  }
  private async hydrate(memory: StoredExperience): Promise<Experience> {
    if (memory.format === 2) return memory;
    return { ...memory, format: 2, steps: await this.atoms.hydrate(memory, memory.steps) };
  }
  private async memory(id: string): Promise<Experience> {
    let stored = this.bodies.get(id);
    if (!stored) {
      stored = JSON.parse(
        await readFile(join(this.directory, 'experiences', id + '.json'), 'utf8'),
      ) as StoredExperience;
      this.stats.bodyReads++;
    }
    const memory = await this.hydrate(stored);
    this.bodies.set(id, memory);
    return memory;
  }
  private async inputKey(): Promise<Buffer> {
    const file = join(this.directory, 'sample-key');
    try {
      return await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID();
    await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      await unlink(temporary);
    }
    return readFile(file);
  }
  private async sample(inputs?: Inputs): Promise<Sample> {
    if (!inputs || !Object.keys(inputs).length) return {};
    const key = await (this.sampleKey ??= this.inputKey());
    return {
      fingerprints: Object.fromEntries(
        Object.entries(inputs).map(([name, value]) => [
          name,
          createHmac('sha256', key)
            .update(JSON.stringify([name, value]))
            .digest('hex'),
        ]),
      ),
    };
  }
  async saveEpisode(value: Episode, inputs?: Inputs) {
    await this.write('episodes', value.id, {
      ...value,
      ...(await this.sample(value.verified ? inputs : undefined)),
    });
  }
  async save(value: Experience) {
    await this.publish(value);
  }
  private async publish(value: Experience) {
    const stored: StoredExperience = {
      ...value,
      format: 3,
      steps: await this.atoms.store(value, value.steps),
    };
    // Publish the workflow only after every immutable atom is available to other readers.
    await this.write('experiences', value.id, stored);
    this.index = undefined;
    this.bodies.delete(value.id);
    return stored;
  }
  private async health(id: string): Promise<Health> {
    try {
      return JSON.parse(await readFile(join(this.directory, 'health', id + '.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { successes: 0, failures: 0, quarantined: false };
      throw e;
    }
  }
  async feedback(experience: string, result: MemoryResult, inputs?: Inputs) {
    const confirmedReplay =
      result.status === 'completed' && result.source === 'memory' && result.evidence !== 'none';
    await this.write('outcomes', randomUUID(), {
      experience,
      at: new Date().toISOString(),
      result,
      ...(await this.sample(confirmedReplay ? inputs : undefined)),
    });
    if (result.status === 'completed' || result.status === 'failed') {
      const h = await this.health(experience);
      if (result.status === 'completed') h.successes++;
      else h.failures++;
      await this.write('health', experience, { id: experience, ...h });
    }
  }
  async quarantine(id: string, reason: string) {
    await this.write('health', id, { id, ...(await this.health(id)), quarantined: true, reason });
    const provisional = (await this.records<StoredProvisional>('provisional')).find(
      (p) => p.memory.id === id,
    );
    if (provisional)
      await this.write('provisional', id, { ...provisional, status: 'quarantined', reason });
  }
  async list(): Promise<Experience[]> {
    const index = await this.catalog();
    return Promise.all(
      [...index.entries]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((m) => this.memory(m.id)),
    );
  }
  async versions() {
    return (await this.catalog()).entries;
  }
  /** List saved candidates for the original agent to inspect before selecting an operation. */
  async discover(scope: string) {
    return (await this.catalog()).entries
      .filter((entry) => entry.scope === scope && !entry.health?.quarantined)
      .map(({ id, key, requiredInputs }) => ({ id, key, requiredInputs: [...requiredInputs] }));
  }
  async get(id: string) {
    const entry = (await this.catalog()).entries.find((e) => e.id === id && !e.health?.quarantined);
    return entry ? this.memory(entry.id) : undefined;
  }
  async episodes(): Promise<Episode[]> {
    return this.records<Episode>('episodes');
  }
  async study(key: string, scope: string) {
    const index = await this.catalog();
    const entries = index.entries.filter((e) => e.key === key && e.scope === scope);
    const ids = new Set(entries.map((e) => e.id));
    const [memories, episodes, outcomes] = await Promise.all([
      Promise.all(entries.map((e) => this.memory(e.id))),
      this.records<Episode & Sample>('episodes'),
      this.records<{ experience: string; result: MemoryResult } & Sample>('outcomes'),
    ]);
    return {
      ...studyWorkflow(
        memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
        episodes.filter((e) => e.key === key && e.scope === scope && (e.verified || e.success)),
        outcomes.filter(
          (o) =>
            ids.has(o.experience) &&
            o.result.status === 'completed' &&
            o.result.source === 'memory' &&
            o.result.evidence !== 'none',
        ),
      ),
      quarantined: entries.filter((e) => e.health?.quarantined).map((e) => e.id),
    };
  }
  async saveBatch(id: string, value: unknown) {
    await this.write('batches', id, value);
  }
  async batch<T>(id: string): Promise<T | undefined> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid batch identifier');
    try {
      return JSON.parse(await readFile(join(this.directory, 'batches', id + '.json'), 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async stage(
    batch: string,
    memory: Experience,
    representativeJob: string,
    validation: ProvisionalExperience['validation'],
  ) {
    await this.write('provisional', memory.id, {
      batch,
      memory,
      representativeJob,
      validation,
      status: 'provisional',
    } satisfies ProvisionalExperience);
  }
  private async staged(batch: string) {
    return (await this.records<StoredProvisional>('provisional')).filter((p) => p.batch === batch);
  }
  async provisional(batch: string): Promise<ProvisionalExperience[]> {
    return Promise.all(
      (await this.staged(batch)).map(async (p) => ({ ...p, memory: await this.hydrate(p.memory) })),
    );
  }
  async settleCandidates(
    batch: string,
    rows: { id: string; experience?: string; status: string }[],
  ) {
    for (const candidate of await this.staged(batch)) {
      if (candidate.status !== 'provisional') continue;
      const uses = rows.filter(
        (r) => r.experience === candidate.memory.id && r.status !== 'skipped',
      );
      if (!uses.length) continue;
      if (uses.some((r) => r.status === 'rejected' || r.status === 'failed')) {
        await this.quarantine(
          candidate.memory.id,
          'Final audit did not validate the repaired path',
        );
        continue;
      }
      if (
        uses.every((r) => r.status === 'confirmed') &&
        uses.some((r) => `${batch}:${r.id}` === candidate.representativeJob)
      ) {
        const memory = await this.publish(await this.hydrate(candidate.memory));
        await this.write('provisional', memory.id, { ...candidate, memory, status: 'promoted' });
      }
    }
    return this.provisional(batch);
  }
  async recall(
    key: string,
    scope: string,
    inputs: Inputs,
    constraints?: Json,
    batch?: string,
    state?: import('./types.js').Observation,
  ) {
    const matches = (m: IndexEntry) =>
      m.key === key &&
      m.scope === scope &&
      !m.health?.quarantined &&
      m.requiredInputs.every((k) => Object.hasOwn(inputs, k)) &&
      Object.entries(m.when ?? {}).every(
        ([k, v]) => JSON.stringify(inputs[k]) === JSON.stringify(v),
      ) &&
      JSON.stringify(m.constraints === undefined ? undefined : decode(m.constraints, inputs)) ===
        JSON.stringify(constraints) &&
      (!state ||
        !m.applicability ||
        check(state, decode(m.applicability, inputs) as import('./types.js').Check));
    const index = await this.catalog();
    const entries = index.entries.filter(matches).sort((a, b) => {
      const score = (m: IndexEntry) => (m.health?.successes ?? 0) - 2 * (m.health?.failures ?? 0);
      return score(b) - score(a) || b.createdAt.localeCompare(a.createdAt);
    });
    const staged = batch
      ? (await this.staged(batch))
          .filter((p) => p.status === 'provisional' && matches(p.memory))
          .reverse()
      : [];
    return Promise.all([
      ...staged.map((p) => this.hydrate(p.memory)),
      ...entries.map((m) => this.memory(m.id)),
    ]);
  }
}
