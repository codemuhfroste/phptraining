/**
 * storage.js — tiny localStorage wrapper.
 *
 * localStorage can throw (private browsing, quota exceeded, disabled storage,
 * corrupted JSON), so every access is wrapped in try/catch and the app keeps
 * working with in-memory state if persistence is unavailable.
 */

const STORAGE_KEY = 'php-terminal-trainer';

/** Shape of what we persist. Everything is optional and has a default. */
const DEFAULT_STATE = {
  completed: {}, // { [exerciseId]: true }
  attempts: {}, // { [exerciseId]: number of failed submits }
  hintsShown: {}, // { [exerciseId]: number of hints revealed }
  drafts: {}, // { [exerciseId]: last submitted editor code }
  history: [], // last N terminal commands
};

/**
 * Read the whole saved state. Never throws.
 * @returns {typeof DEFAULT_STATE}
 */
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // Merge with defaults so new fields added later never come back undefined.
    return { ...structuredClone(DEFAULT_STATE), ...parsed };
  } catch (err) {
    console.warn('[storage] could not read progress:', err);
    return structuredClone(DEFAULT_STATE);
  }
}

/**
 * Persist the whole state object. Never throws.
 * @param {typeof DEFAULT_STATE} state
 * @returns {boolean} true if the write succeeded
 */
export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.warn('[storage] could not save progress:', err);
    return false;
  }
}

/** Remove everything we stored. Never throws. */
export function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[storage] could not clear progress:', err);
  }
}
