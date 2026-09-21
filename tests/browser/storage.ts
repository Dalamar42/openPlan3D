import type { Page } from '@playwright/test';

type Store = 'projects' | 'thumbnails' | 'history' | 'meta';

/** Read the raw records the server holds, the API-backed replacement for the
 * former direct IndexedDB read. `meta` maps onto the backup bundle's `recovery`. */
export async function storedRecords(page: Page, store: Store = 'projects'): Promise<Record<string, string>> {
  return page.evaluate(async (store) => {
    const response = await fetch('/api/projects/backup', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The project library could not be read: ${response.status}`);
    const bundle = await response.json();
    return (store === 'meta' ? bundle.recovery : bundle[store]) ?? {};
  }, store);
}

export async function savedProjects(page: Page) {
  return Object.fromEntries(Object.entries(await storedRecords(page)).map(([id, raw]) => [id, JSON.parse(raw)]));
}

/** Inject failure at the persistence boundary — a failed project `PUT` — without
 * changing app code, by making the page's `fetch` reject those writes. A
 * `QuotaExceededError` reproduces a full-storage save failure, which
 * `storageErrorMessage` maps to its localized "storage is full" guidance. Clear
 * `window[flag]` to let writes succeed again (the retry path). */
export async function failProjectWrites(page: Page, flag = 'failProjectWrites') {
  await page.evaluate((flag) => {
    (window as any)[flag] = true;
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const path = new URL(url, location.origin).pathname;
      // A project save is a create/update PUT or the bulk restore/import POST.
      const write = (method === 'PUT' && /^\/api\/projects\/[^/]+$/.test(path)) || (method === 'POST' && path === '/api/projects/restore');
      if ((window as any)[flag] && write) {
        return Promise.reject(new DOMException('Full', 'QuotaExceededError'));
      }
      return original(input as RequestInfo, init);
    };
  }, flag);
}
