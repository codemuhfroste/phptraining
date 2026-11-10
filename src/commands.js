/**
 * commands.js — everything you can type at the prompt.
 *
 * Input handling rule: if the first word is a known command (`help`, `ls`,
 * `open 3`, …) it runs that command; anything else is treated as PHP code
 * and sent to the REPL.
 */

import { TimeoutError } from './php-runner.js';
import { shiftLineNumbers } from './repl.js';
import {
  exercises,
  findExercise,
  buildTestScript,
  parseTestOutput,
  deepEqual,
  formatValue,
  formatCall,
} from './exercises.js';

const PROMPT_USER = 'jm@php-trainer';
const SOLUTION_UNLOCK_AFTER = 3; // failed submits before `solution` is allowed
const WIDE_SCREEN = '(min-width: 900px)';

/** Lines of PHP output that should be shown in red. */
const ERROR_LINE_RE = /^(PHP )?(Fatal error|Parse error|Warning|Notice|Deprecated|Uncaught)\b/;
const FATAL_LINE_RE = /^(PHP )?(Fatal error|Parse error)\b/;

/**
 * @param {object} deps
 * @param {import('./terminal.js').Terminal} deps.term
 * @param {import('./php-runner.js').PhpRunner} deps.php
 * @param {import('./repl.js').Repl} deps.repl
 * @param {ReturnType<import('./editor.js').createEditor>} deps.editor
 * @param {object} deps.state   persisted progress (see storage.js)
 * @param {() => void} deps.save  persist `state`
 */
export function createCommands({ term, php, repl, editor, state, save }) {
  let mode = 'repl'; // 'repl' | 'exercise'
  let current = null; // { exercise, index } of the open exercise
  let pendingConfirm = null; // (answer: string) => void, set by `reset`

  // The editor panel is shared between the REPL scratchpad and the exercise
  // being solved; we keep one buffer per context and swap on `edit`.
  const buffers = { repl: '' };
  let editorContext = 'repl';

  // -------------------------------------------------------------------
  // Command table
  // -------------------------------------------------------------------

  const commands = {
    help: { usage: 'help', description: 'List all commands', run: cmdHelp },
    clear: { usage: 'clear', description: 'Clear the screen (also Ctrl+L)', run: () => term.clear() },
    mode: { usage: 'mode repl|exercise', description: 'Switch between REPL and exercise mode', run: cmdMode },
    ls: { usage: 'ls', description: 'List exercises (✓ = completed)', run: cmdLs },
    open: { usage: 'open <n> [fresh]', description: 'Open exercise n and load its starter code', run: cmdOpen },
    edit: { usage: 'edit', description: 'Open the code editor (Ctrl+Enter runs/submits, Esc closes)', run: cmdEdit },
    submit: { usage: 'submit', description: 'Run the tests against the code in the editor', run: cmdSubmit },
    hint: { usage: 'hint', description: 'Reveal the next hint for the current exercise', run: cmdHint },
    solution: { usage: 'solution', description: `Show the reference solution (after ${SOLUTION_UNLOCK_AFTER} failed submits)`, run: cmdSolution },
    progress: { usage: 'progress', description: 'Show how many exercises you have completed', run: cmdProgress },
    history: { usage: 'history', description: 'Show command history', run: cmdHistory },
    reset: { usage: 'reset [progress]', description: 'Reset the REPL state, or clear exercise progress', run: cmdReset },
    php: { usage: 'php -v', description: 'Show the PHP version of the runtime', run: cmdPhp },
    exit: { usage: 'exit', description: '', run: cmdExit, hidden: true },
    quit: { usage: 'quit', description: '', run: cmdExit, hidden: true },
    '?': { usage: '?', description: '', run: cmdHelp, hidden: true },
  };

  // -------------------------------------------------------------------
  // Entry points used by main.js
  // -------------------------------------------------------------------

  /** Handle one submitted line (or multi-line block) from the terminal. */
  async function handleInput(raw) {
    const text = raw.trim();

    if (pendingConfirm) {
      const confirm = pendingConfirm;
      pendingConfirm = null;
      await confirm(text.toLowerCase());
      return;
    }

    if (!text) return;

    const [first, ...args] = text.split(/\s+/);
    const command = commands[first.toLowerCase()];
    if (command) {
      await command.run(args, text);
      return;
    }

    await runPhp(raw);
  }

  /** Tab completion candidates for the text before the caret. */
  function complete(before) {
    const words = before.split(/\s+/);
    const partial = words[words.length - 1].toLowerCase();

    if (words.length === 1) {
      return Object.keys(commands)
        .filter((name) => !commands[name].hidden && name.startsWith(partial))
        .sort();
    }

    const head = words[0].toLowerCase();
    let options = [];
    if (head === 'open') options = exercises.map((e, i) => String(i + 1)).concat(exercises.map((e) => e.id));
    if (head === 'mode') options = ['repl', 'exercise'];
    if (head === 'reset') options = ['progress'];
    if (head === 'php') options = ['-v'];
    return options.filter((o) => o.startsWith(partial));
  }

  // -------------------------------------------------------------------
  // Running PHP
  // -------------------------------------------------------------------

  /** Run code through the persistent REPL and print whatever PHP says. */
  async function runPhp(code) {
    term.setBusy(true);
    const waiting = php.version ? null : term.print('Waiting for the PHP runtime to finish booting...', 'sys');

    try {
      const result = await repl.run(code);
      waiting?.remove();
      printPhpOutput(result.stdout, result.stderr);

      if (!result.stdout.trim() && !result.stderr.trim()) {
        if (result.failed) term.print(`(PHP exited with code ${result.exitCode})`, 'err');
        else term.print('✓ ok (no output)', 'sys');
      }
      if (result.terminates && !result.failed) {
        term.print('Note: snippets that call exit/die are not kept in the REPL session.', 'sys');
      }
    } catch (err) {
      waiting?.remove();
      reportRunError(err);
    } finally {
      term.setBusy(false);
    }
  }

  function reportRunError(err) {
    if (err instanceof TimeoutError) {
      term.print(`${err.message}. The PHP worker was killed and a fresh one is booting.`, 'err');
      term.print('Your REPL variables are safe. Check for an infinite loop (while(true), a missing $i++ ...).', 'hint');
    } else {
      term.print(`Runtime error: ${err.message}`, 'err');
    }
  }

  /** Print PHP output line by line, colouring errors and warnings red. */
  function printPhpOutput(stdout, stderr) {
    const text = stdout.replace(/\n$/, '');
    if (text) {
      let afterFatal = false; // everything after a fatal error (stack trace) is red too
      for (const line of text.split('\n')) {
        if (FATAL_LINE_RE.test(line)) afterFatal = true;
        term.print(line, afterFatal || ERROR_LINE_RE.test(line) ? 'err' : 'out');
      }
    }
    if (stderr && stderr.trim()) term.print(stderr.trim(), 'err');
  }

  // -------------------------------------------------------------------
  // Mode / prompt
  // -------------------------------------------------------------------

  function updatePrompt() {
    let path = '~';
    if (mode === 'exercise') path = current ? `~/exercises/${current.exercise.id}` : '~/exercises';
    term.setPrompt(`${PROMPT_USER}:${path}$`);
  }

  function setMode(next) {
    mode = next;
    updatePrompt();
  }

  function cmdMode(args) {
    const next = (args[0] || '').toLowerCase();
    if (!next) {
      term.print(`Current mode: ${mode}. Use \`mode repl\` or \`mode exercise\`.`, 'sys');
      return;
    }
    if (next !== 'repl' && next !== 'exercise') {
      term.print(`Unknown mode "${args[0]}". Use \`mode repl\` or \`mode exercise\`.`, 'err');
      return;
    }
    setMode(next);
    if (next === 'repl') {
      term.print('REPL mode: type PHP and press Enter. Variables and functions persist between commands.', 'ok');
    } else {
      term.print('Exercise mode: `ls` to list exercises, `open <n>` to start one.', 'ok');
    }
  }

  // -------------------------------------------------------------------
  // help / history / php / exit
  // -------------------------------------------------------------------

  function cmdHelp() {
    term.print('PHP Terminal Trainer — commands', 'hint');
    const visible = Object.values(commands).filter((c) => !c.hidden);
    const width = Math.max(...visible.map((c) => c.usage.length)) + 2;
    for (const c of visible) {
      term.printRich([
        { text: '  ' + c.usage.padEnd(width), kind: 'cyan' },
        { text: c.description },
      ]);
    }
    term.print('');
    term.print('Anything else is run as PHP. The leading <?php is optional.', 'sys');
    term.print('Enter runs the input, Shift+Enter adds a line, Up/Down browse history, Tab completes commands.', 'sys');
  }

  function cmdHistory() {
    const history = term.getHistory();
    if (history.length === 0) {
      term.print('(history is empty)', 'sys');
      return;
    }
    const width = String(history.length).length;
    history.forEach((entry, i) => {
      term.printRich([
        { text: `${String(i + 1).padStart(width)}  `, kind: 'sys' },
        { text: entry.replace(/\n/g, ' ⏎ ') },
      ]);
    });
  }

  function cmdPhp(args) {
    const flag = args[0];
    if (flag === '-v' || flag === '--version') {
      if (!php.version) {
        term.print('PHP runtime is still booting — try again in a moment.', 'sys');
        return;
      }
      term.print(`PHP ${php.version} (WebAssembly, @php-wasm/web — runs entirely in your browser)`);
      return;
    }
    term.print('There is no php binary here: this whole app is PHP. Just type code, e.g.  echo 1 + 1;', 'hint');
  }

  function cmdExit() {
    term.print("There's no shell to exit to — this is all there is. Try `clear` instead. (If you meant PHP's exit, add a semicolon: exit;)", 'sys');
  }

  // -------------------------------------------------------------------
  // Exercises
  // -------------------------------------------------------------------

  function cmdLs() {
    if (exercises.length === 0) {
      term.print('No exercises found in src/exercises/.', 'err');
      return;
    }
    const titleWidth = Math.max(...exercises.map((e) => e.title.length));
    exercises.forEach((exercise, i) => {
      const done = Boolean(state.completed[exercise.id]);
      const isCurrent = current && current.index === i;
      term.printRich([
        { text: isCurrent ? '> ' : '  ', kind: 'hint' },
        { text: String(i + 1).padStart(2) + '  ', kind: 'sys' },
        { text: exercise.level.padEnd(10), kind: 'cyan' },
        { text: exercise.title.padEnd(titleWidth + 2) },
        { text: done ? '✓' : '·', kind: done ? 'ok' : 'sys' },
      ]);
    });
    term.print('');
    term.print(`${completedCount()}/${exercises.length} completed. \`open <n>\` to start one.`, 'sys');
  }

  function cmdOpen(args) {
    if (!args[0]) {
      term.print('Usage: open <number|id>   e.g.  open 3', 'err');
      return;
    }
    const found = findExercise(args[0]);
    if (!found) {
      term.print(`No exercise "${args[0]}". Type \`ls\` to see the list.`, 'err');
      return;
    }

    current = found;
    setMode('exercise');
    const { exercise, index } = found;

    // Prefer the user's last submitted draft unless they asked for `fresh`.
    const fresh = (args[1] || '').toLowerCase() === 'fresh';
    const draft = state.drafts[exercise.id];
    const code = !fresh && draft ? draft : exercise.starterCode;
    buffers[exercise.id] = code;

    term.print(`── Exercise ${index + 1}: ${exercise.title} [${exercise.level}] ──`, 'hint');
    term.print(exercise.prompt);
    term.print('');
    term.printRich([
      { text: 'Function to implement: ', kind: 'sys' },
      { text: `${exercise.functionName}()`, kind: 'cyan' },
      { text: `   tests: ${exercise.tests.length}   hints: ${exercise.hints.length}`, kind: 'sys' },
      { text: state.completed[exercise.id] ? '   ✓ completed' : '', kind: 'ok' },
    ]);
    if (draft && !fresh) {
      term.print('Loaded your previous draft. Use `open ' + (index + 1) + ' fresh` to start from the starter code.', 'sys');
    }

    // On wide screens the editor sits beside the terminal, so open it right
    // away. On phones it would cover this prompt, so wait for `edit`.
    if (window.matchMedia(WIDE_SCREEN).matches) {
      openEditorFor(exercise.id);
      term.print('Starter code is in the editor. Ctrl+Enter or `submit` runs the tests, `hint` if stuck.', 'sys');
    } else {
      term.print('Type `edit` to write your solution, then `submit` to run the tests. `hint` if stuck.', 'sys');
    }
  }

  function cmdEdit() {
    if (mode === 'exercise' && current) {
      openEditorFor(current.exercise.id);
    } else {
      openEditorFor('repl');
      term.print('Scratchpad editor: Ctrl+Enter runs the code in the REPL session.', 'sys');
    }
  }

  /** Show the editor with the buffer for `context` ('repl' or an exercise id). */
  function openEditorFor(context) {
    if (editor.isOpen() || editorContext !== context) {
      // Keep what was typed in the other context before swapping.
      buffers[editorContext] = editor.getCode();
    }
    editorContext = context;
    const isExercise = context !== 'repl';
    editor.open({
      title: isExercise ? `${context}.php` : 'scratch.php (REPL)',
      code: buffers[context] ?? '',
      primary: isExercise ? 'submit' : 'run',
    });
  }

  /** Current solution text for the open exercise, wherever it lives. */
  function currentSolutionCode() {
    const id = current.exercise.id;
    return editorContext === id ? editor.getCode() : buffers[id] ?? '';
  }

  async function cmdSubmit() {
    if (mode !== 'exercise' || !current) {
      term.print('No exercise is open. `ls` to list them, `open <n>` to start one.', 'err');
      return;
    }
    const { exercise, index } = current;
    const code = currentSolutionCode();

    if (!code.trim()) {
      term.print('The editor is empty. Type `edit` and write your solution first.', 'err');
      return;
    }

    buffers[exercise.id] = code;
    state.drafts[exercise.id] = code;
    save();

    term.setBusy(true);
    try {
      const { script, lineOffset } = buildTestScript(exercise, code);
      // Exercises run in isolation (not through the REPL), so leftover REPL
      // variables can never make a test pass or fail by accident.
      const raw = await php.run(script, `/${exercise.id}.php`);
      const stdout = shiftLineNumbers(raw.stdout, lineOffset);
      const report = parseTestOutput(stdout);

      if (report.userOutput) {
        term.print('Program output:', 'sys');
        printPhpOutput(report.userOutput, '');
      }

      if (report.error) {
        printPhpOutput(report.error, raw.stderr);
        recordFailure(exercise);
        return;
      }

      const passed = printTestReport(exercise, report.results);
      if (passed === exercise.tests.length) {
        state.completed[exercise.id] = true;
        save();
        term.print(`All ${passed} tests passed. Exercise ${index + 1} "${exercise.title}" marked as completed! 🎉`, 'ok');
        if (index + 1 < exercises.length) {
          term.print(`Next: \`open ${index + 2}\` — ${exercises[index + 1].title}`, 'sys');
        } else {
          term.print('That was the last one. Add more in src/exercises/ — see README.md.', 'sys');
        }
      } else {
        recordFailure(exercise);
      }
    } catch (err) {
      reportRunError(err);
      recordFailure(exercise);
    } finally {
      term.setBusy(false);
    }
  }

  /** Print one line per test; returns the number that passed. */
  function printTestReport(exercise, results) {
    let passed = 0;
    exercise.tests.forEach((test, i) => {
      const result = results[i];
      const call = formatCall(exercise.functionName, test.input);
      const label = `Test ${i + 1}`;

      if (result && result.ok && deepEqual(test.expected, result.value)) {
        passed++;
        term.printRich([
          { text: `${label} ✓ `, kind: 'ok' },
          { text: `${call} → ${formatValue(result.value)}`, kind: 'sys' },
        ]);
      } else {
        term.printRich([
          { text: `${label} ✗ `, kind: 'err' },
          { text: call },
        ]);
        term.print(`       expected: ${formatValue(test.expected)}`, 'sys');
        if (!result) term.print('       actual:   (no result — the harness stopped early)', 'err');
        else if (result.ok) term.print(`       actual:   ${formatValue(result.value)}`, 'err');
        else term.print(`       threw:    ${result.error}`, 'err');
      }
      if (result && result.output && result.output.trim()) {
        term.print('       output during call:', 'sys');
        printPhpOutput(result.output.trim(), '');
      }
    });
    term.print(`${passed}/${exercise.tests.length} tests passed.`, passed === exercise.tests.length ? 'ok' : 'err');
    return passed;
  }

  function recordFailure(exercise) {
    state.attempts[exercise.id] = (state.attempts[exercise.id] || 0) + 1;
    save();
    const attempts = state.attempts[exercise.id];
    const shown = state.hintsShown[exercise.id] || 0;
    const tips = [];
    if (shown < exercise.hints.length) tips.push('`hint` for a hint');
    if (attempts >= SOLUTION_UNLOCK_AFTER) tips.push('`solution` to see a reference solution');
    else tips.push(`\`solution\` unlocks after ${SOLUTION_UNLOCK_AFTER} failed submits (${attempts}/${SOLUTION_UNLOCK_AFTER})`);
    term.print(`Not there yet — ${tips.join(', ')}.`, 'hint');
  }

  function cmdHint() {
    if (!current) {
      term.print('Open an exercise first: `open <n>`.', 'err');
      return;
    }
    const { exercise } = current;
    const shown = state.hintsShown[exercise.id] || 0;
    if (shown >= exercise.hints.length) {
      term.print(`No more hints for this exercise (${exercise.hints.length}/${exercise.hints.length} shown).`, 'sys');
      return;
    }
    term.print(`Hint ${shown + 1}/${exercise.hints.length}: ${exercise.hints[shown]}`, 'hint');
    state.hintsShown[exercise.id] = shown + 1;
    save();
  }

  function cmdSolution() {
    if (!current) {
      term.print('Open an exercise first: `open <n>`.', 'err');
      return;
    }
    const { exercise } = current;
    const attempts = state.attempts[exercise.id] || 0;
    const unlocked = attempts >= SOLUTION_UNLOCK_AFTER || state.completed[exercise.id];
    if (!unlocked) {
      term.print(`The solution unlocks after ${SOLUTION_UNLOCK_AFTER} failed submits (you have ${attempts}). Keep trying — \`hint\` can help.`, 'hint');
      return;
    }
    term.print(`── Reference solution: ${exercise.title} ──`, 'hint');
    term.print(exercise.solution);
    term.print('There is more than one correct answer; compare the approach, not the exact code.', 'sys');
  }

  function cmdProgress() {
    const done = completedCount();
    const total = exercises.length;
    const width = 20;
    const filled = total ? Math.round((done / total) * width) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pct = total ? Math.round((done / total) * 100) : 0;
    term.printRich([
      { text: `[${bar}] `, kind: 'ok' },
      { text: `${done}/${total} completed (${pct}%)` },
    ]);

    // Per-level breakdown
    const levels = [...new Set(exercises.map((e) => e.level))];
    for (const level of levels) {
      const inLevel = exercises.filter((e) => e.level === level);
      const doneInLevel = inLevel.filter((e) => state.completed[e.id]).length;
      term.printRich([
        { text: `  ${level.padEnd(10)}`, kind: 'cyan' },
        { text: `${doneInLevel}/${inLevel.length}`, kind: doneInLevel === inLevel.length ? 'ok' : 'sys' },
      ]);
    }
  }

  function completedCount() {
    return exercises.filter((e) => state.completed[e.id]).length;
  }

  // -------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------

  function cmdReset(args) {
    const what = (args[0] || '').toLowerCase();

    if (what === 'progress') {
      term.print(`Clear exercise progress (${completedCount()} completed, hints, attempts, drafts)? [y/N]`, 'hint');
      pendingConfirm = (answer) => {
        if (answer !== 'y' && answer !== 'yes') {
          term.print('Cancelled.', 'sys');
          return;
        }
        state.completed = {};
        state.attempts = {};
        state.hintsShown = {};
        state.drafts = {};
        save();
        term.print('Exercise progress cleared.', 'ok');
      };
      return;
    }

    if (what) {
      term.print('Usage: `reset` (REPL state) or `reset progress` (exercise progress).', 'err');
      return;
    }

    term.print(`Reset the REPL session (${repl.size} remembered snippet${repl.size === 1 ? '' : 's'})? [y/N]`, 'hint');
    pendingConfirm = (answer) => {
      if (answer !== 'y' && answer !== 'yes') {
        term.print('Cancelled.', 'sys');
        return;
      }
      repl.reset();
      buffers.repl = '';
      term.print('REPL state cleared. All variables, functions and classes are gone.', 'ok');
    };
  }

  // -------------------------------------------------------------------

  updatePrompt();

  return {
    handleInput,
    complete,
    /** Used by the editor's Run button / Ctrl+Enter in REPL mode. */
    runFromEditor: async (code) => {
      if (!code.trim()) return;
      buffers.repl = code;
      term.printCommand(code.trim());
      await runPhp(code);
    },
    submitFromEditor: async () => {
      term.printCommand('submit');
      await cmdSubmit();
    },
    get mode() {
      return mode;
    },
  };
}
