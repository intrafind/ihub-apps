/**
 * Profile Workflow Serializer
 *
 * Given an AgentProfile, produces a complete embedded workflow definition the
 * workflow engine can execute. Profile authors may provide their own embedded
 * definition; otherwise this builds a sensible default based on the Profile's
 * planner / dynamicTasks / synthesizer / inbox settings.
 *
 * ── Lifecycle redesign (V047+) ─────────────────────────────────────────────
 *
 * Earlier versions used `prompt`-type nodes for inbox load and finalize that
 * told the LLM to "call read_inbox" and "call write_artifact then call
 * write_inbox(mode='markDone')". This routed deterministic lifecycle work
 * through LLM tool calls — the planner started hallucinating these tools,
 * orchestration prose leaked into task prompts, and every fix added more
 * defensive language to the prompts.
 *
 * The new shape pushes deterministic operations into the runtime via
 * dedicated executor types:
 *
 *   start → inbox-load (det.) → planner → tasks → synthesize → inbox-finalize (det.) → end
 *
 * Variants:
 *
 *   - inbox + planner          : full shape above
 *   - inbox + no planner       : start → inbox-load → main-task → synthesize? → inbox-finalize → end
 *   - no inbox + planner       : start → planner → tasks → synthesize → end
 *   - no inbox + no planner    : start → main-task → end (simple)
 *   - no inbox + dynamicTasks  : drain-only loop (unchanged from V1)
 *
 * Profile authors configure:
 *   profile.system               → Agent persona (used for task execution)
 *   profile.planner.{system,goal,modelId,maxTasks}
 *   profile.synthesizer.{system,prompt,modelId,enabled}
 *   profile.tools/apps/sources   → Research tools for task executors
 */

import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';

const DEFAULT_PLANNER_SYSTEM =
  'You are a planner. Given a brief, decompose it into independently-' +
  'executable research or work tasks. Return a structured JSON plan. Each ' +
  'task should describe ONE substantive piece of work — gathering ' +
  'information, analyzing data, drafting content. Do NOT include workflow ' +
  'plumbing steps (reading the inbox, marking items done, writing ' +
  'artifacts); those are handled outside the plan by the runtime.';

// Use the .text accessor so the planner sees just the user's question, not
// the whole parsed inbox object (which includes .raw — a polluted line that
// accumulates "-- done by ..." notes from prior runs and bleeds them into
// the prompt).
const DEFAULT_PLANNER_GOAL =
  'Plan the work needed to satisfy this request.\n\n' +
  '## Item to process\n${$.data.currentInboxItem.text}\n\n' +
  '## Original brief\n${$.data.brief}';

const DEFAULT_PLANNER_GOAL_NO_INBOX = '${$.data.brief}';

const DEFAULT_SYNTHESIZER_SYSTEM = {
  en:
    'You are a report writer. You receive a brief, the item being processed, ' +
    'the full results of every planned sub-task, and a citations ledger ' +
    'listing every URL the agent actually consulted during research. ' +
    'Produce ONE COMPREHENSIVE markdown report that PRESERVES the detail ' +
    'the sub-tasks gathered.\n\n' +
    'CRITICAL RULES:\n' +
    '1. Treat the sub-task results as your evidence base. Every concrete ' +
    'claim, fact, date, name, role, project, publication, or quote that ' +
    'appears in a sub-task result is grounded and MUST be carried through ' +
    'into the final report — do not silently drop information. The ' +
    'sub-tasks already did the research; your job is to STRUCTURE it, not ' +
    're-judge what counts as a fact.\n' +
    '2. Do NOT add facts that are not present in the sub-task results. Do ' +
    'NOT draw on background knowledge or training data. If two sub-tasks ' +
    'disagree, surface the disagreement explicitly.\n' +
    '3. Cite inline as [N] when a citations-ledger URL supports a claim. ' +
    'If a fact appears in a sub-task result but the ledger has no matching ' +
    'URL, the fact is still GROUNDED — keep it; do not mark it ' +
    '"[unverified]". Use "[unverified]" ONLY for facts you yourself added ' +
    'that were not in the sub-tasks (which should be never).\n' +
    '4. Aim for thorough coverage. The report should be at least as ' +
    'information-dense as the sub-task results combined: timeline, roles, ' +
    'companies, projects, publications, open-source contributions, ' +
    'speaking engagements, philosophy — whatever the sub-tasks gathered.\n' +
    '5. End with a "## References" section listing every cited URL with ' +
    'its index.\n' +
    '6. Do not call tools. Just write the report.\n\n' +
    'Note: the citations ledger is the run-time record of URLs the agent ' +
    'visited; it is NOT the same as the configured knowledge-base sources ' +
    'in the profile. Cite what the agent actually consulted, not what it ' +
    'could have consulted.'
};

const DEFAULT_SYNTHESIZER_PROMPT = {
  en:
    '## Item being processed\n{{currentInboxItem}}\n\n' +
    'The above is THE ONLY topic of this report. Stay strictly on it. Do ' +
    'NOT widen the scope to mention people, projects, or topics that are ' +
    'not the subject of the request — even if they appear in long-term ' +
    'memory or background context.\n\n' +
    '## Original brief (workflow framing — NOT the topic)\n${$.data.brief}\n\n' +
    '## Sub-task results (the EVIDENCE BASE — preserve this content)\n' +
    '{{previousTaskResults}}\n\n' +
    '## Citations ledger (URLs the agent consulted — use for inline [N])\n' +
    '{{citations}}\n\n' +
    'Write a COMPREHENSIVE final markdown report focused on the item ' +
    'above. Carry through the full detail the sub-tasks gathered — every ' +
    'date, role, company, project, publication, quote. Do not silently ' +
    'compress them away. Structure for readability, not brevity.\n\n' +
    '- **Summary** — 3–5 sentence overview with inline [N] citations on ' +
    'the key claims.\n' +
    '- **Findings** — detailed synthesis of the sub-task results, ' +
    'thematically organised. Use sub-sections (career timeline, projects, ' +
    'publications, expertise, etc.) when the material warrants it. Cite ' +
    '[N] when the ledger supports a claim. Facts that the sub-tasks ' +
    'grounded inline are still grounded even if no ledger URL matches — ' +
    'keep them; do not mark them "[unverified]".\n' +
    '- **Limitations** — what the sub-tasks themselves flagged as ' +
    'uncertain or could not verify. Be specific.\n' +
    '- **References** — numbered list matching the inline citations, one ' +
    'URL per entry.'
};

function pickModel(profile) {
  if (profile.preferredModel) return profile.preferredModel;
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

function isLocalizedNonEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(v => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Render a localized field (`{ en: "...", de: "..." }`) to a plain string for
 * runtime config slots that don't localize at execution time (planner.system,
 * planner.goal). Prefers English, falls back to the first non-empty value.
 */
function localizedToString(value, fallback) {
  if (typeof value === 'string') return value.trim() || fallback;
  if (isLocalizedNonEmpty(value)) {
    const en = value.en && value.en.trim();
    if (en) return en;
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return fallback;
}

function basePromptConfig(profile, { systemFallbackKey, fallbackIterations }) {
  return {
    modelId: pickModel(profile),
    ...(profile.preferredTemperature !== undefined
      ? { temperature: profile.preferredTemperature }
      : {}),
    system: isLocalizedNonEmpty(profile.system)
      ? profile.system
      : profile.description || { en: systemFallbackKey },
    maxIterations: pickIterations(profile, fallbackIterations),
    tools: Array.isArray(profile.tools) ? profile.tools.slice() : [],
    apps: Array.isArray(profile.apps) ? profile.apps.slice() : [],
    sources: Array.isArray(profile.sources) ? profile.sources.slice() : [],
    // Skills the agent can activate (instructional knowledge). The
    // PromptNodeExecutor reads this list to inject <available_skills> into
    // the system prompt and auto-attach `activate_skill` to the tool set.
    skills: Array.isArray(profile.skills) ? profile.skills.slice() : []
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
            systemFallbackKey: 'Seed initial tasks from the brief.',
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

function buildSynthesizerNode(profile) {
  return {
    id: 'synthesize',
    type: 'prompt',
    config: {
      modelId: profile.synthesizer?.modelId || pickModel(profile),
      ...(profile.preferredTemperature !== undefined
        ? { temperature: profile.preferredTemperature }
        : {}),
      system: isLocalizedNonEmpty(profile.synthesizer?.system)
        ? profile.synthesizer.system
        : DEFAULT_SYNTHESIZER_SYSTEM,
      prompt: isLocalizedNonEmpty(profile.synthesizer?.prompt)
        ? profile.synthesizer.prompt
        : DEFAULT_SYNTHESIZER_PROMPT,
      tools: [],
      maxIterations: 1,
      // The synthesizer is a one-shot composition over ALL sub-task results
      // + citations. Provider defaults are often 4-8K — too tight for
      // research reports that need to carry through hundreds of facts.
      // Use the profile-configured budget (default 8000) so operators can
      // bump it for very long reports without editing code.
      maxTokens:
        typeof profile.synthesizer?.maxTokens === 'number' && profile.synthesizer.maxTokens > 0
          ? profile.synthesizer.maxTokens
          : 8000,
      _isSynthesizer: true,
      outputVariable: '_synthesizerOutput'
    }
  };
}

function plannerNodeTimeoutMs(profile) {
  // The planner node blocks awaiting the sub-workflow it spawns (which runs
  // every materialized task LLM call serially or in parallel). The engine
  // wraps the whole node.execute() in DEFAULT_NODE_TIMEOUT = 5 min, which
  // is too tight for any non-trivial decomposition: 10 tasks × 20s each =
  // 200s and we've already eaten budget for the planning + finalize hops.
  //
  // Align the per-node timeout with the profile's wall-time budget so the
  // planner waits as long as the operator allowed. We shave 5s off so the
  // workflow-level wall timeout fires first with a cleaner error.
  const wallSec = Number(profile?.budgets?.maxWallTimeSec);
  if (Number.isFinite(wallSec) && wallSec > 30) {
    return Math.max(60_000, (wallSec - 5) * 1000);
  }
  // Generous default for profiles without an explicit budget.
  return 30 * 60 * 1000; // 30 minutes
}

function buildPlannerNode(profile, { hasInbox }) {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const useDrain = profile.dynamicTasks?.enabled !== false;

  // Task template — the agent persona executes each materialized task.
  // No orchestration tools here; the registrar handles auto-attachment.
  const taskTemplate = {
    ...basePromptConfig(profile, {
      systemFallbackKey: 'Execute this planned sub-task as the agent persona.',
      fallbackIterations: 10
    }),
    dynamicTasks: { enabled: useDrain, maxDepth }
  };

  const plannerSystem = localizedToString(profile.planner?.system, DEFAULT_PLANNER_SYSTEM);
  const plannerGoal = localizedToString(
    profile.planner?.goal,
    hasInbox ? DEFAULT_PLANNER_GOAL : DEFAULT_PLANNER_GOAL_NO_INBOX
  );

  return {
    id: 'planner',
    type: 'planner',
    execution: { timeout: plannerNodeTimeoutMs(profile) },
    config: {
      modelId: profile.planner?.modelId || pickModel(profile),
      system: plannerSystem,
      goal: plannerGoal,
      maxTasks: profile.planner?.maxTasks ?? 10,
      taskTemplate,
      ...(useDrain ? { dynamicTasks: { enabled: true, maxDepth } } : {})
    }
  };
}

function buildPlannerWorkflow(profile) {
  const useSynth = profile.synthesizer?.enabled !== false;
  const hasInbox = typeof profile.inboxId === 'string' && profile.inboxId.length > 0;

  const nodes = [{ id: 'start', type: 'start' }];
  const edges = [];

  // Entry edges and inbox-load (deterministic).
  if (hasInbox) {
    nodes.push({
      id: 'inbox-load',
      type: 'inbox-load',
      config: { inboxId: profile.inboxId }
    });
    edges.push({ from: 'start', to: 'inbox-load' });
    edges.push({ from: 'inbox-load', to: 'planner' });
  } else {
    edges.push({ from: 'start', to: 'planner' });
  }

  nodes.push(buildPlannerNode(profile, { hasInbox }));

  // Tail: synthesizer (LLM, no tools) + inbox-finalize (deterministic).
  let lastWorkflowNodeId = 'planner';
  if (useSynth) {
    nodes.push(buildSynthesizerNode(profile));
    edges.push({ from: 'planner', to: 'synthesize' });
    lastWorkflowNodeId = 'synthesize';
  }
  if (hasInbox) {
    nodes.push({
      id: 'inbox-finalize',
      type: 'inbox-finalize',
      config: { inboxId: profile.inboxId }
    });
    edges.push({ from: lastWorkflowNodeId, to: 'inbox-finalize' });
    edges.push({ from: 'inbox-finalize', to: 'end' });
  } else {
    edges.push({ from: lastWorkflowNodeId, to: 'end' });
  }

  nodes.push({ id: 'end', type: 'end' });
  return { nodes, edges };
}

function buildInboxWorkerWorkflow(profile) {
  // Inbox-bound profile without a planner. Wrap the single agent prompt
  // with deterministic load/finalize. Synthesizer is optional here — if the
  // single task's output should be the artifact directly, synthesizer just
  // pipes that through; the runtime persists the synthesizer text either way.
  const useSynth = profile.synthesizer?.enabled !== false;

  const nodes = [
    { id: 'start', type: 'start' },
    {
      id: 'inbox-load',
      type: 'inbox-load',
      config: { inboxId: profile.inboxId }
    },
    {
      id: 'agent',
      type: 'prompt',
      config: basePromptConfig(profile, {
        systemFallbackKey: 'You are an autonomous agent processing inbox items.',
        fallbackIterations: 10
      })
    }
  ];
  const edges = [
    { from: 'start', to: 'inbox-load' },
    { from: 'inbox-load', to: 'agent' }
  ];

  let lastId = 'agent';
  if (useSynth) {
    nodes.push(buildSynthesizerNode(profile));
    edges.push({ from: 'agent', to: 'synthesize' });
    lastId = 'synthesize';
  }
  nodes.push({
    id: 'inbox-finalize',
    type: 'inbox-finalize',
    config: { inboxId: profile.inboxId }
  });
  edges.push({ from: lastId, to: 'inbox-finalize' });
  edges.push({ from: 'inbox-finalize', to: 'end' });

  nodes.push({ id: 'end', type: 'end' });
  return { nodes, edges };
}

/**
 * Pick a sensible default workflow shape for the given Profile.
 */
export function buildDefaultWorkflowForProfile(profile) {
  if (profile.planner?.enabled) return buildPlannerWorkflow(profile);
  if (profile.inboxId) return buildInboxWorkerWorkflow(profile);
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
 *    prompt nodes whose config doesn't already specify them).
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
        ? 'planner+synth'
        : next.inboxId
          ? 'inbox-worker'
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
  const sys = isLocalizedNonEmpty(profile.system) ? profile.system : null;
  const model = profile.preferredModel || null;
  const temp = profile.preferredTemperature;
  const tools = Array.isArray(profile.tools) ? profile.tools : null;
  const apps = Array.isArray(profile.apps) ? profile.apps : null;
  const sources = Array.isArray(profile.sources) ? profile.sources : null;
  const skills = Array.isArray(profile.skills) ? profile.skills : null;

  return nodes.map(node => {
    if (!node) return node;

    if (node.type === 'prompt') {
      const cfg = node.config || {};
      // Synthesizer nodes have their OWN system/prompt — never overwrite
      // with the agent persona; that would re-introduce the orchestration
      // leak. But DO refresh the synthesizer's own system/prompt from the
      // profile (or from the latest in-code defaults if the profile didn't
      // override them). Without this, an embedded workflow.definition
      // freezes the synthesizer prompt at whatever the defaults were when
      // the profile was first serialized — so a default-prompt update
      // (e.g. new citation rules, anti-drift guards) never reaches an
      // existing profile.
      if (cfg._isSynthesizer === true) {
        const synthSystem = isLocalizedNonEmpty(profile.synthesizer?.system)
          ? profile.synthesizer.system
          : DEFAULT_SYNTHESIZER_SYSTEM;
        const synthPrompt = isLocalizedNonEmpty(profile.synthesizer?.prompt)
          ? profile.synthesizer.prompt
          : DEFAULT_SYNTHESIZER_PROMPT;
        const synthModel = profile.synthesizer?.modelId || cfg.modelId;
        return {
          ...node,
          config: {
            ...cfg,
            system: synthSystem,
            prompt: synthPrompt,
            ...(synthModel ? { modelId: synthModel } : {}),
            // Always (re)apply the configured token budget so a previously
            // serialized profile picks up admin updates without needing a
            // workflow.definition wipe.
            maxTokens:
              typeof profile.synthesizer?.maxTokens === 'number' &&
              profile.synthesizer.maxTokens > 0
                ? profile.synthesizer.maxTokens
                : 8000
          }
        };
      }

      const merged = {
        ...cfg,
        ...(sys && !cfg.system ? { system: sys } : {}),
        ...(model && !cfg.modelId ? { modelId: model } : {}),
        ...(typeof temp === 'number' && cfg.temperature === undefined ? { temperature: temp } : {}),
        ...(tools && (!Array.isArray(cfg.tools) || cfg.tools.length === 0) ? { tools } : {}),
        ...(apps && (!Array.isArray(cfg.apps) || cfg.apps.length === 0) ? { apps } : {}),
        ...(sources && (!Array.isArray(cfg.sources) || cfg.sources.length === 0)
          ? { sources }
          : {}),
        ...(skills && (!Array.isArray(cfg.skills) || cfg.skills.length === 0)
          ? { skills }
          : {})
      };
      return { ...node, config: merged };
    }

    if (node.type === 'planner') {
      const cfg = node.config || {};
      // Flatten legacy nested taskTemplate.config shape if still present.
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
      if (taskTemplate) {
        const tt = { ...taskTemplate };
        if (sys && !tt.system) tt.system = sys;
        if (model && !tt.modelId) tt.modelId = model;
        if (typeof temp === 'number' && tt.temperature === undefined) tt.temperature = temp;
        if (tools && (!Array.isArray(tt.tools) || tt.tools.length === 0)) tt.tools = tools;
        if (apps && (!Array.isArray(tt.apps) || tt.apps.length === 0)) tt.apps = apps;
        if (sources && (!Array.isArray(tt.sources) || tt.sources.length === 0))
          tt.sources = sources;
        if (skills && (!Array.isArray(tt.skills) || tt.skills.length === 0)) tt.skills = skills;
        taskTemplate = tt;
      }
      // Planner-specific system/goal come from profile.planner.*, NOT
      // profile.system. Fall back to defaults if missing.
      const hasInboxOnPlannerGoal =
        typeof profile.inboxId === 'string' && profile.inboxId.length > 0;
      const plannerSystem = isLocalizedNonEmpty(profile.planner?.system)
        ? localizedToString(profile.planner.system, DEFAULT_PLANNER_SYSTEM)
        : cfg.system || DEFAULT_PLANNER_SYSTEM;
      const plannerGoal = isLocalizedNonEmpty(profile.planner?.goal)
        ? localizedToString(
            profile.planner.goal,
            hasInboxOnPlannerGoal ? DEFAULT_PLANNER_GOAL : DEFAULT_PLANNER_GOAL_NO_INBOX
          )
        : cfg.goal ||
          (hasInboxOnPlannerGoal ? DEFAULT_PLANNER_GOAL : DEFAULT_PLANNER_GOAL_NO_INBOX);

      const merged = {
        ...cfg,
        system: plannerSystem,
        goal: plannerGoal,
        ...(profile.planner?.modelId
          ? { modelId: profile.planner.modelId }
          : model && !cfg.modelId
            ? { modelId: model }
            : {}),
        ...(taskTemplate ? { taskTemplate } : {})
      };
      // Always (re)apply the planner node timeout. Re-derived from the
      // current profile budget so operators get the new value the next time
      // they save, without having to wipe the embedded definition.
      const execution = { ...(node.execution || {}), timeout: plannerNodeTimeoutMs(profile) };
      return { ...node, execution, config: merged };
    }

    return node;
  });
}

export default { serializeProfile, buildDefaultWorkflowForProfile };
