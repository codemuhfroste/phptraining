/**
 * php-worker.js — runs inside a Web Worker.
 *
 * This is the only file that touches the PHP WebAssembly runtime. Keeping PHP
 * in a worker means an infinite loop (`while(true){}`) only blocks this
 * thread; the page stays responsive and the main thread can terminate us
 * (see php-runner.js) and start a fresh worker.
 *
 * Message protocol (worker → main):
 *   { type: 'status', message }                 progress while booting
 *   { type: 'ready',  version }                 runtime is usable; `version` = PHP_VERSION constant from PHP itself
 *   { type: 'boot-error', message }             runtime failed to load
 *   { type: 'result', id, stdout, stderr, exitCode }
 *   { type: 'error',  id, message }             the run itself threw (not a PHP error)
 *
 * Message protocol (main → worker):
 *   { type: 'run', id, code, filename }         execute `code` (a full PHP file, including `<?php`)
 *
 * Package: @php-wasm/web (WordPress Playground). API used:
 *   loadWebRuntime(version) → runtime id; new PHP(runtimeId); php.writeFile();
 *   php.runStream({ scriptPath }) → { stdoutText, stderrText, exitCode }
 */

import { PHP, setPhpIniEntries } from '@php-wasm/universal';
import { loadWebRuntime } from '@php-wasm/web';

/** Keep in sync with SHIPPED_PHP_BUILD in vite.config.js. */
const PHP_VERSION = '8.4';

/** @type {PHP | null} */
let php = null;

const post = (message) => self.postMessage(message);

/**
 * Write the code to the in-memory filesystem and execute it as a script.
 * Running from a file (instead of `code:` eval mode) gives real
 * "in /repl.php on line N" error messages, like the php CLI would.
 */
async function execute(code, filename) {
  php.writeFile(filename, code);
  const response = await php.runStream({ scriptPath: filename });
  const [stdout, stderr, exitCode] = await Promise.all([
    response.stdoutText,
    response.stderrText,
    response.exitCode,
  ]);
  return { stdout, stderr, exitCode };
}

async function boot() {
  post({
    type: 'status',
    message: `Booting PHP ${PHP_VERSION} runtime (≈20 MB download on first visit, cached after that)...`,
  });

  const runtimeId = await loadWebRuntime(PHP_VERSION);
  php = new PHP(runtimeId);

  // The default php.ini from @php-wasm is tuned for serving WordPress pages:
  // it prints errors as HTML. We want them exactly as the CLI shows them.
  await setPhpIniEntries(php, {
    html_errors: 0,
    display_errors: 1,
    display_startup_errors: 1,
    log_errors: 0, // otherwise every error is also duplicated on stderr
    error_reporting: 'E_ALL',
    memory_limit: '128M',
  });

  // Ask PHP itself for its version so `php -v` reports the truth.
  const probe = await execute('<?php echo PHP_VERSION;', '/version.php');
  post({ type: 'ready', version: probe.stdout.trim() });
}

self.onmessage = async (event) => {
  const { type, id, code, filename } = event.data;
  if (type !== 'run') return;

  if (!php) {
    post({ type: 'error', id, message: 'PHP runtime is not ready yet.' });
    return;
  }

  try {
    const result = await execute(code, filename || '/main.php');
    post({ type: 'result', id, ...result });
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) });
  }
};

boot().catch((err) => {
  console.error('[php-worker] boot failed', err);
  post({ type: 'boot-error', message: err?.message || String(err) });
});
