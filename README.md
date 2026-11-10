# PHP Terminal Trainer

A browser-based fake terminal for drilling PHP. The terminal is fake; the PHP is real — it runs through a WebAssembly build of PHP 8.4 inside a Web Worker, so the whole thing is a static site. No PHP server, no backend, works on a phone.

```
jm@php-trainer:~$ $x = 5;
✓ ok (no output)
jm@php-trainer:~$ echo $x * 2;
10
jm@php-trainer:~$ open 3
── Exercise 3: Loops: FizzBuzz as an array [basics] ──
...
```

## Features

- **REPL mode** — type PHP, press Enter. `<?php` is optional. Variables, functions and classes persist between commands like `php -a`.
- **Exercise mode** — 12 exercises (basics → strings → arrays → functions → OOP → practical) with hidden tests, hints revealed one at a time, and a reference solution that unlocks after 3 failed submits. Progress is saved in `localStorage`.
- Real PHP output, warnings, notices and fatal errors, exactly as PHP prints them.
- Execution timeout (5 s): an infinite loop can't freeze the page — the worker is killed and a fresh one boots.
- Command history (Up/Down), Tab completion, multi-line input (Shift+Enter), and a CodeMirror editor with PHP highlighting (`edit`, Ctrl+Enter to run/submit).

## How it works

```
Terminal UI ──► commands.js ──► Repl ──► PhpRunner ──► Web Worker ──► PHP 8.4 (WebAssembly)
   (DOM)                         │                      (timeout)       @php-wasm/web
                                 └──► exercises.js (hidden test harness)
```

- **PHP runtime**: [`@php-wasm/web`](https://www.npmjs.com/package/@php-wasm/web) from WordPress Playground. [`src/php-worker.js`](src/php-worker.js) boots it inside a Web Worker and executes scripts with `php.runStream()`.
- **Timeout**: [`src/php-runner.js`](src/php-runner.js) gives each run 5 seconds. WebAssembly can't be interrupted, so on timeout the worker is `terminate()`d and respawned. The REPL state is unaffected because it lives on the main thread (see next point).
- **REPL persistence**: the runtime resets between runs, so [`src/repl.js`](src/repl.js) remembers every snippet that ran successfully and replays them, output-suppressed, in front of each new command:
  ```php
  <?php
  ob_start(); $x = 5;  ob_end_clean();   // replayed silently
  echo $x;                               // the new command
  ```
  Error line numbers are shifted back so they match what you typed.
- **Exercise checking**: [`src/exercises.js`](src/exercises.js) appends a hidden harness to your code that calls your function with each test's inputs and prints the results as JSON. The JS side compares them with the expected values and shows per-test pass/fail.
- **Bundle size**: the npm package dynamically imports every PHP version it supports (~40 MB each). A small plugin in [`vite.config.js`](vite.config.js) stubs the unused versions so `dist/` only contains PHP 8.4 (≈40 MB: one `.wasm` for browsers with JSPI, one fallback).

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs dist/
npm run preview    # serves dist/ locally
```

Node 20+ is required. The first page load downloads the ~20 MB PHP runtime; the browser caches it afterwards.

## Commands

| Command | What it does |
| --- | --- |
| `help` | List all commands |
| `clear` | Clear the screen (Ctrl+L) |
| `mode repl` / `mode exercise` | Switch modes |
| `ls` | List exercises (✓ = completed) |
| `open <n> [fresh]` | Open exercise *n*; loads your last draft unless `fresh` |
| `edit` | Open the editor (Ctrl+Enter runs/submits, Esc closes) |
| `submit` | Run the tests against the code in the editor |
| `hint` | Reveal the next hint |
| `solution` | Show the reference solution (after 3 failed submits) |
| `progress` | Completed count with a progress bar |
| `history` | Command history |
| `reset` / `reset progress` | Reset the REPL session / clear exercise progress (asks for confirmation) |
| `php -v` | PHP version reported by the runtime |

Anything else is executed as PHP.

## Adding an exercise

Drop a new JSON file into [`src/exercises/`](src/exercises/). Files are loaded in filename order, so prefix it with a number (`13-my-exercise.json`). No other changes needed — Vite picks it up automatically.

```jsonc
{
  "id": "13-my-exercise",            // unique; used as the localStorage key and in the prompt
  "title": "Short title",
  "level": "basics",                 // basics | strings | arrays | functions | oop | practical
  "prompt": "What to do, including the exact return format.",
  "starterCode": "<?php\nfunction myFunction(int $n): int\n{\n    // TODO\n    return 0;\n}\n",
  "functionName": "myFunction",      // the harness calls this function
  "hints": ["First hint", "Second hint", "Third hint"],
  "tests": [
    { "input": [3], "expected": 6 },           // input = argument list, spread into the call
    { "input": [0], "expected": 0 }
  ],
  "solution": "<?php\nfunction myFunction(int $n): int\n{\n    return $n * 2;\n}\n"
}
```

How values are compared:

- The harness `json_encode`s your return value, so `expected` is written as JSON: PHP `true` → `true`, `null` → `null`, a list → `[1, 2]`, an associative array → `{"key": "value"}`.
- Integers must match exactly; floats are compared with a 1e-9 tolerance.
- Object keys may be in any order; array elements must be in order.
- An empty PHP array is encoded as `[]`, so write `[]` (not `{}`) when a function should return an empty array.
- Exceptions thrown by the function are caught and reported as a failed test. Warnings printed during a call are shown under that test.

To test with an object/class (like exercise 10), keep the class in `starterCode` and provide a complete wrapper function in the starter that the tests call.

## Deploy to Vercel

Vercel detects Vite automatically — no config file needed.

1. Push the repo to GitHub.
2. In Vercel: **Add New → Project**, import the repository.
3. Framework preset: **Vite** (auto-detected). Build command `npm run build`, output directory `dist`.
4. Deploy. Every push to `main` redeploys.

The site is fully static; the `.wasm` files are served from Vercel's CDN with the right `application/wasm` MIME type.

## Project structure

```
index.html                 markup for the terminal and editor panel
vite.config.js             Vite config + plugin that drops unused PHP builds
src/main.js                wires everything together, prints the banner
src/terminal.js            fake shell UI: output, input, history, Tab completion
src/commands.js            every command (help, ls, open, submit, …) and PHP dispatch
src/repl.js                persistent REPL via snippet replay
src/php-runner.js          main-thread wrapper: worker lifecycle + timeout
src/php-worker.js          Web Worker that runs PHP (the only file touching @php-wasm)
src/exercises.js           loads exercise JSON, builds the test harness, compares results
src/editor.js              CodeMirror 6 editor panel
src/storage.js             localStorage with try/catch everywhere
src/style.css              terminal look & feel, mobile layout
src/exercises/*.json       the exercises
```

## Debugging hook

`window.phpTrainer` is exposed in the browser console:

```js
phpTrainer.exec('echo 1 + 1;')   // run a line as if typed
phpTrainer.setCode('<?php ...')  // replace the editor contents
phpTrainer.output()              // text currently on screen
```

## License

MIT. PHP itself is distributed under the PHP License; `@php-wasm/web` is GPL-2.0-or-later.
