import { expect, test, seedProjects } from './fixtures';
import { readFile } from 'node:fs/promises';

test('Portuguese vector downloads use localized furniture captions', async ({ page, request }) => {
  test.slow();
  const project = JSON.parse(await readFile('tests/fixtures/furniture-fidelity.openplan.json', 'utf8'));
  await seedProjects(request, { [project.id]: project });
  await page.addInitScript(() => localStorage.setItem('o3d_locale', 'pt'));
  await page.goto(`/editor?id=${project.id}`);
  async function download(name: string) {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    return readFile((await (await pending).path())!, 'utf8');
  }
  const before = JSON.parse(await download('Baixar JSON')).floors;
  const svg = await download('Exportar como SVG');
  expect(svg).toContain('Poltrona');
  expect(svg).not.toContain('Armchair');
  const dxf = await download('Exportar como DXF');
  expect(dxf).toContain('Poltrona');
  expect(dxf).not.toContain('Armchair');
  expect(JSON.parse(await download('Baixar JSON')).floors).toEqual(before);
});
