/**
 * Agent Run Wiring
 *
 * Resolves an agent profile into a fully-configured workflow definition ready
 * to hand to a WorkflowEngine. This is the piece that used to be duplicated
 * between the manual-trigger route, the resume-from-terminated route (both in
 * routes/agents/runs.js), and the boot-time interrupted-run resume path in
 * server.js — any change to run wiring (a new override rule, a timeout tweak)
 * had to be made in every copy or resumed runs would silently diverge from
 * freshly-started ones.
 *
 * Deliberately NOT included here: building the run's `initialData`/`_agent`
 * envelope. A manual trigger builds a fresh principal and empty artifact
 * list; a boot-time resume restores an existing principal from the persisted
 * state. That bookkeeping stays with each caller — this module only produces
 * the `workflow` definition plus the two durable config blobs
 * (`agentModelConfig`, `agentReviewConfig`) callers stash into run state.
 */

import configCache from '../../configCache.js';
import { serializeProfile } from '../profile/profileWorkflowSerializer.js';
import { resolveReviewSettings } from '../profile/reviewSettings.js';

/**
 * Apply a profile's per-step model overrides onto the resolved workflow.
 * `nodeModels` maps node id → model id; each match sets that node's
 * `config.modelId`, which the executors honor first (above the run-wide
 * default). Mutates and returns the workflow. No-op when nodeModels is empty.
 *
 * @param {Object} workflow
 * @param {Object<string,string>} [nodeModels]
 * @returns {Object} the same workflow
 */
export function applyNodeModels(workflow, nodeModels) {
  if (!workflow || !Array.isArray(workflow.nodes) || !nodeModels) return workflow;
  for (const node of workflow.nodes) {
    if (node && typeof node.id === 'string' && nodeModels[node.id]) {
      node.config = { ...(node.config || {}), modelId: nodeModels[node.id] };
    }
  }
  return workflow;
}

/**
 * Inject resolved review knobs onto every verifier node's config. Mirrors
 * applyNodeModels: external workflows ignore profile flags, so the run-start
 * code wires per-node config. Mutates and returns the workflow.
 * @param {Object} workflow
 * @param {Object} resolved - from resolveReviewSettings()
 */
export function applyReviewSettings(workflow, resolved) {
  if (!workflow || !Array.isArray(workflow.nodes) || !resolved) return workflow;
  for (const node of workflow.nodes) {
    if (node?.type !== 'verifier') continue;
    node.config = {
      ...(node.config || {}),
      maxRetries: resolved.maxRetries,
      stallLimit: resolved.stallLimit,
      acceptPartial: resolved.acceptPartial,
      acceptPartialAfterStall: resolved.acceptPartialAfterStall,
      requirePass: resolved.requirePass,
      ...(resolved.criteria ? { criteria: resolved.criteria } : {})
    };
  }
  return workflow;
}

/**
 * Resolve an agent profile into a ready-to-run workflow definition: picks the
 * embedded or external workflow, wires the wall-time budget and default
 * model, then applies per-node model and review overrides.
 *
 * @param {Object} profile - agent profile (contents/agents/*.json)
 * @returns {{workflow: Object, agentModelConfig: Object, agentReviewConfig: Object}}
 */
export function buildAgentRun(profile) {
  const serialized = serializeProfile(profile);

  // Resolve workflow: either the profile's embedded definition or a reference
  // to a hand-authored workflow in contents/workflows/. External refs let
  // authors wire complex workflows (e.g. iterative-research-auto) to an agent
  // profile without having to inline the whole definition into the profile
  // file. Deep-clone the external definition — getWorkflowById returns the
  // SHARED cached object and callers mutate config/nodes below (embedded
  // definitions are already cloned by serializeProfile).
  let workflow;
  if (
    serialized.workflow?.ref === 'external' &&
    typeof serialized.workflow.workflowId === 'string'
  ) {
    const cached = configCache.getWorkflowById(serialized.workflow.workflowId);
    if (!cached) {
      const error = new Error(`External workflow ${serialized.workflow.workflowId} not found`);
      error.code = 'WORKFLOW_NOT_FOUND';
      throw error;
    }
    workflow = JSON.parse(JSON.stringify(cached));
  } else {
    workflow = serialized.workflow?.definition || {};
  }
  workflow.id = workflow.id || `agent:${profile.id}`;

  // Calculate the wall-time deadline via workflow config. Also publish the
  // profile's preferred model as the run's workflow-level default so EVERY
  // LLM node inherits it (the prompt/agent node via getModel step 3, and the
  // verifier via the same defaultModelId) — without this, an EXTERNAL
  // workflow's nodes fall back to the global default model and the operator
  // has no single place to set the run's model. A node may still override
  // per-node with its own `config.modelId`.
  const maxWallTimeSec = profile.budgets?.maxWallTimeSec ?? 600;
  workflow.config = {
    ...(workflow.config || {}),
    maxExecutionTime: maxWallTimeSec * 1000,
    ...(profile.preferredModel ? { defaultModelId: profile.preferredModel } : {})
  };

  // Per-step model overrides (profile.nodeModels) win over the run-wide
  // default for the listed nodes.
  applyNodeModels(workflow, profile.nodeModels);

  // Inject resolved review knobs onto every verifier node so EXTERNAL
  // workflows (which don't reference profile flags directly) pick up the
  // operator's strictness / retry / acceptance configuration.
  const agentReviewConfig = resolveReviewSettings(profile.review);
  applyReviewSettings(workflow, agentReviewConfig);

  const agentModelConfig = {
    defaultModelId: profile.preferredModel || null,
    nodeModels: profile.nodeModels || {}
  };

  return { workflow, agentModelConfig, agentReviewConfig };
}

export default { buildAgentRun, applyNodeModels, applyReviewSettings };
