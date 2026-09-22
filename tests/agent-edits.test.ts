import { describe, expect, it } from 'vitest';
import { readProject } from '$lib/utils/projectValidation';
import { applyOperations, createEmptyProject, EditError, type EditOperation } from '$lib/server/agentEdits';

const base = () => readProject(createEmptyProject('Test'));

/** The four walls of a rectangle, sharing endpoints so a room encloses. */
const rectangleWalls = (): EditOperation[] => [
  { type: 'add_wall', start: { x: 0, y: 0 }, end: { x: 400, y: 0 } },
  { type: 'add_wall', start: { x: 400, y: 0 }, end: { x: 400, y: 300 } },
  { type: 'add_wall', start: { x: 400, y: 300 }, end: { x: 0, y: 300 } },
  { type: 'add_wall', start: { x: 0, y: 300 }, end: { x: 0, y: 0 } },
];

describe('applyOperations', () => {
  it('derives a room from four enclosing walls', () => {
    const { project, results } = applyOperations(base(), undefined, rectangleWalls());
    const floor = project.floors[0];
    expect(floor.walls).toHaveLength(4);
    expect(floor.rooms).toHaveLength(1);
    expect(floor.rooms[0].area).toBeGreaterThan(0);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.type === 'add_wall' && r.created?.length === 1)).toBe(true);
  });

  it('adds a named room in one operation', () => {
    const { project } = applyOperations(base(), undefined, [
      { type: 'add_room', center: { x: 200, y: 200 }, width: 400, height: 300, name: 'Study' },
    ]);
    const floor = project.floors[0];
    expect(floor.walls).toHaveLength(4);
    expect(floor.rooms).toHaveLength(1);
    expect(floor.rooms[0].name).toBe('Study');
    expect(floor.rooms[0].area).toBeGreaterThan(0);
  });

  it('adds a door on a wall and drops it when the wall is deleted', () => {
    const withWalls = applyOperations(base(), undefined, rectangleWalls()).project;
    const wallId = withWalls.floors[0].walls[0].id;
    const withDoor = applyOperations(withWalls, undefined, [
      { type: 'add_door', wallId, position: 0.5, doorType: 'single' },
    ]).project;
    expect(withDoor.floors[0].doors).toHaveLength(1);

    const afterDelete = applyOperations(withDoor, undefined, [{ type: 'delete_wall', id: wallId }]).project;
    expect(afterDelete.floors[0].walls).toHaveLength(3);
    expect(afterDelete.floors[0].doors).toHaveLength(0);
  });

  it('places furniture from the catalog and moves it', () => {
    const placed = applyOperations(base(), undefined, [
      { type: 'add_furniture', catalogId: 'sofa', position: { x: 100, y: 100 } },
    ]).project;
    const item = placed.floors[0].furniture[0];
    expect(item.catalogId).toBe('sofa');

    const moved = applyOperations(placed, undefined, [
      { type: 'move_item', id: item.id, position: { x: 250, y: 250 }, rotation: 90 },
    ]).project;
    expect(moved.floors[0].furniture[0].position).toEqual({ x: 250, y: 250 });
    expect(moved.floors[0].furniture[0].rotation).toBe(90);
  });

  it('rejects an unknown furniture id, a bad door position and a non-array', () => {
    expect(() => applyOperations(base(), undefined, [{ type: 'add_furniture', catalogId: 'nope', position: { x: 0, y: 0 } }]))
      .toThrow(EditError);
    const withWalls = applyOperations(base(), undefined, rectangleWalls()).project;
    const wallId = withWalls.floors[0].walls[0].id;
    expect(() => applyOperations(withWalls, undefined, [{ type: 'add_door', wallId, position: 2 }])).toThrow(/0 and 1/);
    expect(() => applyOperations(base(), undefined, [])).toThrow(EditError);
    expect(() => applyOperations(base(), 'no-such-floor', rectangleWalls())).toThrow(/floorId/);
  });

  it('surfaces the operation index in the error message', () => {
    expect(() => applyOperations(base(), undefined, [
      { type: 'add_wall', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'move_item', id: 'missing' },
    ])).toThrow(/operations\[1\]/);
  });
});
