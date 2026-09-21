import { ProjectConflictError } from './datastore';

const BASE = '/api/projects';
const enc = encodeURIComponent;

/** Read a project's stored version history plus the etag needed to update it. A
 * project with no history yet returns `{ raw: null, etag: null }`. */
export async function readHistory(id: string): Promise<{ raw: string | null; etag: string | null }> {
  const response = await fetch(`${BASE}/${enc(id)}/history`, { cache: 'no-store' });
  if (response.status === 404) return { raw: null, etag: null };
  if (!response.ok) throw new Error('Version history could not be read. Check your connection and try again.');
  return { raw: await response.text(), etag: response.headers.get('ETag') };
}

/** Compare-and-swap the history record. A stale etag throws `ProjectConflictError`
 * so the caller can re-read and retry. */
export async function writeHistory(id: string, raw: string, etag: string | null): Promise<string> {
  const headers: Record<string, string> = etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag };
  const response = await fetch(`${BASE}/${enc(id)}/history`, { method: 'PUT', body: raw, headers });
  if (response.status === 409 || response.status === 412) throw new ProjectConflictError();
  if (response.status === 413) throw new Error('This version history is too large to store. Export a backup, then use smaller attachments.');
  if (!response.ok) throw new Error('Version history could not be saved. Check your connection and try again.');
  return response.headers.get('ETag') ?? '';
}

export async function deleteHistory(id: string): Promise<void> {
  const response = await fetch(`${BASE}/${enc(id)}/history`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    throw new Error('Version history could not be cleared. Check your connection and try again.');
  }
}
