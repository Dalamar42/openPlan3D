import { beforeEach, expect, it } from 'vitest';
import { MemoryBackend, ProjectStore } from '$lib/server/projectStore';
import { agentMcpTools, handleAgentMcpMessage } from '$lib/server/agentMcp';

let store: ProjectStore;
beforeEach(() => {
  store = new ProjectStore(new MemoryBackend());
});

const rpc = (method: string, params: unknown = {}, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });
// The handler is JSON-RPC-shaped (`{ result }`); tests read the loosely-typed
// result payload, so cast once here rather than at every assertion.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> =>
  (await handleAgentMcpMessage(rpc('tools/call', { name, arguments: args }), { store }))!.result;

it('handshakes and lists read tools as read-only, writes and delete as not', async () => {
  const init = await handleAgentMcpMessage(rpc('initialize', { protocolVersion: '2025-03-26' }), { store });
  expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: 'openplan3d-projects' } } });
  expect(await handleAgentMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { store })).toBeNull();

  const tools = agentMcpTools();
  const read = ['list_projects', 'get_project', 'summarize_project', 'describe_floor', 'list_furniture_catalog'];
  expect(tools.every((t) => (read.includes(t.name) ? t.annotations.readOnlyHint === true : t.annotations.readOnlyHint === false))).toBe(true);
  expect(tools.find((t) => t.name === 'delete_project')!.annotations).toMatchObject({ destructiveHint: true });
});

it('creates, reads, edits, summarizes and deletes a project', async () => {
  const created = await call('create_project', { name: 'Cabin' });
  expect(created.structuredContent.id).toBeTruthy();
  const id = created.structuredContent.id as string;

  const list = (await call('list_projects')).structuredContent;
  expect(list.projects.map((p: { id: string }) => p.id)).toContain(id);

  const edit = await call('apply_edits', {
    projectId: id,
    operations: [{ type: 'add_room', center: { x: 200, y: 150 }, width: 400, height: 300, name: 'Main' }],
  });
  expect(edit.isError).toBe(false);
  expect(edit.structuredContent.applied).toHaveLength(1);
  expect(edit.structuredContent.floor.rooms).toHaveLength(1);
  expect(edit.structuredContent.floor.walls).toHaveLength(4);

  const summary = (await call('summarize_project', { projectId: id })).structuredContent;
  expect(summary.totals.roomCount).toBe(1);
  expect(summary.totals.wallCount).toBe(4);
  expect(summary.floors[0].rooms[0].name).toBe('Main');

  const describe = (await call('describe_floor', { projectId: id })).structuredContent;
  expect(describe.units).toBe('centimetres');
  expect(describe.walls).toHaveLength(4);

  const deleted = await call('delete_project', { projectId: id });
  expect(deleted.structuredContent).toMatchObject({ deleted: true });
  expect((await call('get_project', { projectId: id })).isError).toBe(true);
});

it('reports a validation error and a missing project as tool errors', async () => {
  const created = (await call('create_project', { name: 'X' })).structuredContent as { id: string };
  const bad = await call('apply_edits', { projectId: created.id, operations: [{ type: 'nope' }] });
  expect(bad).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unknown operation type/) }] });
  const missing = await call('get_project', { projectId: 'does-not-exist' });
  expect(missing).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/No project with id/) }] });
});

it('duplicates a project into an independent copy', async () => {
  const created = (await call('create_project', { name: 'Original' })).structuredContent as { id: string };
  await call('apply_edits', { projectId: created.id, operations: [{ type: 'add_room', center: { x: 0, y: 0 } }] });
  const copy = (await call('duplicate_project', { projectId: created.id })).structuredContent as { id: string; name: string };
  expect(copy.id).not.toBe(created.id);
  expect(copy.name).toBe('Original (copy)');
  const copyDoc = (await call('get_project', { projectId: copy.id })).structuredContent;
  expect(copyDoc.floors[0].rooms).toHaveLength(1);
});
