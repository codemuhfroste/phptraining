/**
 * editor.js — the larger code editor panel (CodeMirror 6 with PHP highlighting).
 *
 * The panel is a plain <section> in index.html that we show/hide. Only one
 * action is "primary": in exercise mode Ctrl+Enter submits the tests, in REPL
 * mode it runs the code. Esc closes the panel.
 */

import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { basicSetup } from 'codemirror';
import { php } from '@codemirror/lang-php';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * @param {object} options
 * @param {HTMLElement} options.panel
 * @param {HTMLElement} options.host         where CodeMirror mounts
 * @param {HTMLElement} options.titleEl
 * @param {HTMLButtonElement} options.runButton
 * @param {HTMLButtonElement} options.submitButton
 * @param {HTMLButtonElement} options.closeButton
 * @param {(code: string) => void} options.onRun
 * @param {(code: string) => void} options.onSubmit
 * @param {() => void} [options.onClose]
 */
export function createEditor({ panel, host, titleEl, runButton, submitButton, closeButton, onRun, onSubmit, onClose }) {
  let primary = 'run'; // 'run' | 'submit' — what Ctrl+Enter does

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: '',
      extensions: [
        // Highest precedence so our shortcuts win over basicSetup's.
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run: () => (triggerPrimary(), true) },
            { key: 'Escape', run: () => (close(), true) },
          ]),
        ),
        basicSetup,
        keymap.of([indentWithTab]),
        indentUnit.of('    '),
        php(),
        oneDark,
        EditorView.lineWrapping,
      ],
    }),
  });

  function getCode() {
    return view.state.doc.toString();
  }

  function setCode(code) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  }

  function triggerPrimary() {
    if (primary === 'submit') onSubmit(getCode());
    else onRun(getCode());
  }

  /**
   * Show the panel.
   * @param {{ title?: string, code?: string, primary?: 'run'|'submit' }} options
   */
  function open({ title = 'editor', code, primary: primaryAction = 'run' } = {}) {
    primary = primaryAction;
    titleEl.textContent = title;
    submitButton.hidden = primaryAction !== 'submit';
    if (typeof code === 'string') setCode(code);
    panel.hidden = false;
    document.body.classList.add('editor-open');
    // Focus after the panel is laid out so the caret is visible.
    requestAnimationFrame(() => view.focus());
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    document.body.classList.remove('editor-open');
    onClose?.();
  }

  function isOpen() {
    return !panel.hidden;
  }

  runButton.addEventListener('click', () => onRun(getCode()));
  submitButton.addEventListener('click', () => onSubmit(getCode()));
  closeButton.addEventListener('click', close);

  return { open, close, isOpen, getCode, setCode, focus: () => view.focus() };
}
