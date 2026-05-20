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
import configCache from '../../configCache.js';

function pickModel(profile) {
  if (profile.preferredModel) return profile.preferredModel;
  // No preferred model set. Fall back to the first text-capable enabled model
  // — the planner expects JSON output, which image-generation models can't
  // produce. We do this at serialize-time so the persisted workflow has a
  // concrete model id and isn't subject to platform-default drift.
  try {
    const { data: models = [] } = configCache.getModels?.() || { data: [] };
    const textCapable = models.filter(m => m.enabled !== false && !m.supportsImageGeneration);
    if (textCapable.length === 0) return null;
    const explicitDefault = textCapable.find(m => m.default);
    return (explicitDefault || textCapable[0]).id;
  } catch {
    return null;
  }
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

  // taskTemplate is flat: its keys are spread directly into the materialized
  // task node's `config` by SubWorkflowMaterializer (see
  // server/services/workflow/SubWorkflowMaterializer.js: `...restTemplate`).
  // Nesting these under a `config:` key creates a `config.config` cycle that
  // crashes deepMerge in StartNodeExecutor.
  const taskTemplate = {
    ...basePromptConfig(profile, {
      systemFallbackKey: 'Execute this planned sub-task.',
      fallbackIterations: 10
    }),
    dynamicTasks: { enabled: useDrain, maxDepth }
  };

  // Planner system prompt that explicitly steers away from orchestration
  // steps. Without this the planner happily decomposes the brief into
  // "Read Inbox / Pick Item / Write Artifact / Mark Done" — i.e. it
  // re-plans what the orchestrator already does. We want the planner to
  // plan THE WORK (research, analysis, drafting), not the wiring.
  const plannerSystem =
    'You are a research/work planner. The orchestrator has already handled ' +
    'inbox loading, item selection, artifact persistence, and marking the ' +
    'inbox item done — DO NOT include any of those steps in your plan. ' +
    'Plan the substantive work the agent must do to satisfy the request: ' +
    'gathering information, calling search/tools, analyzing results, ' +
    'synthesizing findings, drafting the deliverable. Each task should be ' +
    'an independently executable step of REAL WORK. Return a structured ' +
    'JSON plan.';

  // Inbox-bound profile (e.g. todo-worker, research-agent): the planner is
  // sandwiched between a "load one item" orchestrator and a "finalize one
  // item" orchestrator. The orchestrators own the inbox lifecycle so the
  // plan tasks (which are stateless) can't re-read or double-mark the
  // inbox — that's exactly the "two items processed" bug otherwise.
  if (profile.inboxId) {
    const sysFallback = { en: 'You are an autonomous agent processing inbox items.' };
    const profileSystem =
      profile.system && Object.keys(profile.system).length > 0 ? profile.system : sysFallback;
    return {
      nodes: [
        { id: 'start', type: 'start' },
        {
          id: 'load-inbox',
          type: 'prompt',
          config: {
            modelId: pickModel(profile),
            ...(profile.preferredTemperature !== undefined
              ? { temperature: profile.preferredTemperature }
              : {}),
            system: profileSystem,
            prompt:
              'Call read_inbox to load all open items, pick the single highest-priority open ' +
              'item, then respond with a JSON object describing it:\n\n' +
              '```json\n{ "id": "<line-id-or-index>", "text": "<full item text>", "priority": "p1|p2|p3" }\n```\n\n' +
              'Do not do any other work. Do not write artifacts. Do not mark anything done. ' +
              'Just identify the next item the planner should work on.',
            maxIterations: 5,
            // Tools auto-registered for this orchestrator node include
            // read_inbox / write_inbox because it is NOT a planner task.
            tools: [],
            outputVariable: 'currentInboxItem'
          }
        },
        {
          id: 'planner',
          type: 'planner',
          config: {
            modelId: pickModel(profile),
            // Override the default planner system to steer away from
            // orchestration decomposition.
            system: plannerSystem,
            // Goal frames the planner's job as planning the WORK to solve
            // the request. Orchestration is already handled outside the
            // planner sub-DAG.
            goal:
              'Plan the substantive work required to fulfill this request. ' +
              'DO NOT include steps for reading the inbox, marking items done, ' +
              'or writing artifacts — those happen outside this plan.\n\n' +
              '## Request\n${$.data.currentInboxItem}\n\n' +
              '## Original brief (context)\n${$.data.brief}',
            maxTasks: profile.planner?.maxTasks ?? 10,
            taskTemplate,
            ...(useDrain ? { dynamicTasks: { enabled: true, maxDepth } } : {})
          }
        },
        {
          id: 'finalize',
          type: 'prompt',
          config: {
            modelId: pickModel(profile),
            ...(profile.preferredTemperature !== undefined
              ? { temperature: profile.preferredTemperature }
              : {}),
            system: profileSystem,
            prompt:
              'The planner has finished. Wrap up by making exactly two tool calls in this order:\n\n' +
              '**Step 1 — Persist the deliverable.**\n' +
              'Call `write_artifact` with EXACTLY these argument shapes:\n' +
              '- `name`: a simple filename string (no slashes), e.g. `"report.md"`\n' +
              '- `content`: a string containing the full report in markdown — aggregate the sub-task\n' +
              '  results below into a coherent document. If the data is structured, format it as\n' +
              '  markdown sections; do NOT pass an object/array here.\n' +
              '- `contentType` (optional): `"text/markdown"`\n\n' +
              'Example: `write_artifact(name="report.md", content="# Report\\n\\n...")`\n\n' +
              '**Step 2 — Mark the inbox item done.**\n' +
              'Call `write_inbox` with EXACTLY these arguments:\n' +
              '- `mode`: `"markDone"`\n' +
              '- `item`: the exact text of the inbox item being processed (substring match against\n' +
              '  the inbox line is enough — copy from `currentInboxItem` below)\n' +
              '- `note` (optional): a one-line completion summary\n\n' +
              'Do not call any other tools. Do not retry on success.\n\n' +
              '## Inbox item being processed\n' +
              '{{currentInboxItem}}\n\n' +
              '## Sub-task results (use this content for the artifact)\n' +
              '{{nodeResults}}',
            maxIterations: 5,
            tools: [],
            outputVariable: 'finalSummary'
          }
        },
        { id: 'end', type: 'end' }
      ],
      edges: [
        { from: 'start', to: 'load-inbox' },
        { from: 'load-inbox', to: 'planner' },
        { from: 'planner', to: 'finalize' },
        { from: 'finalize', to: 'end' }
      ]
    };
  }

  // Non-inbox planner (e.g. research-and-summarize): simpler shape.
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'planner',
        type: 'planner',
        config: {
          modelId: pickModel(profile),
          system: plannerSystem,
          goal: '${$.data.brief}',
          maxTasks: profile.planner?.maxTasks ?? 10,
          taskTemplate,
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
      // If taskTemplate was saved in the broken `{ type, config: {...} }`
      // shape, flatten it. The materializer expects taskTemplate keys to be
      // spread directly into the task node config.
      let taskTemplate = cfg.taskTemplate;
      if (
        taskTemplate &&
        typeof taskTemplate === 'object' &&
        taskTemplate.config &&
        typeof taskTemplate.config === 'object'
      ) {
        const { type: _t, config: inner, ...rest } = taskTemplate;
        taskTemplate = { ...rest, ...inner };
      }
      // Propagate Profile-level fields into the taskTemplate so each
      // materialized task node inherits the agent's brief / model / tools /
      // apps / sources without the operator having to edit each task.
      if (taskTemplate) {
        const tt = { ...taskTemplate };
        if (sys && !tt.system) tt.system = sys;
        if (model && !tt.modelId) tt.modelId = model;
        if (typeof temp === 'number' && tt.temperature === undefined) tt.temperature = temp;
        if (tools && (!Array.isArray(tt.tools) || tt.tools.length === 0)) tt.tools = tools;
        if (apps && (!Array.isArray(tt.apps) || tt.apps.length === 0)) tt.apps = apps;
        if (sources && (!Array.isArray(tt.sources) || tt.sources.length === 0))
          tt.sources = sources;
        taskTemplate = tt;
      }
      const merged = {
        ...cfg,
        ...(!cfg.goal ? { goal: '${$.data.brief}' } : {}),
        ...(model && !cfg.modelId ? { modelId: model } : {}),
        ...(taskTemplate ? { taskTemplate } : {})
      };
      return { ...node, config: merged };
    }
    return node;
  });
}

export default { serializeProfile, buildDefaultWorkflowForProfile };
