/**
 * repl.js — `php -a`-style session on top of a stateless runtime.
 *
 * HOW PERSISTENCE WORKS (the "replay" strategy)
 * ---------------------------------------------
 * @php-wasm resets the interpreter before every run: each call is a brand new
 * `php script.php`, so `$x = 5;` is forgotten by the time the next command
 * runs. There is no browser-side equivalent of the interactive CLI session.
 *
 * To make variables, functions and classes persist we keep every snippet that
 * ran successfully and *replay* them, with their output suppressed, in front
 * of each new snippet. The script we actually execute looks like:
 *
 *     <?php
 *     ob_start(); $x = 5;                 ob_end_clean();   // replayed, silent
 *     ob_start(); function f() {...}      ob_end_clean();   // replayed, silent
 *     echo $x;                                              // the new command
 *
 * `ob_start()` / `ob_end_clean()` capture and discard anything the old
 * snippets print, including warnings they already showed the first time.
 *
 * Why this approach:
 *   - It is deterministic and works with any PHP construct (classes, closures,
 *     static props) because the code really runs again.
 *   - It survives a worker restart after a timeout, because the snippet list
 *     lives here on the main thread, not inside the wasm instance.
 * Trade-offs:
 *   - Each command re-runs the whole session (fast for drills; `reset` clears it).
 *   - Side effects repeat (rand(), file writes). `exit`/`die` snippets are run
 *     but never remembered, otherwise every later command would stop early.
 *   - Error line numbers are shifted by the replayed lines, so we shift them
 *     back before showing the output.
 */

/** Matches "on line 12" in PHP error messages. */
const LINE_NUMBER_RE = /\bon line (\d+)\b/g;

/** A run is considered failed if PHP exited non-zero or printed one of these. */
const FATAL_RE = /^(PHP )?(Fatal error|Parse error):/m;

export class Repl {
  /**
   * @param {{ run(code: string, filename: string): Promise<{stdout:string, stderr:string, exitCode:number}> }} runner
   */
  constructor(runner) {
    this.runner = runner;
    /** @type {string[]} snippets (without `<?php`) that ran without a fatal error */
    this.snippets = [];
  }

  /** Forget everything defined so far. */
  reset() {
    this.snippets = [];
  }

  get size() {
    return this.snippets.length;
  }

  /**
   * Remove the open/close PHP tags the user may have typed, without touching
   * line breaks so error line numbers still match what they typed.
   */
  static stripTags(code) {
    return code.replace(/^[ \t]*<\?(php)?\b/i, '').replace(/\?>[ \t]*$/, '');
  }

  /** Build the full script: replayed prelude + the new snippet. */
  buildScript(newSnippet) {
    const prelude = this.snippets.map((s) => `ob_start();\n${s}\nob_end_clean();`).join('\n');
    const header = prelude ? `<?php\n${prelude}\n` : '<?php\n';
    const script = header + newSnippet;
    // Number of lines that sit above the user's snippet (header ends with "\n").
    const lineOffset = header.split('\n').length - 1;
    return { script, lineOffset };
  }

  /**
   * Run a snippet in the context of the session.
   * @param {string} code  what the user typed (`<?php` optional)
   * @returns {Promise<{stdout:string, stderr:string, exitCode:number, failed:boolean, persisted:boolean}>}
   */
  async run(code) {
    const snippet = Repl.stripTags(code);
    const { script, lineOffset } = this.buildScript(snippet);

    const result = await this.runner.run(script, '/repl.php');

    const stdout = shiftLineNumbers(result.stdout, lineOffset);
    const stderr = shiftLineNumbers(result.stderr, lineOffset);
    const failed = result.exitCode !== 0 || FATAL_RE.test(stdout);

    // Only remember snippets that (a) succeeded and (b) won't terminate the
    // script on replay.
    const terminates = /\b(exit|die)\b/i.test(snippet);
    const persisted = !failed && !terminates && snippet.trim() !== '';
    if (persisted) this.snippets.push(snippet);

    return { stdout, stderr, exitCode: result.exitCode, failed, persisted, terminates };
  }
}

/** Subtract the replayed-prelude line count from "on line N" messages. */
export function shiftLineNumbers(text, offset) {
  if (!offset || !text) return text;
  return text.replace(LINE_NUMBER_RE, (match, n) => {
    const line = Number(n);
    return line > offset ? `on line ${line - offset}` : match;
  });
}
