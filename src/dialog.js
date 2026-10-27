// dialog.js
// The app's own questions and messages, instead of the browser's confirm() and alert(): those are small,
// grey, in the middle of the screen, say only "OK" / "Cancel", and look different in every browser.
// Here every dialog has big buttons (gloves), a high-contrast frame, and buttons that say what they do
// ("Restart from the beginning" / "Keep this run"). The safe choice is always on the left and has the focus,
// so a stray Enter or a second tap does not do the risky thing. Esc (or the safe button) answers "no".
// No screen state of its own: ui.js decides what is asked and logs the answer.

let queue = Promise.resolve();   // one dialog at a time: a second one waits until the first is answered

// ask({ title, text, yes, no, danger }) → Promise<boolean>: true only when the operator chose `yes`.
// danger: the `yes` button is red (it stops or throws away something).
export function ask({ title = '', text = '', yes, no, danger = false }) {
  return show({ title, text, buttons: [{ label: no, value: false, safe: true }, { label: yes, value: true, danger }] });
}

// tell({ title, text, ok }) → Promise<void>: a message with one button.
export function tell({ title = '', text = '', ok }) {
  return show({ title, text, buttons: [{ label: ok, value: undefined, safe: true }] });
}

// Is a dialog open now? (Keys meant for the sheet are ignored while one is.)
export const isOpen = () => !!document.querySelector('dialog.app-dialog[open]');

function show(opts) {
  const run = queue.then(() => open(opts));
  queue = run.catch(() => {});
  return run;
}

function open({ title, text, buttons }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-dialog';
    if (title) {
      const h = document.createElement('h2');
      h.className = 'dialog-title';
      h.textContent = title;
      dlg.append(h);
    }
    // Blank lines in the text become paragraphs.
    for (const para of String(text).split(/\n{2,}/).map(s => s.trim()).filter(Boolean)) {
      const p = document.createElement('p');
      p.className = 'dialog-text';
      p.textContent = para;
      dlg.append(p);
    }
    const row = document.createElement('div');
    row.className = `dialog-buttons n${buttons.length}`;
    let safeValue;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      // A lone button is the main one (dark); next to a risky choice the safe one is plain.
      const look = b.danger ? ' is-danger' : b.safe && buttons.length > 1 ? '' : ' btn-done';
      btn.className = `btn dialog-btn${look}`;
      btn.textContent = b.label;
      btn.addEventListener('click', () => finish(b.value));
      if (b.safe) { safeValue = b.value; btn.dataset.safe = ''; }
      row.append(btn);
    }
    dlg.append(row);

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    }
    // Esc closes a modal dialog by itself: count it as the safe answer.
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(safeValue); });

    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[data-safe]')?.focus();
  });
}
