import { mockStorage, rawRecords, putRaw, failWrites } from './fixtures/projectStore';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServerStore, ProjectConflictError } from '$lib/services/datastore';
import { createDefaultProject } from '$lib/stores/project';

beforeEach(() => { mockStorage(); });

describe('server-backed project persistence', () => {
  it('round trips a project and its dates without changing other projects', async () => {
    const store = createServerStore();
    const first = createDefaultProject('First');
    const second = createDefaultProject('Second');
    second.floors[0].elevation = -325.5;
    await store.save(first);
    await store.save(second);
    second.name = 'Renamed';
    await store.save(second);
    expect(await store.load(first.id)).toEqual(first);
    expect(await store.load(second.id)).toEqual(second);
    expect(await store.list()).toHaveLength(2);
  });

  it('creates once, then requires the current revision to update', async () => {
    const store = createServerStore();
    const project = createDefaultProject('Only');
    await store.save(project);
    // A create over an existing id is refused; a fresh id must be used instead.
    const clash = createServerStore();
    await expect(clash.save({ ...project, name: 'Clash' })).rejects.toBeInstanceOf(ProjectConflictError);
    expect(JSON.parse((await rawRecords())[project.id]).name).toBe('Only');
  });

  it('rejects a save whose known revision is stale, keeping the stored bytes', async () => {
    const store = createServerStore();
    const project = createDefaultProject('First');
    await store.save(project);
    // Another device changes the project underneath this editor.
    await putRaw('projects', project.id, JSON.stringify({ ...project, name: 'Elsewhere' }));
    const before = await rawRecords();
    await expect(store.save({ ...project, name: 'Mine' })).rejects.toBeInstanceOf(ProjectConflictError);
    expect(await rawRecords()).toEqual(before);
  });

  it('flags a project changed elsewhere through assertCurrent', async () => {
    const store = createServerStore();
    const project = createDefaultProject();
    await store.save(project);
    await store.assertCurrent(project.id);
    await putRaw('projects', project.id, JSON.stringify({ ...project, name: 'Changed' }));
    await expect(store.assertCurrent(project.id)).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it('surfaces a write failure and preserves every previously saved byte', async () => {
    const store = createServerStore();
    const first = createDefaultProject('First');
    const second = createDefaultProject('Second');
    await store.save(first);
    await store.save(second);
    const before = await rawRecords();
    const restore = failWrites();
    await expect(store.save({ ...second, name: 'Unsaved change' })).rejects.toThrow();
    expect(await rawRecords()).toEqual(before);
    restore();
  });

  it('removes a project together with its thumbnail and version history', async () => {
    const store = createServerStore();
    const project = createDefaultProject();
    await store.save(project);
    await store.saveThumbnail(project.id, 'data:image/png;base64,AAAA');
    await putRaw('history', project.id, JSON.stringify([{ timestamp: 1, description: 'v', data: JSON.stringify(project) }]));
    await store.delete(project.id);
    expect(await store.load(project.id)).toBeNull();
    expect(await rawRecords('thumbnails')).toEqual({});
    expect(await rawRecords('history')).toEqual({});
  });

  it('refuses to delete a project changed elsewhere', async () => {
    const store = createServerStore();
    const project = createDefaultProject();
    await store.save(project);
    await putRaw('projects', project.id, JSON.stringify({ ...project, name: 'Changed' }));
    await expect(store.delete(project.id)).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it('does not create a partial duplicate when a write fails', async () => {
    const store = createServerStore();
    const project = createDefaultProject();
    await store.save(project);
    const before = await rawRecords();
    const restore = failWrites();
    await expect(store.duplicate(project.id)).rejects.toThrow();
    expect(await rawRecords()).toEqual(before);
    restore();
  });

  it('duplicates a project and copies its thumbnail', async () => {
    const store = createServerStore();
    const project = createDefaultProject('Original');
    await store.save(project);
    await store.saveThumbnail(project.id, 'data:image/png;base64,BBBB');
    const dup = await store.duplicate(project.id);
    expect(dup).not.toBeNull();
    expect(dup!.id).not.toBe(project.id);
    expect(dup!.name).toContain('Copy');
    expect(await store.getThumbnail(dup!.id)).toBe('data:image/png;base64,BBBB');
  });

  it('only attaches a thumbnail while the saved revision is current', async () => {
    const store = createServerStore();
    const project = createDefaultProject();
    await store.save(project);
    await putRaw('projects', project.id, JSON.stringify({ ...project, name: 'Superseded' }));
    await store.saveThumbnail(project.id, 'data:image/png;base64,CCCC');
    expect(await store.getThumbnail(project.id)).toBeNull();
  });
});

it('surfaces an unreadable stored project in the library list without hiding others', async () => {
  const store = createServerStore();
  const healthy = createDefaultProject('Healthy');
  await store.save(healthy);
  await putRaw('projects', 'broken', '{not json');
  const list = await store.list();
  expect(list).toHaveLength(2);
  const broken = list.find(entry => entry.id === 'broken');
  expect(broken?.name).toContain('Unreadable project');
});

it('rejects damaged nested geometry on load and duplicate without rewriting the library', async () => {
  const store = createServerStore();
  const project = createDefaultProject('Damaged');
  const damaged: any = JSON.parse(JSON.stringify(project));
  damaged.floors[0].walls = [{ id: 'wall', start: null, end: { x: 200, y: 0 }, thickness: 15 }];
  await putRaw('projects', project.id, JSON.stringify(damaged));
  const before = await rawRecords();
  await expect(store.load(project.id)).rejects.toThrow('walls[0].start');
  await expect(store.duplicate(project.id)).rejects.toThrow('walls[0].start');
  expect(await rawRecords()).toEqual(before);
});

it('does not load a project stored under another library entry ID', async () => {
  const store = createServerStore();
  const project = createDefaultProject();
  await putRaw('projects', 'wrong', JSON.stringify(project));
  await expect(store.load('wrong')).rejects.toThrow('does not match');
});

it.each(['__proto__', 'constructor', 'toString', 'a project?with#punctuation&spaces'])('round trips an imported project ID as data: %s', async id => {
  const store = createServerStore();
  const neighbor = createDefaultProject('Keep me');
  await store.save(neighbor);
  const project = { ...createDefaultProject('Imported'), id };
  await store.save(project);
  expect(await store.load(id)).toEqual(project);
  expect(await store.load(neighbor.id)).toEqual(neighbor);
  expect(await store.list()).toHaveLength(2);
  await store.delete(id);
  expect(await store.load(id)).toBeNull();
  expect(await store.load(neighbor.id)).toEqual(neighbor);
});

it('does not mistake inherited object properties for saved projects', async () => {
  const store = createServerStore();
  await expect(store.load('constructor')).resolves.toBeNull();
  await expect(store.load('__proto__')).resolves.toBeNull();
});
