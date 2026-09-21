import { randomUUID } from 'node:crypto';
import type { Floor, Project } from '$lib/models/types';
import { ConflictError, type ProjectStore } from './projectStore';
import { applyOperations, createEmptyProject, EditError } from './agentEdits';
import { readProject } from '$lib/utils/projectValidation';
import { getRoomPolygon } from '$lib/utils/roomDetection';
import { wallLength } from '$lib/utils/wallEditing';
import { furnitureCatalog, getFurnitureSize } from '$lib/utils/furnitureCatalog';

/** A native Model Context Protocol server over streamable HTTP, stateless, that
 * lets an agent inspect and edit the floor-plan project library. Every call
 * reads or writes whole project documents through the same store the editor
 * uses, and reuses the app's pure geometry layer so a written document is always
 * internally consistent. */
export const AGENT_MCP_PROTOCOL_VERSION = '2025-06-18';
export const AGENT_MCP_SERVER_INFO = { name: 'openplan3d-projects', version: '0.1.0' };
export const AGENT_MCP_INSTRUCTIONS =
  'Inspect and edit OpenPlan3D floor-plan projects. All coordinates and lengths are in centimetres in one shared world ' +
  'space; the x axis runs left→right and y runs top→bottom. A door or window sits on a wall at a `position` fraction ' +
  'from 0 (its start) to 1 (its end). Ground new geometry in the existing plan: call `describe_floor` first to read the ' +
  'current wall endpoints and room coordinates, then place walls, openings and furniture relative to them. Room areas are ' +
  'derived from the walls by the app — never invent them; add or move walls and re-read the floor. Use `apply_edits` to ' +
  'change a project: it applies an ordered list of operations to one floor in a single atomic write, re-derives the rooms, ' +
  'and validates the result, reporting a precise error you can correct and retry. If a write reports the project changed ' +
  'elsewhere, re-read it and reapply.';

/** Read tools carry these hints so a client auto-allows them and holds writes
 * for approval. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const projectIdArg = {
  projectId: { type: 'string', description: 'Id of the project (a UUID from list_projects).' },
} as const;

const pointSchema = {
  type: 'object',
  description: 'A world-space point in centimetres.',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
};

/** The discriminated union of edit operations, one variant per `type`, with
 * units stated so an agent can construct them from `describe_floor` output. */
const operationSchema = {
  type: 'object',
  description: 'One edit operation, discriminated by `type`.',
  oneOf: [
    {
      title: 'add_wall',
      properties: {
        type: { const: 'add_wall' },
        start: pointSchema,
        end: pointSchema,
        thickness: { type: 'number', description: 'Wall thickness in cm (default 15).' },
        height: { type: 'number', description: 'Wall height in cm (default 280).' },
      },
      required: ['type', 'start', 'end'],
    },
    {
      title: 'move_wall',
      properties: {
        type: { const: 'move_wall' },
        id: { type: 'string', description: 'Id of the wall to move.' },
        start: pointSchema,
        end: pointSchema,
      },
      required: ['type', 'id'],
    },
    {
      title: 'delete_wall',
      properties: {
        type: { const: 'delete_wall' },
        id: { type: 'string', description: 'Id of the wall to delete; its doors and windows go too.' },
      },
      required: ['type', 'id'],
    },
    {
      title: 'add_door',
      properties: {
        type: { const: 'add_door' },
        wallId: { type: 'string', description: 'Id of the wall the door sits on.' },
        position: { type: 'number', description: 'Fraction 0–1 along the wall.' },
        doorType: { type: 'string', enum: ['single', 'double', 'sliding', 'french', 'pocket', 'bifold', 'opening', 'garage'], description: 'Default single.' },
        width: { type: 'number', description: 'Override width in cm.' },
        height: { type: 'number', description: 'Override height in cm.' },
      },
      required: ['type', 'wallId', 'position'],
    },
    {
      title: 'add_window',
      properties: {
        type: { const: 'add_window' },
        wallId: { type: 'string', description: 'Id of the wall the window sits on.' },
        position: { type: 'number', description: 'Fraction 0–1 along the wall.' },
        windowType: { type: 'string', enum: ['standard', 'fixed', 'casement', 'sliding', 'bay'], description: 'Default standard.' },
        width: { type: 'number', description: 'Override width in cm.' },
        height: { type: 'number', description: 'Override height in cm.' },
      },
      required: ['type', 'wallId', 'position'],
    },
    {
      title: 'add_furniture',
      properties: {
        type: { const: 'add_furniture' },
        catalogId: { type: 'string', description: 'A catalog id from list_furniture_catalog.' },
        position: pointSchema,
        rotation: { type: 'number', description: 'Rotation in degrees (default 0).' },
        width: { type: 'number', description: 'Override footprint width in cm.' },
        depth: { type: 'number', description: 'Override footprint depth in cm.' },
        height: { type: 'number', description: 'Override height in cm.' },
      },
      required: ['type', 'catalogId', 'position'],
    },
    {
      title: 'move_item',
      properties: {
        type: { const: 'move_item' },
        id: { type: 'string', description: 'Id of the furniture item to move.' },
        position: pointSchema,
        rotation: { type: 'number', description: 'New rotation in degrees.' },
      },
      required: ['type', 'id'],
    },
    {
      title: 'delete_item',
      properties: {
        type: { const: 'delete_item' },
        id: { type: 'string', description: 'Id of a furniture item, door, window, column or stair to delete.' },
      },
      required: ['type', 'id'],
    },
    {
      title: 'add_room',
      properties: {
        type: { const: 'add_room' },
        center: pointSchema,
        width: { type: 'number', description: 'Room width in cm (default 400).' },
        height: { type: 'number', description: 'Room depth in cm (default 300).' },
        name: { type: 'string', description: 'Optional room name.' },
        wallThickness: { type: 'number', description: 'Wall thickness in cm (default 15).' },
        wallHeight: { type: 'number', description: 'Wall height in cm (default 280).' },
      },
      required: ['type', 'center'],
    },
  ],
};

export function agentMcpTools() {
  return [
    { name: 'list_projects', annotations: READ_ONLY, description: 'List every floor-plan project with its id, name and last-updated time.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_project', annotations: READ_ONLY, description: 'Get one project as the full structured document (floors, walls, rooms, openings, furniture).', inputSchema: { type: 'object', properties: { ...projectIdArg }, required: ['projectId'] } },
    { name: 'summarize_project', annotations: READ_ONLY, description: 'Summarize a project: per-floor room areas and element counts.', inputSchema: { type: 'object', properties: { ...projectIdArg }, required: ['projectId'] } },
    { name: 'describe_floor', annotations: READ_ONLY, description: 'Describe one floor with coordinates: walls with endpoints and lengths, rooms with polygons and areas, doors and windows, and furniture positions. Read this before placing new geometry.', inputSchema: { type: 'object', properties: { ...projectIdArg, floorId: { type: 'string', description: 'Floor id; defaults to the active floor.' } }, required: ['projectId'] } },
    { name: 'list_furniture_catalog', annotations: READ_ONLY, description: 'List the furniture catalog: each id with its name, category and default size in cm.', inputSchema: { type: 'object', properties: {} } },
    { name: 'create_project', annotations: WRITE, description: 'Create a new empty project with a single ground floor. Returns the new project id.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Project name.' }, description: { type: 'string', description: 'Optional description.' } }, required: ['name'] } },
    { name: 'duplicate_project', annotations: WRITE, description: 'Duplicate a project into a new independent copy. Returns the new project id.', inputSchema: { type: 'object', properties: { ...projectIdArg, name: { type: 'string', description: 'Name for the copy (default "<name> (copy)").' } }, required: ['projectId'] } },
    { name: 'delete_project', annotations: DESTRUCTIVE, description: 'Permanently delete a project and its thumbnail and history.', inputSchema: { type: 'object', properties: { ...projectIdArg }, required: ['projectId'] } },
    { name: 'apply_edits', annotations: WRITE, description: 'Apply an ordered list of edit operations to one floor of a project in a single atomic write, re-derive rooms and validate. Coordinates are cm. Call describe_floor first to ground new geometry.', inputSchema: { type: 'object', properties: { ...projectIdArg, floorId: { type: 'string', description: 'Floor id; defaults to the active floor.' }, operations: { type: 'array', minItems: 1, items: operationSchema, description: 'The operations to apply in order.' } }, required: ['projectId', 'operations'] } },
  ];
}

class ToolError extends Error {}

async function loadProject(store: ProjectStore, projectId: unknown): Promise<{ project: Project; etag: string }> {
  if (typeof projectId !== 'string' || !projectId) throw new ToolError('projectId is required');
  const record = await store.read('projects', projectId);
  if (record === null) throw new ToolError(`No project with id ${projectId}.`);
  try {
    return { project: readProject(JSON.parse(record.raw)), etag: record.etag };
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : 'The stored project could not be read.');
  }
}

function resolveFloor(project: Project, floorId: unknown): Floor {
  if (floorId !== undefined && typeof floorId !== 'string') throw new ToolError('floorId must be a string');
  const id = (floorId as string | undefined) ?? project.activeFloorId;
  const floor = project.floors.find((f) => f.id === id);
  if (!floor) throw new ToolError(`No floor with id ${id} in project ${project.id}.`);
  return floor;
}

function floorSummary(floor: Floor) {
  return {
    id: floor.id,
    name: floor.name,
    level: floor.level,
    wallCount: floor.walls.length,
    doorCount: floor.doors.length,
    windowCount: floor.windows.length,
    furnitureCount: floor.furniture.length,
    roomCount: floor.rooms.length,
    floorArea: Math.round(floor.rooms.reduce((sum, room) => sum + (room.floorOpening ? 0 : room.area), 0) * 100) / 100,
    rooms: floor.rooms.map((room) => ({ id: room.id, name: room.name, area: room.area })),
  };
}

function describeFloor(floor: Floor) {
  return {
    id: floor.id,
    name: floor.name,
    level: floor.level,
    units: 'centimetres',
    walls: floor.walls.map((wall) => ({
      id: wall.id,
      start: wall.start,
      end: wall.end,
      length: Math.round(wallLength(wall) * 100) / 100,
      thickness: wall.thickness,
      height: wall.height,
    })),
    rooms: floor.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      area: room.area,
      floorOpening: room.floorOpening === true,
      walls: room.walls,
      polygon: getRoomPolygon(room, floor.walls),
    })),
    doors: floor.doors.map((door) => ({ id: door.id, wallId: door.wallId, position: door.position, width: door.width, height: door.height, type: door.type })),
    windows: floor.windows.map((win) => ({ id: win.id, wallId: win.wallId, position: win.position, width: win.width, height: win.height, type: win.type })),
    furniture: floor.furniture.map((item) => ({ id: item.id, catalogId: item.catalogId, position: item.position, rotation: item.rotation, size: getFurnitureSize(item) })),
  };
}

async function callTool(name: string, args: Record<string, unknown>, store: ProjectStore): Promise<unknown> {
  switch (name) {
    case 'list_projects': {
      const entries = await store.listProjects();
      return { projects: entries.map((e) => ({ id: e.id, name: e.name, updatedAt: e.updatedAt, readable: e.readable })) };
    }
    case 'get_project': {
      const { project } = await loadProject(store, args.projectId);
      return project;
    }
    case 'summarize_project': {
      const { project } = await loadProject(store, args.projectId);
      const floors = project.floors.map(floorSummary);
      return {
        id: project.id,
        name: project.name,
        units: 'square metres for areas, centimetres for coordinates',
        floors,
        totals: {
          floorCount: floors.length,
          wallCount: floors.reduce((s, f) => s + f.wallCount, 0),
          doorCount: floors.reduce((s, f) => s + f.doorCount, 0),
          windowCount: floors.reduce((s, f) => s + f.windowCount, 0),
          furnitureCount: floors.reduce((s, f) => s + f.furnitureCount, 0),
          roomCount: floors.reduce((s, f) => s + f.roomCount, 0),
          floorArea: Math.round(floors.reduce((s, f) => s + f.floorArea, 0) * 100) / 100,
        },
      };
    }
    case 'describe_floor': {
      const { project } = await loadProject(store, args.projectId);
      return describeFloor(resolveFloor(project, args.floorId));
    }
    case 'list_furniture_catalog': {
      return {
        units: 'centimetres',
        items: furnitureCatalog.map((f) => ({ id: f.id, name: f.name, category: f.category, width: f.width, depth: f.depth, height: f.height })),
      };
    }
    case 'create_project': {
      if (typeof args.name !== 'string' || !args.name.trim()) throw new ToolError('name is required');
      if (args.description !== undefined && typeof args.description !== 'string') throw new ToolError('description must be a string');
      const project = readProject(createEmptyProject(args.name, args.description as string | undefined));
      await store.write('projects', project.id, JSON.stringify(project), { ifNoneMatch: true });
      return { id: project.id, name: project.name };
    }
    case 'duplicate_project': {
      const { project } = await loadProject(store, args.projectId);
      if (args.name !== undefined && typeof args.name !== 'string') throw new ToolError('name must be a string');
      const name = typeof args.name === 'string' && args.name.trim() ? args.name : `${project.name} (copy)`;
      const copy = readProject({ ...project, id: randomUUID(), name, createdAt: new Date(), updatedAt: new Date() });
      await store.write('projects', copy.id, JSON.stringify(copy), { ifNoneMatch: true });
      return { id: copy.id, name: copy.name };
    }
    case 'delete_project': {
      if (typeof args.projectId !== 'string' || !args.projectId) throw new ToolError('projectId is required');
      const record = await store.read('projects', args.projectId);
      if (record === null) throw new ToolError(`No project with id ${args.projectId}.`);
      await store.deleteProject(args.projectId, { ifMatch: record.etag });
      return { id: args.projectId, deleted: true };
    }
    case 'apply_edits': {
      const { project, etag } = await loadProject(store, args.projectId);
      let edited;
      try {
        edited = applyOperations(project, args.floorId as string | undefined, args.operations);
      } catch (error) {
        if (error instanceof EditError || (error instanceof Error && error.message.startsWith('Invalid project:'))) {
          throw new ToolError(error.message);
        }
        throw error;
      }
      try {
        await store.write('projects', project.id, JSON.stringify(edited.project), { ifMatch: etag });
      } catch (error) {
        if (error instanceof ConflictError) throw new ToolError('The project changed elsewhere. Re-read it and reapply your edits.');
        throw error;
      }
      return { id: project.id, applied: edited.results, floor: describeFloor(resolveFloor(edited.project, args.floorId)) };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

export interface AgentMcpDeps {
  store: ProjectStore;
}

/** One JSON-RPC message in, one response out; null for notifications. */
export async function handleAgentMcpMessage(message: unknown, deps: AgentMcpDeps): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof (message as { method?: unknown }).method !== 'string') {
    return { jsonrpc: '2.0', id: (message as { id?: unknown })?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  }
  const { method, id } = message as { method: string; id?: unknown };
  const params = ((message as { params?: unknown }).params ?? {}) as Record<string, unknown>;
  if (method.startsWith('notifications/') || id === undefined || id === null) return null;
  try {
    let result: unknown;
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' && params.protocolVersion ? params.protocolVersion : AGENT_MCP_PROTOCOL_VERSION;
      result = { protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: AGENT_MCP_SERVER_INFO, instructions: AGENT_MCP_INSTRUCTIONS };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: agentMcpTools() };
    else if (method === 'resources/list') result = { resources: [] };
    else if (method === 'prompts/list') result = { prompts: [] };
    else if (method === 'tools/call') {
      const name = String(params.name);
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const value = await callTool(name, args, deps.store);
        result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false };
      } catch (error) {
        if (error instanceof ToolError) result = { content: [{ type: 'text', text: error.message }], isError: true };
        else throw error;
      }
    } else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    console.error(JSON.stringify({ event: 'agent_mcp_internal_error', method, kind: error instanceof Error ? error.name : 'unknown' }));
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'The project MCP is temporarily unavailable.' } };
  }
}
