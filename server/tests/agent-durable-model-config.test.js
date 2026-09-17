// Plain-node test (node server/tests/agent-durable-model-config.test.js).
// Regression for: agent nodes (planner/synthesize/verify + sub-tasks) silently
// fell back to the global default model (local-vllm, 32k ctx) on re-execution.
// Root cause: profile.preferredModel/nodeModels are applied at runtime by
// mutating the SHARED cached workflow object; the config-cache TTL refresh
// reloads workflows.json from disk and discards those mutations. The fix stores
// the agent model config durably in run state (_agentModelConfig) and has the
// resolvers fall back to it. This test asserts that durable fallback.
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

function run() {
  const v = new VerifierNodeExecutor();
  const models = [
    { id: 'local-vllm', default: true },
    { id: 'gemini-flash-latest' },
    { id: 'gemini-3.1-pro' }
  ];
  const state = {
    data: {
      _agentModelConfig: {
        defaultModelId: 'gemini-flash-latest',
        nodeModels: { verify: 'gemini-3.1-pro' }
      }
    }
  };

  // --- resolveConfiguredModelId (shared BaseNodeExecutor helper) ---
  check('per-node override wins', v.resolveConfiguredModelId(state, 'verify') === 'gemini-3.1-pro');
  check(
    'falls to run-wide default when no per-node override',
    v.resolveConfiguredModelId(state, 'planner') === 'gemini-flash-latest'
  );
  check('null state → null', v.resolveConfiguredModelId(null, 'verify') === null);
  check('no _agentModelConfig → null', v.resolveConfiguredModelId({ data: {} }, 'verify') === null);
  check(
    'no nodeId → run-wide default',
    v.resolveConfiguredModelId(state) === 'gemini-flash-latest'
  );

  // --- resolveModel honors the durable config over the global default ---
  const mVerify = v.resolveModel(models, {}, {}, state, 'verify');
  check(
    'verify resolves durable per-node model (NOT local-vllm)',
    mVerify?.id === 'gemini-3.1-pro',
    mVerify?.id
  );

  const mPlanner = v.resolveModel(models, {}, {}, state, 'planner');
  check(
    'node w/o override resolves durable default (NOT local-vllm)',
    mPlanner?.id === 'gemini-flash-latest',
    mPlanner?.id
  );

  // node config.modelId still wins over everything
  const mExplicit = v.resolveModel(models, { modelId: 'local-vllm' }, {}, state, 'verify');
  check('explicit node config.modelId still wins', mExplicit?.id === 'local-vllm');

  // workflow defaultModelId (when present) wins over durable fallback
  const mWf = v.resolveModel(
    models,
    {},
    { workflow: { config: { defaultModelId: 'gemini-flash-latest' } } },
    state,
    'verify'
  );
  check('workflow defaultModelId preferred when present', mWf?.id === 'gemini-flash-latest');

  // no durable config and no workflow default → global default (back-compat)
  const mDefault = v.resolveModel(models, {}, {}, null, 'verify');
  check('back-compat: no config → global default', mDefault?.id === 'local-vllm');

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
