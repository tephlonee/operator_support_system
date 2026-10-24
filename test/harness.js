// harness.js
// A tiny test helper: collects PASS/FAIL checks and shows them as a table on the test page.

export const results = [];
export const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
export const near = (a, b, tol) => Math.abs(a - b) <= tol;

export function renderResults() {
  const failed = results.filter(r => !r.ok).length;
  const summary = document.getElementById('summary');
  summary.textContent = failed ? `FAIL: ${failed} of ${results.length} checks failed` : `PASS: all ${results.length} checks passed`;
  summary.className = failed ? 'fail' : 'pass';
  const rows = results.map(r => {
    const tr = document.createElement('tr');
    tr.className = r.ok ? 'pass' : 'fail';
    for (const text of [r.ok ? 'PASS' : 'FAIL', r.name, r.detail]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  });
  document.getElementById('results').replaceChildren(...rows);
}
