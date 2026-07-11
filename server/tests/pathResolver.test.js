// Plain-node test (node server/tests/pathResolver.test.js).
// Covers the shared resolveDotPath() used by BaseNodeExecutor.resolveVariable,
// DAGScheduler._getValueFromPath, TransformNodeExecutor/PromptNodeExecutor's
// getNestedValue, and expressionEvaluator.resolvePath. Before consolidation
// these four disagreed on `items[0]` array-index support; this test asserts
// they now behave identically through the shared resolver.
import { resolveDotPath } from '../services/workflow/pathResolver.js';
import { BaseNodeExecutor } from '../services/workflow/executors/BaseNodeExecutor.js';
import { TransformNodeExecutor } from '../services/workflow/executors/TransformNodeExecutor.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { resolvePath } from '../services/workflow/expressionEvaluator.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

function run() {
  // --- resolveDotPath: core traversal ---
  const obj = { a: { b: { c: 42 } }, items: [{ id: 'x' }, { id: 'y' }], list: [1, 2, 3] };

  check('resolves a plain dot path', resolveDotPath('a.b.c', obj) === 42);
  check('resolves an array-index segment', resolveDotPath('items[1].id', obj) === 'y');
  check('returns undefined for missing path', resolveDotPath('a.missing.c', obj) === undefined);
  check(
    'returns undefined when bracket segment is not an array',
    resolveDotPath('a[0]', obj) === undefined
  );
  check('accepts a pre-split parts array', resolveDotPath(['a', 'b', 'c'], obj) === 42);
  check('returns undefined for empty path', resolveDotPath('', obj) === undefined);
  check('returns undefined for non-string/array path', resolveDotPath(null, obj) === undefined);

  // --- BaseNodeExecutor.resolveVariable: $-prefixed, literal fallback ---
  const base = new BaseNodeExecutor();
  const state = { data: { items: [{ id: 'x' }, { id: 'y' }] } };
  check(
    'resolveVariable returns literal for non-$ path',
    base.resolveVariable('plain-literal', state) === 'plain-literal'
  );
  check(
    'resolveVariable resolves $.data.items[1].id',
    base.resolveVariable('$.data.items[1].id', state) === 'y'
  );
  check(
    'resolveVariable returns undefined for missing $ path',
    base.resolveVariable('$.data.missing', state) === undefined
  );

  // --- TransformNodeExecutor.getNestedValue: now supports items[0] ---
  const transform = new TransformNodeExecutor();
  const flatData = { items: [{ id: 'x' }, { id: 'y' }] };
  check(
    'TransformNodeExecutor.getNestedValue supports items[0] (previously unsupported)',
    transform.getNestedValue('items[1].id', flatData) === 'y'
  );
  check(
    'TransformNodeExecutor.getNestedValue still supports dot-numeric index (items.0.id)',
    transform.getNestedValue('items.0.id', flatData) === 'x'
  );

  // --- PromptNodeExecutor.getNestedValue: same parity ---
  const prompt = new PromptNodeExecutor();
  check(
    'PromptNodeExecutor.getNestedValue supports items[0] (previously unsupported)',
    prompt.getNestedValue('items[1].id', flatData) === 'y'
  );

  // --- expressionEvaluator.resolvePath: $ prefix + nodeOutputs remap preserved ---
  const exprState = {
    data: {
      items: [{ id: 'x' }, { id: 'y' }],
      nodeResults: { agent1: { output: { response: 'hi' } } }
    }
  };
  check(
    'resolvePath resolves $.data.items[1].id',
    resolvePath('$.data.items[1].id', exprState) === 'y'
  );
  check(
    'resolvePath still remaps $.nodeOutputs.agent1.response',
    resolvePath('$.nodeOutputs.agent1.response', exprState) === 'hi'
  );
  check(
    'resolvePath returns undefined for a non-$ path',
    resolvePath('data.items', exprState) === undefined
  );

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
