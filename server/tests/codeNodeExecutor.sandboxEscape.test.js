#!/usr/bin/env node

/**
 * Regression tests for CodeNodeExecutor's VM sandbox.
 *
 * CodeNodeExecutor used to inject host-realm built-ins (Array, String, Date,
 * etc.) directly into the vm sandbox. Because those are the *host's*
 * intrinsics, `Array.constructor` was the host's Function, letting user code
 * escape the sandbox via `Array.constructor('return process')()` and get
 * arbitrary code execution in the server process. The fix stops injecting
 * host built-ins — the vm context's own realm already provides safe copies.
 *
 * Verifies:
 *   - Common escape patterns (Array/String/Object/Function-constructor
 *     chains) never yield the real `process`/`require`/`global`.
 *   - Legitimate code using Array, Math, Date, JSON, RegExp, etc. still works.
 *
 * Run directly: `node server/tests/codeNodeExecutor.sandboxEscape.test.js`.
 */

import { CodeNodeExecutor } from '../services/workflow/executors/CodeNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details !== undefined) console.log(`   ${JSON.stringify(details)}`);
}

function makeExecutor() {
  return new CodeNodeExecutor();
}

async function runCode(code, data = {}) {
  const executor = makeExecutor();
  return executor.execute({ id: 'code-under-test', type: 'code', config: { code } }, { data }, {});
}

async function run() {
  const escapeAttempts = [
    "Array.constructor('return process')()",
    "[].constructor.constructor('return process')()",
    "({}).constructor.constructor('return process')()",
    "String.constructor('return require')()",
    "Object.getPrototypeOf([]).constructor.constructor('return globalThis')()"
  ];

  for (const attempt of escapeAttempts) {
    const result = await runCode(attempt);
    const leaked =
      result.status === 'completed' &&
      result.output?.result &&
      typeof result.output.result === 'object' &&
      (result.output.result.pid !== undefined ||
        typeof result.output.result.require === 'function');
    check(`escape blocked: ${attempt}`, !leaked, result.output);
  }

  // Legitimate use of standard built-ins must still work without host injection.
  {
    const result = await runCode(
      `
        const items = data.searchResults || [];
        items.map(item => ({ title: item.name.toUpperCase(), score: Math.round(item.relevance * 100) }));
      `,
      { searchResults: [{ name: 'foo', relevance: 0.5 }] }
    );
    check('legit Array/Math usage → completed', result.status === 'completed', result);
    check(
      'legit Array/Math usage → correct output',
      JSON.stringify(result.output?.result) === JSON.stringify([{ title: 'FOO', score: 50 }]),
      result.output
    );
  }

  {
    const result = await runCode(
      `({ now: Date.now() > 0, parsed: JSON.parse('{"a":1}').a, re: /^a+$/.test('aaa') });`
    );
    check('legit Date/JSON/RegExp usage → completed', result.status === 'completed', result);
    check(
      'legit Date/JSON/RegExp usage → correct output',
      result.output?.result?.now === true &&
        result.output?.result?.parsed === 1 &&
        result.output?.result?.re === true,
      result.output
    );
  }

  console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Test harness error:', err);
  process.exit(1);
});
