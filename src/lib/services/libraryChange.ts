/** The former localStorage library key, still watched by the autosave `storage`
 * listener so an older tab that writes it is noticed. */
export const PROJECTS_STORAGE_KEY = 'floorplan_projects';
/** A same-browser cross-tab nudge. Cross-device changes are caught instead by the
 * focus/etag recheck in the autosave watcher. */
export const LIBRARY_CHANGE_KEY = 'openplan3d-library-change';

/** A tiny optional signal, never project data. Save correctness never depends on
 * it: focus and saves recheck the server. */
export function notifyLibraryChange(id: string) {
  try {
    localStorage.setItem(LIBRARY_CHANGE_KEY, JSON.stringify({ id, nonce: crypto.randomUUID() }));
  } catch {
    // A missing or full localStorage only costs the cross-tab hint.
  }
}
