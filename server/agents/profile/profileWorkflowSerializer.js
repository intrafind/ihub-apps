/**
 * Profile Workflow Serializer
 *
 * Given an AgentProfile, produces a complete embedded workflow definition that
 * the workflow engine can execute. Profile authors may provide their own
 * embedded definition; otherwise this builds a sensible default based on the
 * Profile's planner / dynamicTasks settings.
 *
 * Three default shapes:
 *
 *  - Simple        : start → agent → end
 *  - Drain only    : start → seed → drain(child=task_runner) → end
 *  - Planner+drain : start → planner → ... → drain → end (Planner materializes sub-DAG)
 *
 * Profile-level convenience fields (system, preferredModel, tools, sources,
 * apps, dynamicTasks) propagate into every prompt node in the default
 * workflow so the form-based editor can stay flat.
 */

import logger from '../../utils/logger.js';

function pickModel(profile) {
  return profile.preferredModel || null;
}

function pickIterations(profile, fallback) {
  if (typeof profile.maxIterations === 'number') return profile.maxIterations;
  return fallback;
}

function basePromptConfig(profile, { systemFallbackKey, fallbackIterations }) {
  return {
    modelId: pickModel(profile),
    ...(profile.preferredTemperature !== undefined
      ? { temperature: profile.preferredTemperature }
      : {}),
    system:
      profile.system && Object.keys(profile.system).length > 0
        ? profile.system
        : profile.description || { en: systemFallbackKey },
    maxIterations: pickIterations(profile, fallbackIterations),
    tools: Array.isArray(profile.tools) ? profile.tools.slice() : [],
    apps: Array.isArray(profile.apps) ? profile.apps.slice() : [],
    sources: Array.isArray(profile.sources) ? profile.sources.slice() : []
  };
}

function buildSimpleWorkflow(profile) {
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'agent',
        type: 'prompt',
        config: basePromptConfig(profile, {
          systemFallbackKey: 'You are a helpful agent.',
          fallbackIterations: 10
        })
      },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { from: 'start', to: 'agent' },
      { from: 'agent', to: 'end' }
    ]
  };
}

function buildDrainOnlyWorkflow(profile) {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const taskRunnerNode = {
    id: 'task_runner',
    type: 'prompt',
    config: {
      ...basePromptConfig(profile, {
        systemFallbackKey: 'Process the current task.',
        fallbackIterations: 10
      }),
      dynamicTasks: { enabled: true, maxDepth }
    }
  };
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'seed',
        type: 'prompt',
        config: {
          ...basePromptConfig(profile, {
            systemFallbackKey: 'Seed initial tasks from your inbox.',
            fallbackIterations: 5
          }),
          dynamicTasks: { enabled: true, maxDepth }
        }
      },
      {
        id: 'drain',
        type: 'loop',
        config: {
          mode: 'drain',
          queueKey: '_taskQueue',
          body: [taskRunnerNode],
          maxIterations: 50
        }
      },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { from: 'start', to: 'seed' },
      { from: 'seed', to: 'drain' },
      { from: 'drain', to: 'end' }
    ]
  };
}

function buildPlannerWorkflow(profile) {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const useDrain = profile.dynamicTasks?.enabled !== false;
  // The Planner needs a `goal`. It always pulls from `state.data.brief`,
  // which the run trigger pre-populates with the operator-supplied brief
  // (falling back to the Profile's system instructions when no brief is
  // supplied — see server/routes/agents/runs.js).
  const goal = '${$.data.brief}';
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'planner',
        type: 'planner',
        config: {
          modelId: pickModel(profile),
          goal,
          maxTasks: profile.planner?.maxTasks ?? 10,
          taskTemplate: {
            type: 'prompt',
            config: {
              ...basePromptConfig(profile, {
                systemFallbackKey: 'Execute this planned sub-task.',
                fallbackIterations: 10
              }),
              dynamicTasks: { enabled: useDrain, maxDepth }
            }
          },
          ...(useDrain ? { dynamicTasks: { enabled: true, maxDepth } } : {})
        }
      },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { from: 'start', to: 'planner' },
      { from: 'planner', to: 'end' }
    ]
  };
}

/**
 * Pick a sensible default workflow shape for the given Profile.
 */
export function buildDefaultWorkflowForProfile(profile) {
  if (profile.planner?.enabled) return buildPlannerWorkflow(profile);
  if (profile.dynamicTasks?.enabled) return buildDrainOnlyWorkflow(profile);
  return buildSimpleWorkflow(profile);
}

/**
 * Take a Profile config and ensure it has a complete, valid embedded workflow
 * definition. Returns a NEW profile object (does not mutate).
 *
 *  - If profile.workflow.ref === 'external', leave it untouched.
 *  - If profile.workflow.definition has nodes, leave it untouched (but
 *    still propagate the Profile-level convenience fields into existing
 *    prompt nodes whose config doesn't already specify them — this is what
 *    makes Save in the form mode work after the user changes the system
 *    prompt or tools list).
 *  - Otherwise, fill in a default workflow definition.
 */
export function serializeProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('serializeProfile requires a profile object');
  }
  const next = JSON.parse(JSON.stringify(profile));

  if (!next.workflow) next.workflow = { ref: 'embedded' };
  if (next.workflow.ref === 'external') return next;

  const hasDefinition =
    next.workflow.definition &&
    Array.isArray(next.workflow.definition.nodes) &&
    next.workflow.definition.nodes.length > 0;

  if (!hasDefinition) {
    next.workflow.ref = 'embedded';
    next.workflow.definition = buildDefaultWorkflowForProfile(next);
    logger.info('Filled in default workflow definition for profile', {
      component: 'ProfileWorkflowSerializer',
      profileId: next.id,
      shape: next.planner?.enabled
        ? 'planner+drain'
        : next.dynamicTasks?.enabled
          ? 'drain-only'
          : 'simple'
    });
  } else {
    // Workflow already authored. Propagate Profile-level convenience fields
    // into prompt nodes that haven't explicitly set them. Authors who want
    // per-node overrides simply set the field on the node and it wins.
    const propagated = propagateProfileFields(next, next.workflow.definition.nodes);
    next.workflow.definition.nodes = propagated;
  }

  return next;
}

function propagateProfileFields(profile, nodes) {
  const sys = profile.system && Object.keys(profile.system).length > 0 ? profile.system : null;
  const model = profile.preferredModel || null;
  const temp = profile.preferredTemperature;
  const tools = Array.isArray(profile.tools) ? profile.tools : null;
  const apps = Array.isArray(profile.apps) ? profile.apps : null;
  const sources = Array.isArray(profile.sources) ? profile.sources : null;
  return nodes.map(node => {
    if (!node) return node;
    if (node.type === 'prompt') {
      const cfg = node.config || {};
      const merged = {
        ...cfg,
        ...(sys && !cfg.system ? { system: sys } : {}),
        ...(model && !cfg.modelId ? { modelId: model } : {}),
        ...(typeof temp === 'number' && cfg.temperature === undefined ? { temperature: temp } : {}),
        ...(tools && (!Array.isArray(cfg.tools) || cfg.tools.length === 0) ? { tools } : {}),
        ...(apps && (!Array.isArray(cfg.apps) || cfg.apps.length === 0) ? { apps } : {}),
        ...(sources && (!Array.isArray(cfg.sources) || cfg.sources.length === 0) ? { sources } : {})
      };
      return { ...node, config: merged };
    }
    if (node.type === 'planner') {
      const cfg = node.config || {};
      const merged = {
        ...cfg,
        ...(!cfg.goal ? { goal: '${$.data.brief}' } : {}),
        ...(model && !cfg.modelId ? { modelId: model } : {})
      };
      return { ...node, config: merged };
    }
    return node;
  });
}

export default { serializeProfile, buildDefaultWorkflowForProfile };
