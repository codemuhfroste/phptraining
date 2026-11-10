/**
 * terminal.js — the fake shell UI.
 *
 * This class knows nothing about PHP or exercises. It only:
 *   - renders output lines (with colour "kinds"),
 *   - owns the input textarea (Enter = submit, Shift+Enter = newline),
 *   - keeps command history (Up/Down),
 *   - asks a callback for Tab completions,
 *   - keeps the view scrolled to the bottom.
 *
 * All text is inserted with textContent, never innerHTML, so PHP output
 * containing `<b>` or `<script>` is displayed literally.
 */

const MAX_HISTORY = 200;

export class Terminal {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root       The #terminal element (gets the `busy` class)
   * @param {HTMLElement} options.screen     Scrollable container
   * @param {HTMLElement} options.output     Where lines are appended
   * @param {HTMLElement} options.promptEl   The prompt label next to the input
   * @param {HTMLTextAreaElement} options.input
   * @param {(text: string) => void} options.onSubmit   Called with the submitted text
   * @param {(text: string) => string[]} options.onComplete  Returns completion candidates for the text before the caret
   * @param {string[]} [options.history]     Previously saved history
   */
  constructor({ root, screen, output, promptEl, input, onSubmit, onComplete, history = [] }) {
    this.root = root;
    this.screen = screen;
    this.output = output;
    this.promptEl = promptEl;
    this.input = input;
    this.onSubmit = onSubmit;
    this.onComplete = onComplete;

    this.history = history.slice(-MAX_HISTORY);
    this.historyIndex = this.history.length; // points "one past the end" = new draft
    this.draft = ''; // what the user was typing before browsing history
    this.busy = false;

    this.input.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.input.addEventListener('input', () => this.autoResize());

    // Clicking anywhere on the screen focuses the input, unless the user is
    // selecting text to copy it.
    this.screen.addEventListener('click', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) this.focus();
    });

    this.autoResize();
  }

  // ---------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------

  /**
   * Append one block of text as a line. Multi-line strings are fine; they
   * render inside a single element with `white-space: pre-wrap`.
   * @param {string} text
   * @param {'out'|'sys'|'ok'|'err'|'hint'|'cmd'|'banner'} kind
   * @returns {HTMLElement} the created element (so callers can update it later)
   */
  print(text = '', kind = 'out') {
    const line = document.createElement('div');
    line.className = `line ${kind}`;
    line.textContent = text;
    this.output.appendChild(line);
    this.scrollToBottom();
    return line;
  }

  /**
   * Append a line made of differently coloured segments.
   * @param {{text: string, kind?: string}[]} segments
   */
  printRich(segments) {
    const line = document.createElement('div');
    line.className = 'line';
    for (const { text, kind } of segments) {
      const span = document.createElement('span');
      span.className = kind ? `seg ${kind}` : 'seg';
      span.textContent = text;
      line.appendChild(span);
    }
    this.output.appendChild(line);
    this.scrollToBottom();
    return line;
  }

  /** Replace the text of a line previously returned by print(). */
  updateLine(lineEl, text, kind) {
    lineEl.textContent = text;
    if (kind) lineEl.className = `line ${kind}`;
    this.scrollToBottom();
  }

  /** Echo a submitted command the way a real shell does: `prompt command`. */
  printCommand(text) {
    const line = this.printRich([
      { text: this.promptEl.textContent + ' ', kind: 'cyan' },
      { text, kind: '' },
    ]);
    line.classList.add('cmd');
    return line;
  }

  clear() {
    this.output.replaceChildren();
  }

  scrollToBottom() {
    // Wait for layout so the new line's height is included.
    requestAnimationFrame(() => {
      this.screen.scrollTop = this.screen.scrollHeight;
    });
  }

  // ---------------------------------------------------------------------
  // Prompt / state
  // ---------------------------------------------------------------------

  setPrompt(text) {
    this.promptEl.textContent = text;
  }

  /**
   * While busy (PHP running) the input is read-only. We use readOnly instead
   * of disabled so the on-screen keyboard on phones does not close.
   */
  setBusy(isBusy) {
    this.busy = isBusy;
    this.root.classList.toggle('busy', isBusy);
    this.input.readOnly = isBusy;
    if (!isBusy) this.focus();
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  getHistory() {
    return this.history.slice();
  }

  // ---------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------

  handleKeyDown(e) {
    if (this.busy) {
      // Swallow Enter so nothing is queued while PHP is running.
      if (e.key === 'Enter') e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      this.complete();
      return;
    }

    if (e.key === 'ArrowUp' && this.caretOnFirstLine()) {
      e.preventDefault();
      this.stepHistory(-1);
      return;
    }

    if (e.key === 'ArrowDown' && this.caretOnLastLine()) {
      e.preventDefault();
      this.stepHistory(1);
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      this.clear();
      return;
    }

    // Ctrl+C with nothing selected cancels the current input, like a shell.
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && this.input.selectionStart === this.input.selectionEnd) {
      e.preventDefault();
      this.printCommand(this.input.value + '^C');
      this.setInput('');
    }
  }

  submit() {
    const text = this.input.value;
    this.printCommand(text);
    this.setInput('');

    const trimmed = text.trim();
    if (trimmed) {
      // Don't store consecutive duplicates (same as bash's HISTCONTROL=ignoredups).
      if (this.history[this.history.length - 1] !== trimmed) {
        this.history.push(trimmed);
        if (this.history.length > MAX_HISTORY) this.history.shift();
      }
    }
    this.historyIndex = this.history.length;
    this.draft = '';

    this.onSubmit(text);
  }

  setInput(value) {
    this.input.value = value;
    this.autoResize();
    // Put the caret at the end.
    this.input.selectionStart = this.input.selectionEnd = value.length;
  }

  /** Grow/shrink the textarea to fit its content (multi-line input). */
  autoResize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight}px`;
    this.scrollToBottom();
  }

  caretOnFirstLine() {
    return !this.input.value.slice(0, this.input.selectionStart).includes('\n');
  }

  caretOnLastLine() {
    return !this.input.value.slice(this.input.selectionEnd).includes('\n');
  }

  /** Move through history: direction -1 = older, +1 = newer. */
  stepHistory(direction) {
    if (this.history.length === 0) return;

    if (this.historyIndex === this.history.length) {
      // Leaving the "new input" slot: remember what was typed so far.
      this.draft = this.input.value;
    }

    const next = this.historyIndex + direction;
    if (next < 0 || next > this.history.length) return;
    this.historyIndex = next;

    const value = next === this.history.length ? this.draft : this.history[next];
    this.setInput(value);
  }

  /** Tab completion of the word before the caret, using the onComplete callback. */
  complete() {
    const before = this.input.value.slice(0, this.input.selectionStart);
    const after = this.input.value.slice(this.input.selectionStart);
    const candidates = this.onComplete ? this.onComplete(before) : [];

    if (candidates.length === 0) return;

    // Candidates are full replacements for the *last word* of `before`.
    const lastWordStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
    const prefix = before.slice(0, lastWordStart);

    if (candidates.length === 1) {
      const completed = prefix + candidates[0] + ' ';
      this.input.value = completed + after;
      this.input.selectionStart = this.input.selectionEnd = completed.length;
      this.autoResize();
      return;
    }

    // Several matches: fill in the common prefix and list the options.
    const common = commonPrefix(candidates);
    this.input.value = prefix + common + after;
    this.input.selectionStart = this.input.selectionEnd = (prefix + common).length;
    this.print(candidates.join('  '), 'sys');
    this.autoResize();
  }
}

function commonPrefix(words) {
  let prefix = words[0];
  for (const word of words.slice(1)) {
    while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
