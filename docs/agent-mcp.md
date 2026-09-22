# Project MCP: inspect and edit floor plans

An authenticated Model Context Protocol server that lets an agent both **inspect**
the server-side project library and **modify** projects — insert a wall, add a
door, place furniture, add a room, or create, duplicate and delete a project. It
runs in-process in the SvelteKit server with direct access to the project store
and the app's pure geometry layer, so a written document is always internally
consistent.

This is separate from the read-only [assistant shares](./assistant-shares.md)
MCP (`/mcp`), which serves an uploaded share package by code and secret. The
project MCP reads and writes the live library instead.

## Endpoint and authentication

| Method and path | Purpose |
| --- | --- |
| `POST /mcp/agent` | Model Context Protocol, streamable HTTP, stateless JSON-RPC. `GET`/`DELETE` return 405. |

The endpoint requires `Authorization: Bearer $OPENPLAN3D_MCP_TOKEN`. It is
**closed until the token is set**: with `OPENPLAN3D_MCP_TOKEN` unset every POST
answers `503`, and a missing or wrong bearer answers `401`. The token is compared
in constant time. Responses use `Cache-Control: no-store`; a request body over
512 KiB answers `413`.

The server has no user model — the token is the only gate — so terminate it
behind a trusted network boundary and treat the token as a shared secret between
the endpoint and its single caller.

## Tools

Read tools carry `readOnlyHint`; a client that honours the hint auto-allows them
and holds every write for approval.

| Tool | Kind | Output / effect |
| --- | --- | --- |
| `list_projects` | read | Every project with id, name and last-updated time. |
| `get_project` | read | One project as the full structured document. |
| `summarize_project` | read | Per-floor room areas (m²) and element counts. |
| `describe_floor` | read | Walls with endpoints and lengths, rooms with polygons and areas, openings and furniture positions — all in cm. |
| `list_furniture_catalog` | read | Each furniture catalog id with its name, category and default size. |
| `create_project` | write | A new empty single-floor project. |
| `duplicate_project` | write | An independent copy of a project. |
| `delete_project` | destructive | Permanently removes a project and its thumbnail and history. |
| `apply_edits` | write | Applies an ordered list of operations to one floor in a single atomic write. |

### `apply_edits` operations

`apply_edits(projectId, floorId?, operations[])` applies the operations in order
to one floor (the active floor by default), re-derives the floor's rooms from the
new wall geometry, validates the whole document, then writes it back once. The
`operations` array is a discriminated union on `type`:

`add_wall`, `move_wall`, `delete_wall`, `add_door`, `add_window`,
`add_furniture`, `move_item` (furniture), `delete_item` (furniture, opening,
column or stair), `add_room` (a rectangle of four walls, optionally named).

Coordinates and lengths are centimetres in one shared world space; a door or
window `position` is a fraction 0–1 along its wall. Ground new geometry in the
existing plan: call `describe_floor` first, then place elements relative to the
coordinates it returns.

## Implementation

- `src/lib/server/agentEdits.ts` — the pure edit engine `applyOperations`. It
  clones the project, applies each operation, re-derives rooms with
  `resolveRooms`, then validates with the strict `readProject` loader, so the
  same geometry the editor uses guarantees consistency. It is store- and
  DOM-free and unit-tested (`tests/agent-edits.test.ts`).
- `src/lib/server/agentMcp.ts` — the JSON-RPC handler, tool schemas and the
  server `instructions` block describing the coordinate workflow. A bad
  operation or a rejected document surfaces as a tool error with a precise
  message the agent can correct and retry; a write that loses the optimistic-
  concurrency check reports that the project changed elsewhere
  (`tests/agent-mcp.test.ts`).
- `src/routes/mcp/agent/+server.ts` — the bearer-gated route.
