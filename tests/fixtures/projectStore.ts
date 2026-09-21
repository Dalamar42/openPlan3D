import { beforeEach, vi } from 'vitest';
import { MemoryBackend, ProjectStore, type StoreName } from '$lib/server/projectStore';
import { dispatch, segmentsOf } from '$lib/server/projectApi';

/** The in-memory server the stubbed `fetch` routes to. A fresh backend per test
 * gives each case an empty library, the same isolation the old IndexedDB stub
 * gave. Tests reach the raw records through the helpers below. */
let backend: MemoryBackend;
let store: ProjectStore;

const realFetch = globalThis.fetch;

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, 'http://localhost');
  if (!parsed.pathname.startsWith('/api/projects')) return realFetch(input as RequestInfo, init);
  const rest = parsed.pathname.slice('/api/projects'.length).replace(/^\//, '');
  const request = new Request(`http://localhost${parsed.pathname}`, init);
  try {
    return await dispatch(store, request.method, segmentsOf(rest), request);
  } catch {
    // A backend that throws (see failWrites) mirrors SvelteKit turning an
    // unexpected error into a 500 the client store surfaces as a save failure.
    return new Response(null, { status: 500 });
  }
}

beforeEach(() => {
  backend = new MemoryBackend();
  store = new ProjectStore(backend);
  vi.stubGlobal('fetch', route);
});

/** Direct access to the server for tests that assert on stored state. */
export function serverStore(): ProjectStore {
  return store;
}

export function rawRecords(name: StoreName = 'projects'): Promise<Record<string, string>> {
  return store.readAll(name);
}

/** The whole-library backup bundle, the server-side equivalent of the former
 * IndexedDB `libraryBackup()`. */
export function libraryBackup(): Promise<string> {
  return store.backup();
}

export function putRaw(name: StoreName, id: string, raw: string): Promise<void> {
  return backend.put(name, id, raw);
}

/** Make every write to `name` fail, the server-side analogue of a full disk. The
 * client store surfaces the resulting 500 as a generic save failure. */
export function failWrites(name: StoreName = 'projects') {
  const original = backend.put.bind(backend);
  const spy = vi.spyOn(backend, 'put').mockImplementation((s, id, raw) => {
    if (s === name) throw new Error('write failed');
    return original(s, id, raw);
  });
  return () => spy.mockRestore();
}

/** Stub `localStorage`, still used by the cross-tab change signal. */
export function mockStorage(data = new Map<string, string>()) {
  vi.stubGlobal('localStorage', {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: (key: string) => data.delete(key),
  });
  return data;
}
