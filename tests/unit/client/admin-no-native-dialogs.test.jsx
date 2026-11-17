// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Ratchet: no native browser dialog in the admin area, the workflow editor
 * (opened from the admin area) or the shared
 * components. `window.confirm()` / `alert()` / `prompt()` can't be styled,
 * translated or named — a bare confirm() let the shipped marketplace registry
 * be deleted without saying which one (AX-B14). Use `ConfirmDialog`
 * (named confirmations), `SecretRevealDialog` or an inline message instead.
 *
 * ESLint's `no-alert` (eslint.config.js) enforces the same rule; this test is
 * the check CI cannot skip. The count must stay 0.
 *
 * The files are parsed with espree (comments and strings never count): a call counts when
 * its callee is `confirm`, `alert` or `prompt`, or `window.` / `globalThis.` /
 * `self.` one of them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// espree is ESLint's parser (a CommonJS build is shipped; @babel/parser 8 is ESM only).
const espree = require('espree');

const ROOT = path.resolve(__dirname, '../../../client/src');
const SCANNED = ['features/admin', 'features/workflows', 'shared'];
const NATIVE = new Set(['confirm', 'alert', 'prompt']);
const GLOBALS = new Set(['window', 'globalThis', 'self']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

function isNativeDialogCallee(callee) {
  if (callee?.type === 'Identifier') return NATIVE.has(callee.name);
  if (callee?.type === 'MemberExpression' && !callee.computed) {
    return (
      callee.object?.type === 'Identifier' &&
      GLOBALS.has(callee.object.name) &&
      NATIVE.has(callee.property?.name)
    );
  }
  return false;
}

/** Walks the AST and collects native dialog calls as "file:line name". */
function findNativeDialogCalls(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = espree.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    loc: true
  });
  const hits = [];
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && isNativeDialogCallee(node.callee)) {
      const name =
        node.callee.type === 'Identifier'
          ? node.callee.name
          : `${node.callee.object.name}.${node.callee.property.name}`;
      hits.push(`${path.relative(ROOT, file)}:${node.loc.start.line} ${name}()`);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(ast);
  return hits;
}

describe('no native dialogs in client/src/features/admin and client/src/shared', () => {
  it('finds the call shapes it is meant to find', () => {
    const sample = path.join(os.tmpdir(), `native-dialog-sample-${process.pid}.js`);
    fs.writeFileSync(
      sample,
      [
        '// confirm() in a comment does not count',
        "const s = 'alert(1)';",
        'if (!confirm("x")) {}',
        'window.alert("y");',
        'globalThis.prompt("z");',
        'dialog.confirm();'
      ].join('\n')
    );
    try {
      expect(findNativeDialogCalls(sample).map(hit => hit.replace(/^.*:/, ''))).toEqual([
        '3 confirm()',
        '4 window.alert()',
        '5 globalThis.prompt()'
      ]);
    } finally {
      fs.unlinkSync(sample);
    }
  });

  it('has none', () => {
    const hits = SCANNED.flatMap(dir => sourceFiles(path.join(ROOT, dir))).flatMap(
      findNativeDialogCalls
    );
    expect(hits).toEqual([]);
  });
});
