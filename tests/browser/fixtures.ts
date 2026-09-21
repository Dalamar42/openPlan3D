import { test as base, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/** Every browser test runs against one shared server-backed project store, so the
 * library must be wiped before each test to restore the empty-library isolation
 * the per-context IndexedDB store used to give for free. The reset endpoint is
 * gated by `OPENPLAN3D_TEST_RESET`, set only for the test server. */
export const test = base.extend({
  page: async ({ page, request }, use) => {
    await request.post('/api/projects/reset');
    await use(page);
  },
});

export { expect };
export type { Page, BrowserContext, Route, Locator, APIRequestContext } from '@playwright/test';

type RawMaps = {
  projects?: Record<string, string>;
  thumbnails?: Record<string, string>;
  history?: Record<string, string>;
  meta?: Record<string, string>;
};

/** Write raw records straight into the server store through the restore endpoint,
 * the server-side replacement for seeding IndexedDB / localStorage before load. */
export async function seedRaw(request: APIRequestContext, maps: RawMaps) {
  const response = await request.post('/api/projects/restore', {
    data: { projects: {}, thumbnails: {}, history: {}, meta: {}, ...maps },
  });
  if (!response.ok()) throw new Error(`Seeding the project store failed: ${response.status()}`);
}

/** Seed whole project documents (serialised for the caller). */
export async function seedProjects(request: APIRequestContext, projects: Record<string, unknown>) {
  await seedRaw(request, {
    projects: Object.fromEntries(Object.entries(projects).map(([id, project]) => [id, JSON.stringify(project)])),
  });
}
