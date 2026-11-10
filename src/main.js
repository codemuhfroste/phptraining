/**
 * main.js — wires the pieces together.
 *
 *   Terminal (UI)  ──►  commands.js  ──►  Repl  ──►  PhpRunner  ──►  php-worker.js (WebAssembly PHP)
 *                                    └──►  exercises.js (test harness)
 */

import './style.css';
import { Terminal } from './terminal.js';
import { PhpRunner } from './php-runner.js';
import { Repl } from './repl.js';
import { createEditor } from './editor.js';
import { createCommands } from './commands.js';
import { loadState, saveState } from './storage.js';

// Written as an array of plain strings: a template literal would need the
// backtick and backslashes escaped, which makes ASCII art unreadable.
const BANNER = [
  '  ___  _  _  ___   _____          _',
  ' | _ \\| || || _ \\ |_   _| _ _ __ _ (_) _ _   ___  _ _',
  " |  _/| __ ||  _/   | |  | '_/ _` || || ' \\ / -_)| '_|",
  ' |_|  |_||_||_|     |_|  |_| \\__,_||_||_||_|\\___||_|',
].join('\n');

// ---------------------------------------------------------------------------
// Persistent state (progress + history), with a single save() helper.
// ---------------------------------------------------------------------------
const state = loadState();
const save = () => saveState(state);

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// Commands are created after the terminal, but the terminal needs callbacks
// that reach them. These two `let`s close that loop.
let commands;
let inputQueue = Promise.resolve(); // serialises submitted inputs

const term = new Terminal({
  root: $('terminal'),
  screen: $('screen'),
  output: $('output'),
  promptEl: $('prompt'),
  input: $('input'),
  history: state.history,
  onSubmit: (text) => {
    state.history = term.getHistory();
    save();
    inputQueue = inputQueue.then(() => commands.handleInput(text)).catch(console.error);
  },
  onComplete: (before) => commands.complete(before),
});

term.print(BANNER, 'banner');
term.print('Practice PHP in a fake shell. The PHP is real (WebAssembly); the server is not.', 'sys');
const bootLine = term.print('Booting PHP runtime...', 'sys');

// ---------------------------------------------------------------------------
// PHP runtime (in a Web Worker) + REPL session
// ---------------------------------------------------------------------------
const php = new PhpRunner({
  timeoutMs: 5000,
  onStatus: (message) => term.updateLine(bootLine, message, 'sys'),
});

php.ready
  .then(({ version }) => {
    term.updateLine(bootLine, `PHP ${version} ready.`, 'ok');
    term.print('Type `help` to get started.', 'hint');
  })
  .catch((err) => {
    term.updateLine(bootLine, `Failed to boot PHP: ${err.message}`, 'err');
    term.print('Reload the page to retry. A recent Chrome, Firefox, Safari or Edge is required.', 'sys');
  });

const repl = new Repl(php);

// ---------------------------------------------------------------------------
// Editor panel
// ---------------------------------------------------------------------------
const editor = createEditor({
  panel: $('editor-panel'),
  host: $('editor-host'),
  titleEl: $('editor-title'),
  runButton: $('editor-run'),
  submitButton: $('editor-submit'),
  closeButton: $('editor-close'),
  onRun: (code) => {
    inputQueue = inputQueue.then(() => commands.runFromEditor(code)).catch(console.error);
  },
  onSubmit: () => {
    inputQueue = inputQueue.then(() => commands.submitFromEditor()).catch(console.error);
  },
  onClose: () => term.focus(),
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
commands = createCommands({ term, php, repl, editor, state, save });

term.focus();

// Small debugging hook (also used by the automated browser test):
//   phpTrainer.exec('echo 1+1;')   run a line as if typed
//   phpTrainer.setCode('...')      replace the editor contents
//   phpTrainer.output()            everything currently on screen
window.phpTrainer = {
  exec(text) {
    // Go through the real input path so history, echo and queueing behave
    // exactly as if the text had been typed.
    term.setInput(text);
    term.submit();
    return inputQueue;
  },
  setCode: (code) => editor.setCode(code),
  getCode: () => editor.getCode(),
  output: () => $('output').innerText,
  ready: php.ready,
};
