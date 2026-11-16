import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Entry, Journal } from './types.js';

export class MemoryJournal implements Journal {
  protected records = new Map<string, Entry>();
  private locked = false;
  get(key: string) {
    return this.records.get(key);
  }
  entries() {
    return [...this.records.values()];
  }
  async put(entry: Entry) {
    this.records.set(entry.key, { ...entry });
  }
  async acquire(): Promise<() => Promise<void>> {
    if (this.locked) throw new Error('This journal already has an active writer.');
    this.locked = true;
    return async () => {
      this.locked = false;
    };
  }
}

/** Durable write-ahead intent. A reservation is never automatically retried. */
export class FileJournal extends MemoryJournal {
  private constructor(private readonly path: string) {
    super();
  }
  static async openLocked(path: string) {
    const journal = new FileJournal(path);
    const release = await journal.acquire();
    return { journal, release };
  }
  static async load(path: string): Promise<FileJournal> {
    const journal = new FileJournal(path);
    let data: string;
    try {
      data = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return journal;
      throw e;
    }
    const lines = data.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]) as Entry;
        if (!entry.key || !entry.id || !entry.state) throw new Error('Invalid journal entry');
        journal.records.set(entry.key, entry);
      } catch {
        throw new Error(`Journal is damaged at line ${i + 1}; reconcile it before continuing.`);
      }
    }
    return journal;
  }
  override async put(entry: Entry) {
    await this.putMany([entry]);
  }
  /** Preserve write fences while holding the destination journal lock. */
  async importFences(source: FileJournal) {
    await this.putMany(
      source
        .entries()
        .filter(({ key }) => !this.get(key))
        .map(({ key, id, label, state, revision, at }) => ({
          key,
          id,
          label,
          state,
          revision,
          at,
        })),
    );
  }
  async putMany(entries: readonly Entry[]) {
    if (!entries.length) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, 'a', 0o600);
    try {
      await file.writeFile(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      await file.sync();
    } finally {
      await file.close();
    }
    for (const entry of entries) await super.put(entry);
  }
  override async acquire(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await open(this.path + '.lock', 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'Journal is locked. If a process crashed, reconcile its intent log before removing the .lock file.',
        );
      throw e;
    }
    try {
      await lock.write(JSON.stringify({ owner: 'reflexrun', at: new Date().toISOString() }));
      this.records = (await FileJournal.load(this.path)).records;
    } catch (e) {
      await lock.close();
      await unlink(this.path + '.lock');
      throw e;
    }
    return async () => {
      await lock.close();
      await unlink(this.path + '.lock');
    };
  }
}
