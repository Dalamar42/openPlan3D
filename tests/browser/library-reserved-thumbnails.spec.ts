import { expect, test, seedRaw } from './fixtures';
import { readFile } from 'node:fs/promises';

for (const mode of ['missing', 'saved', 'read failure'] as const) {
  test(`reserved project IDs use only saved thumbnails: ${mode}`, async ({ page, request }) => {
    const source = JSON.parse(await readFile('tests/fixtures/native-import.openplan.json', 'utf8'));
    const ids = ['__proto__', 'constructor', 'toString', 'ordinary-project'];
    const preview = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    const imageRequests: string[] = [];
    page.on('request', request => {
      // Firefox reports the document favicon as an image request too.
      if (request.resourceType() === 'image' && /^https?:/.test(request.url())
        && request.url() !== 'http://127.0.0.1:4188/favicon.svg') imageRequests.push(request.url());
    });
    await seedRaw(request, {
      projects: Object.fromEntries(ids.map(id => [id, JSON.stringify({ ...source, id, name: `Preview ${id}` })])),
      thumbnails: mode === 'missing' ? {} : Object.fromEntries(ids.map(id => [id, preview])),
    });
    await page.addInitScript((mode) => {
      localStorage.setItem('hasSeenWelcome', 'true');
      if (mode === 'read failure') {
        // The library reads previews from /api/projects/thumbnails; a failed read
        // must leave cards without an image, never break the page.
        const original = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url, location.origin).pathname === '/api/projects/thumbnails') return Promise.reject(new Error('Preview read failed'));
          return original(input as RequestInfo, init);
        };
      }
    }, mode);
    await page.goto('/');
    for (const id of ids) {
      const card = page.getByRole('link', { name: `Open Preview ${id}`, exact: true });
      await expect(card).toBeVisible();
      const img = card.locator('img');
      await expect(img).toHaveCount(mode === 'saved' ? 1 : 0);
      if (mode === 'saved') {
        await expect(img).toHaveAttribute('src', preview);
        await expect.poll(() => img.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      }
    }
    expect(imageRequests).toEqual([]);
  });
}
