// Plain-node test (node server/tests/valuePreview.test.js).
//
// previewToolValue/compactStringsForPreview used to be duplicated across
// PromptNodeExecutor, MemoryFinalizeNodeExecutor, InboxLoadNodeExecutor, and
// InboxFinalizeNodeExecutor. The Inbox executors carried an older, buggy
// version — `JSON.stringify(value).slice(0, 1024)` — that truncates the
// SERIALISED string, which can land mid-token and produce invalid JSON that
// breaks the UI's `JSON.parse(stepLog...)` rendering. This module is the one
// shared implementation (ported from PromptNodeExecutor) that truncates long
// string fields INSIDE the object before stringifying, so the result always
// stays valid JSON.
import {
  previewToolValue,
  compactStringsForPreview
} from '../services/workflow/executors/valuePreview.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

// ---- primitives pass through / short-circuit ----
check('null → null', previewToolValue(null) === null);
check('undefined → null', previewToolValue(undefined) === null);
check('number passes through', previewToolValue(42) === 42);
check('boolean passes through', previewToolValue(false) === false);
check('short string passes through', previewToolValue('hello') === 'hello');

// ---- long top-level string gets truncated with a suffix (not valid JSON, by design) ----
{
  const longStr = 'x'.repeat(2000);
  const out = previewToolValue(longStr);
  check('long string truncated', out.startsWith('x'.repeat(1024)));
  check('long string has truncation suffix', out.includes('…[truncated 976 chars]'));
}

// ---- objects/arrays: output must always be valid, parseable JSON ----
{
  const value = { note: 'y'.repeat(1000), ok: true };
  const out = previewToolValue(value);
  let parsed;
  let parseError = null;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    parseError = err;
  }
  check('object preview is valid JSON', parseError === null, String(parseError));
  check('long field truncated in place', parsed && parsed.note.includes('…[+680]'));
  check('short field preserved', parsed && parsed.ok === true);
}

// ---- this is the exact bug the Inbox executors had: truncating the
// serialised JSON string (not the fields) can cut mid-string and break parse.
// Confirm our shared helper does NOT do that for a case where the naive
// `JSON.stringify(value).slice(0, N)` approach would produce invalid JSON.
{
  const value = { text: 'z'.repeat(1200) };
  const naiveBroken = JSON.stringify(value).slice(0, 1024);
  let naiveParses = true;
  try {
    JSON.parse(naiveBroken);
  } catch {
    naiveParses = false;
  }
  check('naive slice-the-JSON-string approach is indeed broken here', naiveParses === false);

  const safe = previewToolValue(value);
  let safeParses = true;
  try {
    JSON.parse(safe);
  } catch {
    safeParses = false;
  }
  check('shared previewToolValue stays valid JSON for the same input', safeParses === true);
}

// ---- arrays: capped at 20 items with a placeholder ----
{
  const arr = Array.from({ length: 25 }, (_, i) => i);
  const out = compactStringsForPreview(arr, 320, 0);
  check('array capped at 20 items + placeholder', out.length === 21);
  check('placeholder text correct', out[20] === '…[+5 items]');
}

// ---- depth is bounded to avoid pathological/cyclic-ish structures ----
{
  let nested = 'leaf';
  for (let i = 0; i < 10; i++) nested = { child: nested };
  const out = compactStringsForPreview(nested, 320, 0);
  // Walk down until we hit the depth-limit placeholder.
  let cur = out;
  let depth = 0;
  while (cur && typeof cur === 'object' && 'child' in cur) {
    cur = cur.child;
    depth++;
  }
  check('deep nesting hits the depth cutoff', cur === '[…]', `stopped at depth ${depth}`);
}

// ---- circular refs don't blow the stack — the depth cutoff bounds them ----
// before JSON.stringify ever sees the (still-cyclic) original value.
{
  const circular = {};
  circular.self = circular;
  let out;
  let threw = false;
  try {
    out = previewToolValue(circular);
  } catch {
    threw = true;
  }
  check('circular object does not throw', threw === false);
  let parses = true;
  try {
    JSON.parse(out);
  } catch {
    parses = false;
  }
  check('circular object preview is still valid JSON', parses === true);
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
