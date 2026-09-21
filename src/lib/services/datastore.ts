import { readProject } from '$lib/utils/projectValidation';
import type { Project } from '$lib/models/types';
import { notifyLibraryChange } from './libraryChange';
export { PROJECTS_STORAGE_KEY, LIBRARY_CHANGE_KEY } from './libraryChange';

export interface DataStore {
  has(id: string): Promise<boolean>;
  assertCurrent(id: string): Promise<void>;
  saveCopy(project: Project, suffix?: string): Promise<Project>;
  save(project: Project): Promise<void>;
  load(id: string): Promise<Project | null>;
  list(): Promise<{ id: string; name: string; updatedAt: string }[]>;
  delete(id: string): Promise<void>;
  duplicate(id: string): Promise<Project | null>;
  saveThumbnail(id: string, dataUrl: string): Promise<void>;
  getThumbnail(id: string): Promise<string | null>;
  getThumbnails(): Promise<Record<string, string>>;
}

export class ProjectConflictError extends Error {
  constructor() {
    super('This project changed or was deleted in another tab. Save your version as a copy or download a JSON backup to keep both versions.');
    this.name = 'ProjectConflictError';
  }
}

/** Keep the existing i18n mapping intact: these strings are the canonical English
 * diagnostics `projectServiceMessages` translates. A server error carries its own
 * message and falls through to be shown verbatim. The browser-storage branches
 * still cover the client's remaining browser work (the backup Blob, the cross-tab
 * signal). */
export function storageErrorMessage(error: unknown): string {
  const e = error as { name?: string; code?: number; message?: string } | null;
  if (e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014) {
    return 'Browser storage is full. Download your project as JSON, then free space by deleting projects you have backed up.';
  }
  if (e?.name === 'SecurityError') {
    return 'Browser storage is unavailable. Allow site storage or download your project as JSON.';
  }
  return e?.message || 'Could not save to browser storage. Download your project as JSON to keep a copy.';
}

const BASE = '/api/projects';
const newId = () => globalThis.crypto?.randomUUID?.() ?? `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
}

/** Map a non-OK write response onto the store's error contract. A precondition
 * miss (deleted or changed elsewhere) is the conflict flow; an oversized body and
 * everything else surface as plain messages. */
function writeFailed(status: number): never {
  if (status === 409 || status === 412) throw new ProjectConflictError();
  if (status === 413) throw new Error('This project is too large to store online. Remove some attachments, or download a JSON backup to keep it.');
  throw new Error('Could not save to the project library. Check your connection and try again.');
}

/** Recover the whole library, including any recovery archives, as one JSON file. */
export async function downloadLibraryBackup() {
  const response = await api('/backup');
  if (!response.ok) throw new Error('Could not download a library backup. Check your connection and try again.');
  const raw = await response.text();
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'openplan3d-library-backup.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** A server-backed project library. The server is the source of truth; each
 * document remembers the etag it last read so a racing save from another device
 * fails the compare-and-swap and reuses the conflict flow. */
export function createServerStore(): DataStore {
  const opened = new Map<string, string | null>();
  const listed = new Map<string, string>();
  const enc = encodeURIComponent;
  return {
    async has(id) {
      const response = await api(`/${enc(id)}`, { method: 'HEAD' });
      if (response.ok) return true;
      if (response.status === 404) return false;
      throw new Error('Could not reach the project library. Check your connection and try again.');
    },

    async assertCurrent(id) {
      const response = await api(`/${enc(id)}`, { method: 'HEAD' });
      if (!response.ok && response.status !== 404) throw new Error('Could not reach the project library. Check your connection and try again.');
      const current = response.ok ? response.headers.get('ETag') : null;
      if (current !== (opened.get(id) ?? null)) throw new ProjectConflictError();
    },

    async save(project) {
      const id = project.id;
      const known = opened.get(id);
      const headers: Record<string, string> = typeof known === 'string' ? { 'If-Match': known } : { 'If-None-Match': '*' };
      const response = await api(`/${enc(id)}`, { method: 'PUT', body: JSON.stringify(project), headers });
      if (!response.ok) writeFailed(response.status);
      opened.set(id, response.headers.get('ETag'));
      notifyLibraryChange(id);
    },

    async saveCopy(project, suffix = 'Recovered copy') {
      const copy = readProject(project);
      copy.name = `${copy.name || 'Untitled Project'} (${suffix})`;
      copy.createdAt = copy.updatedAt = new Date();
      let attempts = 0;
      while (true) {
        if (++attempts > 5) throw new Error('Could not choose a new project ID. Try saving a copy again.');
        copy.id = newId();
        const response = await api(`/${enc(copy.id)}`, { method: 'PUT', body: JSON.stringify(copy), headers: { 'If-None-Match': '*' } });
        if (response.ok) {
          opened.set(copy.id, response.headers.get('ETag'));
          notifyLibraryChange(copy.id);
          return copy;
        }
        if (response.status !== 409 && response.status !== 412) writeFailed(response.status);
        // A precondition miss means the id already exists; pick another and retry.
      }
    },

    async load(id) {
      const response = await api(`/${enc(id)}`);
      if (response.status === 404) { opened.set(id, null); return null; }
      if (!response.ok) throw new Error('Could not open this project. Check your connection and try again.');
      const project = readProject(JSON.parse(await response.text()));
      if (project.id !== id) throw new Error('The saved project ID does not match its library entry. Download a library backup before recovery.');
      opened.set(id, response.headers.get('ETag'));
      return project;
    },

    async list() {
      const response = await api('/');
      if (!response.ok) throw new Error('Could not read the project library. Check your connection and try again.');
      const entries = (await response.json()) as { id: string; name: string; updatedAt: string; etag: string; readable: boolean }[];
      listed.clear();
      return entries.map((entry) => {
        listed.set(entry.id, entry.etag);
        // Keep damaged entries visible and deletable; opening still validates.
        return entry.readable
          ? { id: entry.id, name: entry.name, updatedAt: entry.updatedAt }
          : { id: entry.id, name: `Unreadable project — ${entry.id}`, updatedAt: new Date(0).toISOString() };
      });
    },

    async delete(id) {
      const expected = listed.has(id) ? listed.get(id) : opened.get(id);
      const headers = typeof expected === 'string' ? { 'If-Match': expected } : undefined;
      const response = await api(`/${enc(id)}`, { method: 'DELETE', headers });
      if (!response.ok && response.status !== 204) writeFailed(response.status);
      // Retain the opened revision so this editor cannot recreate a deleted plan.
      listed.delete(id);
      notifyLibraryChange(id);
    },

    async duplicate(id) {
      const original = await this.load(id);
      if (!original) return null;
      const dup = await this.saveCopy(original, 'Copy');
      const thumb = await this.getThumbnail(id);
      if (thumb) await this.saveThumbnail(dup.id, thumb);
      return dup;
    },

    async saveThumbnail(id, dataUrl) {
      const expected = opened.get(id);
      if (typeof expected !== 'string') return;
      // Previews are optional; a failed preview cannot invalidate a saved plan.
      try {
        await api(`/${enc(id)}/thumbnail`, { method: 'PUT', body: dataUrl, headers: { 'If-Project-Match': expected } });
      } catch {}
    },

    async getThumbnail(id) {
      try {
        const response = await api(`/${enc(id)}/thumbnail`);
        return response.ok ? await response.text() : null;
      } catch { return null; }
    },

    async getThumbnails() {
      try {
        const response = await api('/thumbnails');
        return response.ok ? ((await response.json()) as Record<string, string>) : {};
      } catch { return {}; }
    },
  };
}

export const projectStore = createServerStore();
