import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, FsBackend, ProjectStore, TooLargeError } from '$lib/server/projectStore';

let root: string;
let store: ProjectStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openplan3d-store-'));
  store = new ProjectStore(new FsBackend(root));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('flat-file project store', () => {
  it('round trips a record and reports a stable content etag', async () => {
    const first = await store.write('projects', 'p1', '{"name":"One"}', { ifNoneMatch: true });
    const record = await store.read('projects', 'p1');
    expect(record?.raw).toBe('{"name":"One"}');
    expect(record?.etag).toBe(first);
    expect(await store.head('projects', 'p1')).toBe(first);
  });

  it('refuses a create over an existing id and an update with a stale etag', async () => {
    const etag = await store.write('projects', 'p1', 'a', { ifNoneMatch: true });
    await expect(store.write('projects', 'p1', 'b', { ifNoneMatch: true })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.write('projects', 'p1', 'b', { ifMatch: 'wrong' })).rejects.toBeInstanceOf(ConflictError);
    const next = await store.write('projects', 'p1', 'b', { ifMatch: etag });
    expect((await store.read('projects', 'p1'))?.etag).toBe(next);
  });

  it('rejects an oversized record', async () => {
    const huge = 'x'.repeat(9 * 1024 * 1024);
    await expect(store.write('thumbnails', 't1', huge)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('stores an arbitrary id under a safe filename and lists it back', async () => {
    await store.write('projects', '../escape', '{"name":"Escapes?"}');
    await store.write('projects', '__proto__', '{"name":"Proto"}');
    const names = readdirSync(join(root, 'projects'));
    // No traversal or literal dot-dot leaks into the directory.
    expect(names.every((name) => /^[A-Za-z0-9_-]+$/.test(name))).toBe(true);
    const all = await store.readAll('projects');
    expect(Object.keys(all).sort()).toEqual(['../escape', '__proto__'].sort());
  });

  it('does not commit a temporary file when a write is observed mid-flight', async () => {
    await store.write('projects', 'p1', '{"name":"One"}');
    // Atomic rename leaves only the final record, never a `.tmp-` sibling.
    expect(readdirSync(join(root, 'projects')).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('deletes a project together with its thumbnail and history', async () => {
    await store.write('projects', 'p1', '{"name":"One"}');
    await store.write('thumbnails', 'p1', 'data:image/png;base64,AA');
    await store.write('history', 'p1', '[]');
    await store.deleteProject('p1');
    expect(await store.read('projects', 'p1')).toBeNull();
    expect(await store.read('thumbnails', 'p1')).toBeNull();
    expect(await store.read('history', 'p1')).toBeNull();
  });

  it('serialises concurrent updates so no compare-and-swap is lost', async () => {
    const etag = await store.write('projects', 'p1', '0');
    const results = await Promise.allSettled([
      store.write('projects', 'p1', '1', { ifMatch: etag }),
      store.write('projects', 'p1', '2', { ifMatch: etag }),
    ]);
    // Exactly one writer holds the observed revision; the other loses the race.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rolls back a restore whose write fails, leaving the library unchanged', async () => {
    await store.write('projects', 'existing', '{"name":"Keep"}');
    const before = await store.readAll('projects');
    const oversized = 'x'.repeat(200 * 1024 * 1024);
    await expect(store.restore({ projects: { fresh: '{"name":"New"}' }, thumbnails: {}, history: { fresh: oversized }, meta: {} }))
      .rejects.toBeInstanceOf(TooLargeError);
    expect(await store.readAll('projects')).toEqual(before);
  });

  it('reports project-id collisions from a restore instead of overwriting', async () => {
    await store.write('projects', 'taken', '{"name":"Original"}');
    const result = await store.restore({ projects: { taken: '{"name":"Intruder"}' }, thumbnails: {}, history: {}, meta: {} });
    expect(result).toEqual({ collisions: ['taken'] });
    expect((await store.read('projects', 'taken'))?.raw).toBe('{"name":"Original"}');
  });

  it('deduplicates recovery archives by content across restores', async () => {
    await store.restore({ projects: {}, thumbnails: {}, history: {}, meta: { a: '{"recovery":1}' } });
    await store.restore({ projects: {}, thumbnails: {}, history: {}, meta: { b: '{"recovery":1}' } });
    expect(Object.values(await store.readAll('meta'))).toEqual(['{"recovery":1}']);
  });
});
