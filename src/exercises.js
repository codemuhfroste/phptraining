/**
 * exercises.js — loads the exercise catalogue and builds/checks test runs.
 *
 * Exercises are plain JSON files in src/exercises/. Vite's import.meta.glob
 * picks them all up at build time, so adding an exercise = adding a file.
 * See README.md for the JSON format.
 */

import { Repl } from './repl.js';

// `eager: true` inlines the JSON into the bundle (no extra network requests).
const modules = import.meta.glob('./exercises/*.json', { eager: true });

/** All exercises, sorted by filename (01-…, 02-…, …). */
export const exercises = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, mod]) => mod.default);

export const LEVELS = ['basics', 'strings', 'arrays', 'functions', 'oop', 'practical'];

/**
 * Find an exercise by 1-based number ("3") or by id ("03-fizzbuzz").
 * @returns {{exercise: object, index: number} | null}
 */
export function findExercise(ref) {
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= exercises.length) {
    return { exercise: exercises[n - 1], index: n - 1 };
  }
  const index = exercises.findIndex((e) => e.id === ref);
  return index === -1 ? null : { exercise: exercises[index], index };
}

/**
 * A marker that separates the user's own output from the harness JSON.
 * Chosen to be something nobody would echo by accident.
 */
const MARKER = '__PHP_TRAINER_RESULTS__';

/**
 * Append the hidden test harness to the user's code.
 *
 * The harness calls the exercise function once per test with the test's
 * `input` array spread as arguments, captures anything printed during the
 * call (warnings, stray echos), catches exceptions, and prints everything
 * as one JSON document after the marker. The JS side (parseTestOutput)
 * splits on the marker and compares values.
 *
 * @param {object} exercise
 * @param {string} userCode  `<?php` optional
 * @returns {{ script: string, lineOffset: number }}
 */
export function buildTestScript(exercise, userCode) {
  const snippet = Repl.stripTags(userCode);
  // Tests travel as base64 so quotes/backslashes in inputs never break the PHP string.
  const inputs = exercise.tests.map((t) => t.input);
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(inputs))));
  const fn = JSON.stringify(exercise.functionName); // safe PHP string literal

  const harness = `
// ===== hidden test harness (added by PHP Terminal Trainer) =====
echo "\\n${MARKER}\\n";
$__fn = ${fn};
if (!function_exists($__fn)) {
    echo json_encode(['error' => "Function {$__fn}() is not defined. Did you keep the function name from the starter code?"]);
    exit;
}
$__tests = json_decode(base64_decode('${encoded}'), true);
$__results = [];
foreach ($__tests as $__args) {
    ob_start();
    try {
        $__value = $__fn(...$__args);
        $__results[] = ['ok' => true, 'value' => $__value, 'output' => ob_get_clean()];
    } catch (\\Throwable $__e) {
        $__results[] = ['ok' => false, 'error' => get_class($__e) . ': ' . $__e->getMessage(), 'output' => ob_get_clean()];
    }
}
echo json_encode(['results' => $__results], JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
`;

  // If the user's code already started with `<?php`, stripTags() left the
  // rest of that first line in place, so we put the tag back on the same
  // line and error line numbers match the editor exactly. Otherwise our
  // added `<?php` line shifts everything down by one.
  const hadTag = /^[ \t]*<\?(php)?\b/i.test(userCode);
  if (hadTag) return { script: `<?php${snippet}\n${harness}`, lineOffset: 0 };
  return { script: `<?php\n${snippet}\n${harness}`, lineOffset: 1 };
}

/**
 * Split PHP's stdout into the user's own output and the harness results.
 * @returns {{ userOutput: string, results?: object[], error?: string }}
 */
export function parseTestOutput(stdout) {
  const at = stdout.indexOf(MARKER);
  if (at === -1) {
    // The harness never ran: a parse/fatal error in the user's code.
    return { userOutput: '', error: stdout.trim() || 'No output from PHP (did the script exit early?)' };
  }

  const userOutput = stdout.slice(0, at).replace(/\n$/, '');
  const jsonText = stdout.slice(at + MARKER.length).trim();

  try {
    const data = JSON.parse(jsonText);
    if (data.error) return { userOutput, error: data.error };
    return { userOutput, results: data.results };
  } catch {
    return { userOutput, error: `Could not read test results:\n${jsonText}` };
  }
}

/**
 * Compare a PHP value (decoded from JSON) with the expected JSON value.
 *  - numbers: exact for integers, 1e-9 tolerance for floats
 *  - arrays: same length, same order
 *  - objects: same keys (any order), values compared recursively
 *  - PHP encodes an empty array as `[]` even when an object was intended, so
 *    `[]` and `{}` are considered equal.
 */
export function deepEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
    return Math.abs(a - b) < 1e-9;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    return Object.keys(a).length === 0 && Object.keys(b).length === 0;
  }
  if (aIsArray) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((k) => k in b && deepEqual(a[k], b[k]));
}

/** Compact one-line representation of a value for the test report. */
export function formatValue(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : text;
}

/** `fizzBuzz(5)` style call signature for the report. */
export function formatCall(fnName, args) {
  return `${fnName}(${args.map(formatValue).join(', ')})`;
}
