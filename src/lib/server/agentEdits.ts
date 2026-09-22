import { randomUUID } from 'node:crypto';
import type { Door, Floor, FurnitureItem, Point, Project, Window as Win } from '$lib/models/types';
import { readProject } from '$lib/utils/projectValidation';
import { resolveRooms } from '$lib/utils/roomDetection';
import { getCatalogItem } from '$lib/utils/furnitureCatalog';

/** A caller-facing edit failure. The message is safe to return as a tool error
 * so an agent can correct the operation and retry. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

/** New-wall defaults, mirroring the editor's `addWall` so an agent-drawn wall
 * matches a hand-drawn one (thickness and height in centimetres). */
const WALL_DEFAULTS = { thickness: 15, height: 280, startHeight: 280, endHeight: 280, color: '#444444' };

/** Per-type door sizes in centimetres, mirroring the editor's `addDoor`. */
const DOOR_SIZES: Record<Door['type'], { width: number; height: number }> = {
  single: { width: 90, height: 210 },
  double: { width: 150, height: 210 },
  sliding: { width: 180, height: 210 },
  french: { width: 150, height: 210 },
  pocket: { width: 90, height: 210 },
  bifold: { width: 180, height: 210 },
  opening: { width: 100, height: 210 },
  garage: { width: 240, height: 210 },
};

/** Per-type window sizes in centimetres, mirroring the editor's `addWindow`. */
const WINDOW_SIZES: Record<Win['type'], { width: number; height: number }> = {
  standard: { width: 120, height: 120 },
  fixed: { width: 100, height: 100 },
  casement: { width: 80, height: 130 },
  sliding: { width: 180, height: 120 },
  bay: { width: 200, height: 150 },
};

/** One edit applied to a floor. Coordinates and lengths are centimetres in the
 * shared world space; a door/window `position` is a fraction 0–1 along its wall.
 * The union is discriminated by `type`. */
export type EditOperation =
  | { type: 'add_wall'; start: Point; end: Point; thickness?: number; height?: number }
  | { type: 'move_wall'; id: string; start?: Point; end?: Point }
  | { type: 'delete_wall'; id: string }
  | { type: 'add_door'; wallId: string; position: number; doorType?: Door['type']; width?: number; height?: number }
  | { type: 'add_window'; wallId: string; position: number; windowType?: Win['type']; width?: number; height?: number }
  | { type: 'add_furniture'; catalogId: string; position: Point; rotation?: number; width?: number; depth?: number; height?: number }
  | { type: 'move_item'; id: string; position?: Point; rotation?: number }
  | { type: 'delete_item'; id: string }
  | { type: 'add_room'; center: Point; width?: number; height?: number; name?: string; wallThickness?: number; wallHeight?: number };

/** What one operation changed, echoed back so an agent can reference the new
 * element by id in a follow-up call. */
export interface OperationResult {
  type: EditOperation['type'];
  /** Ids the operation created (walls, openings, furniture, or a room). */
  created?: string[];
  /** The element the operation changed or removed. */
  target?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EditError(`${label} must be a finite number`);
  return value;
}

function readPositive(value: unknown, label: string): number {
  const n = readNumber(value, label);
  if (n <= 0) throw new EditError(`${label} must be greater than zero`);
  return n;
}

function readPoint(value: unknown, label: string): Point {
  if (!isRecord(value)) throw new EditError(`${label} must be a { x, y } point`);
  return { x: readNumber(value.x, `${label}.x`), y: readNumber(value.y, `${label}.y`) };
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new EditError(`${label} must be a non-empty string`);
  return value;
}

function readChoice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new EditError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

const DOOR_TYPES = ['single', 'double', 'sliding', 'french', 'pocket', 'bifold', 'opening', 'garage'] as const;
const WINDOW_TYPES = ['standard', 'fixed', 'casement', 'sliding', 'bay'] as const;

function requireWall(floor: Floor, wallId: string): void {
  if (!floor.walls.some((wall) => wall.id === wallId)) {
    throw new EditError(`wallId ${wallId} is not a wall on this floor`);
  }
}

function readPosition(value: unknown): number {
  const n = readNumber(value, 'position');
  if (n < 0 || n > 1) throw new EditError('position must be a fraction between 0 and 1 along the wall');
  return n;
}

/** Apply one operation to `floor` in place and describe what it changed. */
function applyOne(floor: Floor, op: unknown): OperationResult {
  if (!isRecord(op) || typeof op.type !== 'string') throw new EditError('each operation must be an object with a "type"');
  switch (op.type) {
    case 'add_wall': {
      const id = randomUUID();
      floor.walls.push({
        id,
        start: readPoint(op.start, 'start'),
        end: readPoint(op.end, 'end'),
        ...WALL_DEFAULTS,
        ...(op.thickness !== undefined ? { thickness: readPositive(op.thickness, 'thickness') } : {}),
        ...(op.height !== undefined ? { height: readPositive(op.height, 'height') } : {}),
      });
      return { type: 'add_wall', created: [id] };
    }
    case 'move_wall': {
      const id = readString(op.id, 'id');
      const wall = floor.walls.find((w) => w.id === id);
      if (!wall) throw new EditError(`id ${id} is not a wall on this floor`);
      if (op.start === undefined && op.end === undefined) throw new EditError('move_wall needs a new start and/or end');
      if (op.start !== undefined) wall.start = readPoint(op.start, 'start');
      if (op.end !== undefined) wall.end = readPoint(op.end, 'end');
      return { type: 'move_wall', target: id };
    }
    case 'delete_wall': {
      const id = readString(op.id, 'id');
      if (!floor.walls.some((w) => w.id === id)) throw new EditError(`id ${id} is not a wall on this floor`);
      floor.walls = floor.walls.filter((w) => w.id !== id);
      // Openings reference a wall by id; drop the orphans the wall carried.
      floor.doors = floor.doors.filter((d) => d.wallId !== id);
      floor.windows = floor.windows.filter((w) => w.wallId !== id);
      return { type: 'delete_wall', target: id };
    }
    case 'add_door': {
      const wallId = readString(op.wallId, 'wallId');
      requireWall(floor, wallId);
      const doorType = op.doorType === undefined ? 'single' : readChoice(op.doorType, DOOR_TYPES, 'doorType');
      const size = DOOR_SIZES[doorType];
      const id = randomUUID();
      floor.doors.push({
        id,
        wallId,
        position: readPosition(op.position),
        width: op.width !== undefined ? readPositive(op.width, 'width') : size.width,
        height: op.height !== undefined ? readPositive(op.height, 'height') : size.height,
        type: doorType,
        swingDirection: 'left',
        flipSide: false,
      });
      return { type: 'add_door', created: [id] };
    }
    case 'add_window': {
      const wallId = readString(op.wallId, 'wallId');
      requireWall(floor, wallId);
      const windowType = op.windowType === undefined ? 'standard' : readChoice(op.windowType, WINDOW_TYPES, 'windowType');
      const size = WINDOW_SIZES[windowType];
      const id = randomUUID();
      floor.windows.push({
        id,
        wallId,
        position: readPosition(op.position),
        width: op.width !== undefined ? readPositive(op.width, 'width') : size.width,
        height: op.height !== undefined ? readPositive(op.height, 'height') : size.height,
        sillHeight: 90,
        type: windowType,
      });
      return { type: 'add_window', created: [id] };
    }
    case 'add_furniture': {
      const catalogId = readString(op.catalogId, 'catalogId');
      if (!getCatalogItem(catalogId)) throw new EditError(`catalogId ${catalogId} is not in the furniture catalog`);
      const id = randomUUID();
      const item: FurnitureItem = {
        id,
        catalogId,
        position: readPoint(op.position, 'position'),
        rotation: op.rotation !== undefined ? readNumber(op.rotation, 'rotation') : 0,
        scale: { x: 1, y: 1, z: 1 },
      };
      if (op.width !== undefined) item.width = readPositive(op.width, 'width');
      if (op.depth !== undefined) item.depth = readPositive(op.depth, 'depth');
      if (op.height !== undefined) item.height = readPositive(op.height, 'height');
      floor.furniture.push(item);
      return { type: 'add_furniture', created: [id] };
    }
    case 'move_item': {
      const id = readString(op.id, 'id');
      const item = floor.furniture.find((f) => f.id === id);
      if (!item) throw new EditError(`id ${id} is not a furniture item on this floor`);
      if (op.position === undefined && op.rotation === undefined) throw new EditError('move_item needs a new position and/or rotation');
      if (op.position !== undefined) item.position = readPoint(op.position, 'position');
      if (op.rotation !== undefined) item.rotation = readNumber(op.rotation, 'rotation');
      return { type: 'move_item', target: id };
    }
    case 'delete_item': {
      const id = readString(op.id, 'id');
      const before =
        floor.furniture.length + floor.doors.length + floor.windows.length + floor.columns.length + floor.stairs.length;
      floor.furniture = floor.furniture.filter((f) => f.id !== id);
      floor.doors = floor.doors.filter((d) => d.id !== id);
      floor.windows = floor.windows.filter((w) => w.id !== id);
      floor.columns = floor.columns.filter((c) => c.id !== id);
      floor.stairs = floor.stairs.filter((s) => s.id !== id);
      const after =
        floor.furniture.length + floor.doors.length + floor.windows.length + floor.columns.length + floor.stairs.length;
      if (after === before) throw new EditError(`id ${id} is not a furniture item, opening, column or stair on this floor`);
      return { type: 'delete_item', target: id };
    }
    case 'add_room': {
      const center = readPoint(op.center, 'center');
      const width = op.width !== undefined ? readPositive(op.width, 'width') : 400;
      const height = op.height !== undefined ? readPositive(op.height, 'height') : 300;
      const thickness = op.wallThickness !== undefined ? readPositive(op.wallThickness, 'wallThickness') : WALL_DEFAULTS.thickness;
      const wallHeight = op.wallHeight !== undefined ? readPositive(op.wallHeight, 'wallHeight') : WALL_DEFAULTS.height;
      const name = op.name === undefined ? '' : (typeof op.name === 'string' ? op.name : readString(op.name, 'name'));
      const hw = width / 2;
      const hh = height / 2;
      const corners: Point[] = [
        { x: center.x - hw, y: center.y - hh },
        { x: center.x + hw, y: center.y - hh },
        { x: center.x + hw, y: center.y + hh },
        { x: center.x - hw, y: center.y + hh },
      ];
      const wallIds: string[] = [];
      for (let i = 0; i < corners.length; i++) {
        const id = randomUUID();
        wallIds.push(id);
        floor.walls.push({
          id,
          start: corners[i],
          end: corners[(i + 1) % corners.length],
          ...WALL_DEFAULTS,
          thickness,
          height: wallHeight,
          startHeight: wallHeight,
          endHeight: wallHeight,
        });
      }
      // Seed the room metadata so the re-derivation below keeps the given name.
      // resolveRooms matches a saved room to a detected cycle by its wall-id set,
      // so this placeholder's name survives onto the detected room.
      const roomId = randomUUID();
      floor.rooms.push({ id: roomId, name, walls: [...wallIds], floorTexture: 'hardwood', area: 0 });
      return { type: 'add_room', created: [...wallIds, roomId] };
    }
    default:
      throw new EditError(`unknown operation type: ${op.type}`);
  }
}

/** Apply an ordered list of operations to one floor of `project`, re-derive the
 * floor's rooms from the new wall geometry, then validate the whole document.
 *
 * The input is cloned, so the caller's project is never mutated. Every stage is
 * pure — no store, no DOM — so the engine runs headless in the server. A bad
 * operation, or a document the validator rejects, throws {@link EditError} (or a
 * precise `Invalid project: …` from the validator) which the caller surfaces as
 * a tool error. On success the returned project is internally consistent and
 * ready to persist. */
export function applyOperations(project: Project, floorId: string | undefined, operations: unknown): {
  project: Project;
  results: OperationResult[];
} {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new EditError('operations must be a non-empty array');
  }
  const draft = structuredClone(project);
  const targetId = floorId ?? draft.activeFloorId;
  const floor = draft.floors.find((f) => f.id === targetId);
  if (!floor) throw new EditError(`floorId ${targetId} is not a floor in this project`);

  const results: OperationResult[] = [];
  for (const [index, op] of operations.entries()) {
    try {
      results.push(applyOne(floor, op));
    } catch (error) {
      const type = isRecord(op) && typeof op.type === 'string' ? op.type : 'unknown';
      const reason = error instanceof Error ? error.message : String(error);
      throw new EditError(`operations[${index}] (${type}): ${reason}`);
    }
  }

  // Re-derive rooms and their areas from the edited walls, preserving the name
  // and finish of every room whose boundary survived (resolveRooms keys on the
  // wall-id set). This is the same pass the editor runs after a wall edit.
  floor.rooms = resolveRooms(floor, floor.rooms);
  draft.updatedAt = new Date();

  // The strict validator normalises the document and throws a precise message on
  // anything malformed, so a persisted project is always internally consistent.
  return { project: readProject(draft), results };
}

/** A fresh, empty single-floor project, ready to validate and persist. */
export function createEmptyProject(name: string, description?: string): Project {
  const floor: Floor = {
    id: randomUUID(),
    name: 'Ground Floor',
    level: 0,
    walls: [],
    rooms: [],
    doors: [],
    windows: [],
    furniture: [],
    stairs: [],
    columns: [],
    guides: [],
    measurements: [],
    annotations: [],
    textAnnotations: [],
    groups: [],
  };
  return {
    id: randomUUID(),
    name,
    ...(description !== undefined ? { description } : {}),
    floors: [floor],
    activeFloorId: floor.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
