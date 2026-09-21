import { ConflictError, ProjectStore, TooLargeError, type Precondition, type StoreName } from './projectStore';

/** Split a `/api/projects/...` remainder into path segments. `''` (the collection
 * root) yields `[]`. */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

function preconditionOf(request: Request): Precondition {
  if (request.headers.get('if-none-match') === '*') return { ifNoneMatch: true };
  const ifMatch = request.headers.get('if-match');
  return ifMatch === null ? {} : { ifMatch };
}

function raw(body: string, etag: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag },
  });
}

function data(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function empty(status: number, etag?: string): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (etag) headers.ETag = etag;
  return new Response(null, { status, headers });
}

/** Translate a store mutation into an HTTP status. A precondition miss is 412; an
 * oversized record is 413. */
async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConflictError) return empty(412);
    if (error instanceof TooLargeError) return empty(413);
    throw error;
  }
}

/** The whole `/api/projects` surface as one dispatcher, shared by the SvelteKit
 * rest route and the client-store test fetch stub so both exercise identical
 * routing. `segments` is the path after `/api/projects/`. */
export async function dispatch(
  store: ProjectStore,
  method: string,
  segments: string[],
  request: Request,
): Promise<Response> {
  const verb = method.toUpperCase();

  if (segments.length === 0) {
    if (verb === 'GET') return data(await store.listProjects());
    return empty(405);
  }

  const [head, tail] = segments;

  if (segments.length === 1 && head === 'thumbnails') {
    if (verb === 'GET') return data(await store.readAll('thumbnails'));
    return empty(405);
  }

  if (segments.length === 1 && head === 'backup') {
    if (verb === 'GET') return raw(await store.backup(), '', 200);
    return empty(405);
  }

  if (segments.length === 1 && head === 'restore') {
    if (verb !== 'POST') return empty(405);
    return guarded(async () => {
      const payload = await request.json();
      const result = await store.restore(payload);
      if ('collisions' in result) return data(result, 409);
      return data(result, 200);
    });
  }

  // Reserved collection words never appear as project ids (which are UUIDs), but
  // guard anyway so a stray id cannot shadow a route above.
  const id = head;

  if (segments.length === 1) {
    if (verb === 'GET') {
      const record = await store.read('projects', id);
      return record === null ? empty(404) : raw(record.raw, record.etag);
    }
    if (verb === 'HEAD') {
      const etag = await store.head('projects', id);
      return etag === null ? empty(404) : empty(200, etag);
    }
    if (verb === 'PUT') {
      return guarded(async () => {
        const body = await request.text();
        const etag = await store.write('projects', id, body, preconditionOf(request));
        return empty(200, etag);
      });
    }
    if (verb === 'DELETE') {
      return guarded(async () => {
        await store.deleteProject(id, preconditionOf(request));
        return empty(204);
      });
    }
    return empty(405);
  }

  if (segments.length === 2 && tail === 'thumbnail') {
    if (verb === 'GET') {
      const record = await store.read('thumbnails', id);
      return record === null ? empty(404) : raw(record.raw, record.etag);
    }
    if (verb === 'PUT') {
      return guarded(async () => {
        const body = await request.text();
        const projectMatch = request.headers.get('if-project-match');
        // A preview is best-effort and the client ignores the outcome, so respond
        // with no body: an unconsumed response body would keep the fetch open and
        // stall `networkidle`.
        if (projectMatch !== null) await store.writeThumbnail(id, body, projectMatch);
        return empty(204);
      });
    }
    return empty(405);
  }

  if (segments.length === 2 && tail === 'history') {
    if (verb === 'GET') {
      const record = await store.read('history', id);
      return record === null ? empty(404) : raw(record.raw, record.etag);
    }
    if (verb === 'PUT') {
      return guarded(async () => {
        const body = await request.text();
        const etag = await store.write('history', id, body, preconditionOf(request));
        return empty(200, etag);
      });
    }
    if (verb === 'DELETE') {
      return guarded(async () => {
        await store.delete('history', id);
        return empty(204);
      });
    }
    return empty(405);
  }

  return empty(404);
}

let singleton: ProjectStore | undefined;

/** The process-wide store, bound to the persistent data volume. Created lazily so
 * importing this module never touches the filesystem (SSR-safe). */
export async function getStore(): Promise<ProjectStore> {
  if (!singleton) {
    const { env } = await import('$env/dynamic/private');
    const { FsBackend } = await import('./projectStore');
    const dir = env.OPENPLAN3D_DATA_DIR?.trim() || 'data/openplan3d';
    singleton = new ProjectStore(new FsBackend(dir));
  }
  return singleton;
}

export const _resetStoreForTest = (store?: ProjectStore) => {
  singleton = store;
};

export type { StoreName };
