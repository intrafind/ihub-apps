// Plain-node test (node server/tests/workflow-model-resolution.test.js).
// Covers the shared BaseNodeExecutor.resolveModel precedence and the fact that
// query-plan / quote-validator nodes now inherit it (previously they resolved
// only config.modelId → global default, ignoring the chat-selected model and
// the workflow-level default). Verifier intentionally keeps its own override.
import { BaseNodeExecutor } from '../services/workflow/executors/BaseNodeExecutor.js';
import { QueryPlanNodeExecutor } from '../services/workflow/executors/QueryPlanNodeExecutor.js';
import { QuoteValidatorNodeExecutor } from '../services/workflow/executors/QuoteValidatorNodeExecutor.js';
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

function run() {
  const base = new BaseNodeExecutor();
  const models = [
    { id: 'global-default', default: true },
    { id: 'node-model' },
    { id: 'app-model' },
    { id: 'workflow-model' },
    { id: 'context-model' },
    { id: 'durable-node-model' },
    { id: 'durable-run-model' }
  ];

  const wfCtx = { workflow: { config: { defaultModelId: 'workflow-model' } } };

  // 1. Explicit node config.modelId wins over everything else.
  check(
    'config.modelId wins over override/workflow/context',
    base.resolveModel(
      models,
      { modelId: 'node-model' },
      { ...wfCtx, modelId: 'context-model' },
      { data: { _modelOverride: 'app-model' } },
      'n1'
    )?.id === 'node-model'
  );

  // 2. THE FIX: the chat/app-selected model (_modelOverride) beats the
  //    workflow-level defaultModelId, the context model, and the global default.
  const m2 = base.resolveModel(
    models,
    {},
    { ...wfCtx, modelId: 'context-model' },
    { data: { _modelOverride: 'app-model' } },
    'n1'
  );
  check('_modelOverride beats workflow defaultModelId', m2?.id === 'app-model', m2?.id);

  // 3. Workflow defaultModelId is used when no node model / override is present.
  check(
    'workflow defaultModelId used when no override',
    base.resolveModel(models, {}, wfCtx, { data: {} }, 'n1')?.id === 'workflow-model'
  );

  // 4. context.modelId used when nothing higher-priority is set.
  check(
    'context.modelId used as a later fallback',
    base.resolveModel(models, {}, { modelId: 'context-model' }, { data: {} }, 'n1')?.id ===
      'context-model'
  );

  // 5. Global default is the final fallback.
  check(
    'global default is the final fallback',
    base.resolveModel(models, {}, {}, { data: {} }, 'n1')?.id === 'global-default'
  );

  // 6. Durable per-node agent model (step 1) wins even over _modelOverride,
  //    matching prompt-node behavior for agent runs.
  const stateNode = {
    data: {
      _modelOverride: 'app-model',
      _agentModelConfig: {
        defaultModelId: 'durable-run-model',
        nodeModels: { n1: 'durable-node-model' }
      }
    }
  };
  check(
    'durable per-node model wins over _modelOverride',
    base.resolveModel(models, {}, {}, stateNode, 'n1')?.id === 'durable-node-model'
  );

  // 7. No models → null (both empty and non-array).
  check('empty models → null', base.resolveModel([], {}, {}) === null);
  check('non-array models → null', base.resolveModel(null, {}, {}) === null);

  // 8. Design intent: query-plan and quote-validator INHERIT the base resolver
  //    (no per-executor override), while verifier intentionally overrides it.
  check(
    'QueryPlan inherits BaseNodeExecutor.resolveModel',
    QueryPlanNodeExecutor.prototype.resolveModel === BaseNodeExecutor.prototype.resolveModel
  );
  check(
    'QuoteValidator inherits BaseNodeExecutor.resolveModel',
    QuoteValidatorNodeExecutor.prototype.resolveModel === BaseNodeExecutor.prototype.resolveModel
  );
  check(
    'Verifier intentionally overrides resolveModel',
    VerifierNodeExecutor.prototype.resolveModel !== BaseNodeExecutor.prototype.resolveModel
  );

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
