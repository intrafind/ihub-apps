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
 */

import logger from '../../utils/logger.js';

const DEFAULT_MODEL_ID = null; // null = engine picks default

function buildSimpleWorkflow(profile, language = 'en') {
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'agent',
        type: 'prompt',
        config: {
          modelId: DEFAULT_MODEL_ID,
          system: profile.description || { [language]: 'You are a helpful agent.' },
          maxIterations: 10,
          tools: [],
          apps: [],
          sources: []
        }
      },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { from: 'start', to: 'agent' },
      { from: 'agent', to: 'end' }
    ]
  };
}

function buildDrainOnlyWorkflow(profile, language = 'en') {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const taskRunnerNode = {
    id: 'task_runner',
    type: 'prompt',
    config: {
      modelId: DEFAULT_MODEL_ID,
      system: profile.description || { [language]: 'Process the current task.' },
      maxIterations: 10,
      tools: [],
      apps: [],
      sources: [],
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
          modelId: DEFAULT_MODEL_ID,
          system: profile.description || { [language]: 'Seed initial tasks from your inbox.' },
          maxIterations: 5,
          tools: [],
          apps: [],
          sources: [],
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

function buildPlannerWorkflow(profile, _language = 'en') {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const useDrain = profile.dynamicTasks?.enabled !== false;
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'planner',
        type: 'planner',
        config: {
          modelId: DEFAULT_MODEL_ID,
          maxTasks: profile.planner?.maxTasks ?? 10,
          taskTemplate: {
            type: 'prompt',
            config: {
              modelId: DEFAULT_MODEL_ID,
              maxIterations: 10,
              tools: [],
              apps: [],
              sources: [],
              dynamicTasks: { enabled: useDrain, maxDepth }
            }
          }
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
export function buildDefaultWorkflowForProfile(profile, language = 'en') {
  if (profile.planner?.enabled) {
    return buildPlannerWorkflow(profile, language);
  }
  if (profile.dynamicTasks?.enabled) {
    return buildDrainOnlyWorkflow(profile, language);
  }
  return buildSimpleWorkflow(profile, language);
}

/**
 * Take a Profile config and ensure it has a complete, valid embedded workflow
 * definition. Returns a NEW profile object (does not mutate).
 *
 *  - If profile.workflow.ref === 'external', leave it untouched.
 *  - If profile.workflow.definition has nodes, leave it untouched.
 *  - Otherwise, fill in a default workflow definition.
 */
export function serializeProfile(profile, options = {}) {
  const { language = 'en' } = options;
  if (!profile || typeof profile !== 'object') {
    throw new Error('serializeProfile requires a profile object');
  }

  const next = JSON.parse(JSON.stringify(profile));

  if (!next.workflow) {
    next.workflow = { ref: 'embedded' };
  }
  if (next.workflow.ref === 'external') {
    return next;
  }
  if (
    next.workflow.definition &&
    Array.isArray(next.workflow.definition.nodes) &&
    next.workflow.definition.nodes.length > 0
  ) {
    return next;
  }

  next.workflow.ref = 'embedded';
  next.workflow.definition = buildDefaultWorkflowForProfile(next, language);
  logger.info('Filled in default workflow definition for profile', {
    component: 'ProfileWorkflowSerializer',
    profileId: next.id,
    shape: next.planner?.enabled
      ? 'planner+drain'
      : next.dynamicTasks?.enabled
        ? 'drain-only'
        : 'simple'
  });
  return next;
}

export default { serializeProfile, buildDefaultWorkflowForProfile };
