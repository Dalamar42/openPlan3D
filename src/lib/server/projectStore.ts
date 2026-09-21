import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The four record kinds, mirrored from the former IndexedDB stores. `meta` now
 * holds only `library-recovery:*` archives; the browser legacy-migration markers
 * were client-only and have no server-side equivalent. */
export const STORES = ['projects', 'thumbnails', 'history', 'meta'] as const;
export type StoreName = (typeof STORES)[number];

/** A conservative per-store byte ceiling. Projects embed base64 GLB assets and
 * photo data URLs; history keeps up to ten whole-project snapshots. These bound
 * one request, not the whole library. */
export const MAX_BYTES: Record<StoreName, number> = {
  projects: 96 * 1024 * 1024,
  history: 192 * 1024 * 1024,
  thumbnails: 8 * 1024 * 1024,
  meta: 96 * 1024 * 1024,
};

/** base64url of the id keeps every filename inside `[A-Za-z0-9_-]`, so an
 * arbitrary project id (an import may carry any string) can never escape its
 * store directory. The bound keeps the encoded name inside the filesystem's
 * 255-byte limit. */
const MAX_ID_BYTES = 190;

export function validId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && Buffer.byteLength(id, 'utf8') <= MAX_ID_BYTES;
}

function fileName(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function idFromFileName(name: string): string | null {
  try {
    const id = Buffer.from(name, 'base64url').toString('utf8');
    return fileName(id) === name ? id : null;
  } catch {
    return null;
  }
}

export class ConflictError extends Error {
  constructor() {
    super('This project changed or was deleted elsewhere.');
    this.name = 'ConflictError';
  }
}

export class TooLargeError extends Error {
  constructor() {
    super('This project is too large to store.');
    this.name = 'TooLargeError';
  }
}

/** A minimal async key/value backend, one namespace per store. FsBackend is the
 * durable production implementation; MemoryBackend backs the client-store tests. */
export interface Backend {
  get(store: StoreName, id: string): Promise<string | null>;
  put(store: StoreName, id: string, raw: string): Promise<void>;
  delete(store: StoreName, id: string): Promise<boolean>;
  keys(store: StoreName): Promise<string[]>;
}

export class FsBackend implements Backend {
  constructor(private root: string) {}

  private path(store: StoreName, id: string): string {
    return join(this.root, store, fileName(id));
  }

  async get(store: StoreName, id: string): Promise<string | null> {
    try {
      return await readFile(this.path(store, id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Write to a unique temporary file, then atomically rename over the target so a
   * concurrent reader never sees a half-written record. */
  async put(store: StoreName, id: string, raw: string): Promise<void> {
    const target = this.path(store, id);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, raw, 'utf8');
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async delete(store: StoreName, id: string): Promise<boolean> {
    try {
      await rm(this.path(store, id), { force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async keys(store: StoreName): Promise<string[]> {
    try {
      const names = await readdir(join(this.root, store));
      // Decode each filename back to its id; skip in-flight temporary writes and
      // any stray non-record entries that do not round-trip.
      return names.map(idFromFileName).filter((id): id is string => id !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export class MemoryBackend implements Backend {
  private data: Record<StoreName, Map<string, string>> = {
    projects: new Map(),
    thumbnails: new Map(),
    history: new Map(),
    meta: new Map(),
  };

  async get(store: StoreName, id: string): Promise<string | null> {
    return this.data[store].get(id) ?? null;
  }
  async put(store: StoreName, id: string, raw: string): Promise<void> {
    this.data[store].set(id, raw);
  }
  async delete(store: StoreName, id: string): Promise<boolean> {
    return this.data[store].delete(id);
  }
  async keys(store: StoreName): Promise<string[]> {
    return [...this.data[store].keys()];
  }
}

export function etagOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface Record_ {
  raw: string;
  etag: string;
}
export interface Precondition {
  /** Require the current record to carry this etag (an update). */
  ifMatch?: string;
  /** Require the record to be absent (a create) when true. */
  ifNoneMatch?: boolean;
}
export interface ListEntry {
  id: string;
  name: string;
  updatedAt: string;
  etag: string;
  readable: boolean;
}
export interface RestorePayload {
  projects: globalThis.Record<string, string>;
  thumbnails: globalThis.Record<string, string>;
  history: globalThis.Record<string, string>;
  meta: globalThis.Record<string, string>;
}
export type RestoreResult =
  | { collisions: string[] }
  | { saved: { id: string; name: string }[] };

/** Flat-file project library with optimistic-concurrency (etag) writes. A single
 * process-wide mutex serialises every mutation, so a read-check-write stays atomic
 * without a database. This is single-tenant: the tailnet grant scopes the host. */
export class ProjectStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private backend: Backend) {}

  /** Run `task` after every previously-queued mutation, never concurrently. */
  private lock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }

  /** Wipe the whole library. Test-only: the route gates this behind an env flag,
   * so it is unreachable in production. */
  clear(): Promise<void> {
    return this.lock(async () => {
      for (const store of STORES) {
        for (const id of await this.backend.keys(store)) await this.backend.delete(store, id);
      }
    });
  }

  async read(store: StoreName, id: string): Promise<Record_ | null> {
    if (!validId(id)) return null;
    const raw = await this.backend.get(store, id);
    return raw === null ? null : { raw, etag: etagOf(raw) };
  }

  async head(store: StoreName, id: string): Promise<string | null> {
    const record = await this.read(store, id);
    return record?.etag ?? null;
  }

  async readAll(store: StoreName): Promise<globalThis.Record<string, string>> {
    // A null prototype keeps an id like `__proto__` an own key, not a mutation of
    // the map's prototype.
    const out: globalThis.Record<string, string> = Object.create(null);
    for (const id of await this.backend.keys(store)) {
      const raw = await this.backend.get(store, id);
      if (raw !== null) out[id] = raw;
    }
    return out;
  }

  async listProjects(): Promise<ListEntry[]> {
    const raws = await this.readAll('projects');
    return Object.entries(raws).map(([id, raw]) => {
      try {
        const project = JSON.parse(raw);
        if (!project || typeof project.name !== 'string' || typeof project.updatedAt !== 'string' ||
            !Number.isFinite(Date.parse(project.updatedAt))) throw new Error();
        return { id, name: project.name, updatedAt: project.updatedAt, etag: etagOf(raw), readable: true };
      } catch {
        return { id, name: '', updatedAt: new Date(0).toISOString(), etag: etagOf(raw), readable: false };
      }
    });
  }

  write(store: StoreName, id: string, raw: string, pre: Precondition = {}): Promise<string> {
    return this.lock(async () => {
      if (!validId(id)) throw new ConflictError();
      if (raw.length > MAX_BYTES[store]) throw new TooLargeError();
      const current = await this.backend.get(store, id);
      const currentEtag = current === null ? null : etagOf(current);
      if (pre.ifNoneMatch && current !== null) throw new ConflictError();
      if (pre.ifMatch !== undefined && currentEtag !== pre.ifMatch) throw new ConflictError();
      await this.backend.put(store, id, raw);
      return etagOf(raw);
    });
  }

  delete(store: StoreName, id: string, pre: Precondition = {}): Promise<void> {
    return this.lock(async () => {
      const current = await this.backend.get(store, id);
      const currentEtag = current === null ? null : etagOf(current);
      if (pre.ifMatch !== undefined && currentEtag !== pre.ifMatch) throw new ConflictError();
      await this.backend.delete(store, id);
    });
  }

  /** Remove a project and its attachments together. The project bytes gate the
   * delete; a stale thumbnail or history left behind would be orphaned, so both
   * go in the same critical section. */
  deleteProject(id: string, pre: Precondition = {}): Promise<void> {
    return this.lock(async () => {
      const current = await this.backend.get('projects', id);
      const currentEtag = current === null ? null : etagOf(current);
      if (pre.ifMatch !== undefined && currentEtag !== pre.ifMatch) throw new ConflictError();
      await this.backend.delete('projects', id);
      await this.backend.delete('thumbnails', id);
      await this.backend.delete('history', id);
    });
  }

  /** Attach a preview only while the project still carries the etag the editor
   * saved. A superseded project keeps its own preview; a failure here never
   * invalidates a saved plan, so callers treat `skipped` as success. */
  writeThumbnail(id: string, dataUrl: string, ifProjectMatch: string): Promise<'written' | 'skipped'> {
    return this.lock(async () => {
      if (!validId(id)) return 'skipped';
      if (dataUrl.length > MAX_BYTES.thumbnails) throw new TooLargeError();
      const project = await this.backend.get('projects', id);
      if (project === null || etagOf(project) !== ifProjectMatch) return 'skipped';
      await this.backend.put('thumbnails', id, dataUrl);
      return 'written';
    });
  }

  /** The whole library as one JSON bundle, in the format the client restore path
   * already understands. No `legacy` block: that migration was browser-only. */
  backup(): Promise<string> {
    return this.lock(async () => {
      const [projects, thumbnails, history, recovery] = await Promise.all([
        this.readAll('projects'), this.readAll('thumbnails'),
        this.readAll('history'), this.readAll('meta'),
      ]);
      // `meta` holds only recovery archives, keyed by their own id, so it maps
      // straight onto the backup bundle's `recovery` map.
      return JSON.stringify({ format: 'openplan3d-library', version: 1, projects, thumbnails, history, recovery });
    });
  }

  /** Write a prepared restore in one critical section. The client owns id
   * assignment (fresh UUIDs); a project id that already exists refuses the whole
   * write so the client can regenerate and retry. Any write failure rolls back
   * every record written so far, so a restore is all-or-nothing and the library
   * is never left partial. Recovery archives (`meta`) are deduplicated by content
   * so re-importing a backup never balloons them. */
  restore(payload: RestorePayload): Promise<RestoreResult> {
    return this.lock(async () => {
      for (const [store, records] of Object.entries(payload) as [StoreName, globalThis.Record<string, string>][]) {
        for (const [id, raw] of Object.entries(records)) {
          if (!validId(id)) throw new ConflictError();
          if (raw.length > MAX_BYTES[store]) throw new TooLargeError();
        }
      }
      const collisions = [];
      for (const id of Object.keys(payload.projects)) {
        if ((await this.backend.get('projects', id)) !== null) collisions.push(id);
      }
      if (collisions.length) return { collisions };

      const existingMeta = new Set<string>();
      for (const key of await this.backend.keys('meta')) {
        const raw = await this.backend.get('meta', key);
        if (raw !== null) existingMeta.add(raw);
      }

      const written: [StoreName, string][] = [];
      const saved: { id: string; name: string }[] = [];
      try {
        for (const [id, raw] of Object.entries(payload.projects)) {
          await this.backend.put('projects', id, raw);
          written.push(['projects', id]);
          let name = id;
          try { name = JSON.parse(raw).name ?? id; } catch { /* keep id as the label */ }
          saved.push({ id, name });
        }
        for (const store of ['thumbnails', 'history'] as const) {
          for (const [id, raw] of Object.entries(payload[store])) {
            await this.backend.put(store, id, raw);
            written.push([store, id]);
          }
        }
        for (const [id, raw] of Object.entries(payload.meta)) {
          if (existingMeta.has(raw)) continue;
          existingMeta.add(raw);
          await this.backend.put('meta', id, raw);
          written.push(['meta', id]);
        }
      } catch (error) {
        for (const [store, id] of written.reverse()) {
          await this.backend.delete(store, id).catch(() => {});
        }
        throw error;
      }
      return { saved };
    });
  }
}
