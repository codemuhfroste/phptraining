/**
 * php-runner.js — main-thread wrapper around the PHP worker.
 *
 * Responsibilities:
 *   - spawn the worker and expose a `ready` promise (resolves with the PHP version),
 *   - serialise runs (one at a time) and match results to requests by id,
 *   - enforce the execution timeout: if PHP doesn't answer in time we
 *     terminate the worker (the only way to stop synchronous wasm code),
 *     reject with TimeoutError and boot a fresh worker.
 */

export class TimeoutError extends Error {
  constructor(ms) {
    super(`Execution timed out after ${ms / 1000}s`);
    this.name = 'TimeoutError';
  }
}

/** Give up respawning after this many unexpected crashes (timeouts don't count). */
const MAX_RESTARTS = 5;

export class PhpRunner {
  /**
   * @param {object} options
   * @param {number} [options.timeoutMs=5000]
   * @param {(message: string) => void} [options.onStatus]  boot progress messages
   */
  constructor({ timeoutMs = 5000, onStatus = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onStatus = onStatus;
    this.seq = 0;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.queue = Promise.resolve(); // serialises run() calls
    this.version = null;
    this.restarts = 0;
    this.spawn();
  }

  /** Create a new worker and a fresh `ready` promise. */
  spawn() {
    // `new URL(..., import.meta.url)` is the syntax Vite understands for
    // bundling a worker. `type: 'module'` lets the worker use import().
    this.worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });

    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'status':
            this.onStatus(msg.message);
            break;
          case 'ready':
            this.version = msg.version;
            resolve({ version: msg.version });
            break;
          case 'boot-error':
            reject(new Error(msg.message));
            break;
          case 'result':
          case 'error':
            this.settle(msg);
            break;
        }
      };

      // Uncaught exception inside the worker (e.g. the wasm runtime crashed).
      this.worker.onerror = (event) => {
        const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
        const err = new Error((event.message || 'PHP worker crashed') + where);
        reject(err);
        this.failAll(err);
        // Only restart if the worker had booted successfully before: a crash
        // during boot would just repeat forever.
        if (this.version !== null && this.restarts++ < MAX_RESTARTS) this.restart();
      };
    });

    // Avoid "unhandled rejection" noise if nobody awaits ready yet.
    this.ready.catch(() => {});
  }

  /** Resolve or reject the pending request that matches a worker message. */
  settle(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if (msg.type === 'result') {
      entry.resolve({ stdout: msg.stdout, stderr: msg.stderr, exitCode: msg.exitCode });
    } else {
      entry.reject(new Error(msg.message));
    }
  }

  failAll(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Kill the current worker and boot a new one. */
  restart() {
    try {
      this.worker.terminate();
    } catch {
      /* already dead */
    }
    this.spawn();
  }

  /**
   * Execute a complete PHP file.
   * @param {string} code      full source, including `<?php`
   * @param {string} filename  path inside PHP's virtual filesystem (shows up in error messages)
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  run(code, filename = '/main.php') {
    // Chain onto the queue so two runs never overlap in the worker.
    const task = this.queue.then(() => this.runNow(code, filename));
    this.queue = task.catch(() => {}); // a failed run must not poison the queue
    return task;
  }

  async runNow(code, filename) {
    await this.ready;

    return new Promise((resolve, reject) => {
      const id = ++this.seq;

      const timer = setTimeout(() => {
        // The worker is stuck in synchronous wasm code; the only way out is
        // to kill it. Everything the REPL "remembers" lives on the main
        // thread (see repl.js), so nothing is lost by restarting.
        this.pending.delete(id);
        this.restart();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'run', id, code, filename });
    });
  }
}
