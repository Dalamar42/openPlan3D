import { env } from '$env/dynamic/private';
import { dispatch, getStore, segmentsOf } from '$lib/server/projectApi';
import type { RequestHandler } from './$types';

/** The whole project library API is single-tenant and reachable only over the
 * tailnet grant, so there is no per-request auth here. Every method funnels
 * through one dispatcher keyed on the path after `/api/projects/`. */
const handle: RequestHandler = async ({ request, params }) => {
  const store = await getStore();
  const segments = segmentsOf(params.path ?? '');
  // Test-only library wipe, gated by an env flag the production deploy never
  // sets. It gives the browser suite an empty store per test.
  if (segments.length === 1 && segments[0] === 'reset') {
    if (env.OPENPLAN3D_TEST_RESET !== 'true') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    await store.clear();
    return new Response(null, { status: 204 });
  }
  return dispatch(store, request.method, segments, request);
};

export const GET = handle;
export const HEAD = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
