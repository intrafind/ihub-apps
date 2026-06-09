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
  'executable research or work tasks. Return a structured JSON plan.\n\n' +
  'DECOMPOSITION QUALITY BAR:\n' +
  '- Each task does ONE substantive piece of work — gathering information ' +
  'about ONE angle, analyzing ONE dimension, drafting ONE section. Avoid ' +
  '"research everything" tasks; instead split into multiple angle-specific ' +
  'tasks (e.g. "professional history", "publications", "open-source ' +
  'contributions", "public speaking", "current role detail").\n' +
  '- Prefer 3–6 narrowly-scoped tasks over 1–2 broad ones. Each task should ' +
  'have a clear, falsifiable deliverable.\n' +
  '- Later tasks may build on earlier ones — sequence accordingly. Use the ' +
  '`dependsOn` array when a task genuinely requires another to complete first.\n' +
  '- DO NOT include workflow plumbing steps (reading the inbox, marking ' +
  'items done, writing artifacts); those are handled outside the plan by ' +
  'the runtime.';

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

// Memory composer is an explicit toolless LLM step that runs AFTER the
// synthesizer. It sees the brief, task results, citations, the tools/apps
// the agent used, and prior memory, and emits an explicit memoryDelta
// which the deterministic memory-finalize node then drains. Splitting
// this from the synthesizer keeps the report writer focused on the
// report, avoids cross-provider schema headaches (Gemini's proto schema
// rejects union types like ["object", "null"]), and gives operators a
// dedicated knob for memory hygiene.
const DEFAULT_MEMORY_COMPOSER_SYSTEM = {
  en:
    'You are a memory composer for an autonomous agent. Your job is to ' +
    'decide what (if anything) from this run is worth committing to the ' +
    "agent's long-term memory file for future runs.\n\n" +
    'You receive:\n' +
    '- The original brief (what was asked).\n' +
    '- The current item being processed (if any).\n' +
    '- Every planned sub-task and its result.\n' +
    '- The citations ledger — every URL the agent actually consulted.\n' +
    '- A list of tools / apps the agent used (so you can describe HOW ' +
    'a fact was found, not just WHAT was found).\n' +
    '- The current contents of the agent memory file (so you can spot ' +
    'duplicates and decide between append vs. replace).\n\n' +
    'Return STRICT JSON with these fields:\n' +
    '  - "skip" (boolean): true when nothing from this run is worth ' +
    'committing to memory. The other fields are ignored when skip=true.\n' +
    '  - "mode" ("append"|"replace"): default to "append" — accumulating ' +
    'notes over time is the goal. Only use "replace" when an existing ' +
    'memory section needs to be overwritten because it became wrong.\n' +
    '  - "content" (string): the markdown to add (or replace with). ' +
    'Be CONCRETE — durable facts, names, identifiers, stable preferences, ' +
    'recurring context. Include provenance: which tool/app produced the ' +
    'fact, which URL backs it. Example: "Found via app__intrafind-websites: ' +
    'X is Y\'s lead engineer (source: https://...)".\n' +
    '  - "summary" (string): one short caption for the memory frontmatter.\n\n' +
    'Rules:\n' +
    '1. Only durable signal goes into memory. Skip ephemeral or task-specific ' +
    'detail (e.g. "the user asked about X today" is ephemeral; "the user ' +
    'prefers detailed reports with citations" is durable).\n' +
    '2. Do NOT copy the full report into memory. Memory accumulates; the ' +
    'report is per-run.\n' +
    '3. Cite the tool/source ("found via webSearch", "from app__support-bot") ' +
    'so future runs can trust and trace the fact.\n' +
    '4. If memory already contains the same fact, skip=true. Do not duplicate.\n' +
    '5. When unsure, prefer skip=true over polluting memory with low-value ' +
    'notes — the user can always re-run with more specific input.\n' +
    '6. Do NOT call tools. Just compose and return the JSON.'
};

const DEFAULT_MEMORY_COMPOSER_PROMPT = {
  en:
    '## Original brief\n${$.data.brief}\n\n' +
    '## Current item being processed (if any)\n${$.data.currentInboxItem}\n\n' +
    '## Sub-task results (with the tool / app that produced each)\n{{previousTaskResults}}\n\n' +
    '## Citations ledger (URLs consulted)\n{{citations}}\n\n' +
    '## Current memory file contents (verbatim)\n{{currentMemory}}\n\n' +
    'Decide what (if anything) to commit to memory and return the JSON ' +
    'specified in the system prompt.'
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
        config: {
          ...basePromptConfig(profile, {
            systemFallbackKey: 'You are a helpful agent.',
            fallbackIterations: 10
          }),
          // Simple-agent shape: this one node IS the producer. Persist its
          // output as the run's primary artifact so the UI has something to
          // show after the run completes.
          _persistAsArtifact: true
        }
      },
      { id: 'end', type: 'end' }
    ],
    edges: [
      { source: 'start', target: 'agent' },
      { source: 'agent', target: 'end' }
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
      { source: 'start', target: 'seed' },
      { source: 'seed', target: 'drain' },
      { source: 'drain', target: 'end' }
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

function buildMemoryComposerNode(profile) {
  return {
    id: 'memory-compose',
    type: 'prompt',
    config: {
      modelId: profile.memory?.modelId || pickModel(profile),
      // Memory composition is structured-output and benefits from low
      // temperature — we want consistent, conservative writes.
      temperature:
        typeof profile.memory?.temperature === 'number' ? profile.memory.temperature : 0.2,
      system: isLocalizedNonEmpty(profile.memory?.system)
        ? profile.memory.system
        : DEFAULT_MEMORY_COMPOSER_SYSTEM,
      prompt: isLocalizedNonEmpty(profile.memory?.prompt)
        ? profile.memory.prompt
        : DEFAULT_MEMORY_COMPOSER_PROMPT,
      tools: [],
      maxIterations: 1,
      maxTokens: 2000,
      outputVariable: '_memoryDelta',
      // Flat object schema — no union types so Gemini's proto schema is happy.
      // All fields optional + skip flag lets the composer say "nothing worth
      // remembering" without violating required-field constraints.
      outputSchema: {
        type: 'object',
        properties: {
          skip: { type: 'boolean' },
          mode: { type: 'string', enum: ['append', 'replace'] },
          content: { type: 'string' },
          summary: { type: 'string' }
        }
      },
      _isMemoryComposer: true
    }
  };
}

const DEFAULT_REVIEWER_SYSTEM = {
  en:
    'You are a strict reviewer. Your job is to judge whether the planner-driven ' +
    'agent has gathered ENOUGH evidence and produced ENOUGH analysis to ' +
    'comprehensively answer the original brief.\n\n' +
    'You receive:\n' +
    '- The original brief.\n' +
    '- Every sub-task result accumulated so far (across one or more rounds).\n' +
    '- The citations ledger (URLs the agent actually consulted).\n' +
    '- The current review round number (0 = first review, higher = subsequent).\n' +
    '- The prior reviewer rationale (when this is round 1+).\n\n' +
    'Return STRICT JSON with this shape:\n' +
    '{ "needs_more_work": <boolean>, "rationale": "<one-paragraph explanation>", ' +
    '  "gaps": ["<short gap description>", ...] }\n\n' +
    'Rules:\n' +
    '1. Set needs_more_work=true ONLY if there are MATERIAL gaps the agent ' +
    'must close (missing facts, unverified critical claims, missing angles ' +
    'the brief asked for). Minor polish, stylistic tweaks, or "could be ' +
    'more thorough" are NOT material — return false in those cases.\n' +
    '2. Each gap should be a concrete actionable description ' +
    '("Confirm <X> via independent source", "Research <Y> angle missing ' +
    'from current results"). Avoid vague gaps like "needs more research".\n' +
    '3. Cap gaps at 5 per round. If you would list more, prioritize the ' +
    'most impactful 5.\n' +
    '4. If the brief is well-answered, return needs_more_work=false with ' +
    'gaps=[] and a one-sentence rationale.\n' +
    '5. Do not call tools. Just judge.'
};

const DEFAULT_REVIEWER_PROMPT = {
  en:
    '## Original brief\n${$.data.brief}\n\n' +
    '## Current review round\n${$.data._reviewRound}\n\n' +
    '## Sub-task results so far (across all rounds)\n{{previousTaskResults}}\n\n' +
    '## Citations ledger\n{{citations}}\n\n' +
    '## Prior reviewer rationale (if any)\n${$.data._reviewOutput.rationale}\n\n' +
    'Judge whether the agent should run another planning round. Return the ' +
    'JSON shape specified in the system prompt.'
};

function buildReviewerNode(profile) {
  return {
    id: 'reviewer',
    type: 'prompt',
    config: {
      modelId: profile.review?.modelId || pickModel(profile),
      ...(profile.preferredTemperature !== undefined
        ? { temperature: profile.preferredTemperature }
        : {}),
      system: isLocalizedNonEmpty(profile.review?.system)
        ? profile.review.system
        : DEFAULT_REVIEWER_SYSTEM,
      prompt: DEFAULT_REVIEWER_PROMPT,
      tools: [],
      maxIterations: 1,
      maxTokens: 2000,
      outputVariable: '_reviewOutput',
      outputSchema: {
        type: 'object',
        properties: {
          needs_more_work: { type: 'boolean' },
          rationale: { type: 'string' },
          gaps: { type: 'array', items: { type: 'string' } }
        },
        required: ['needs_more_work', 'rationale']
      },
      // Marker the runtime uses to bump _reviewRound and stash _lastReviewGaps
      // into state.data so the next planner iteration can read them.
      _isReviewer: true
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
  const memoryEnabled = profile.memory?.enabled !== false;
  const useReview = profile.review?.enabled === true;
  const maxRounds = profile.review?.maxRounds ?? 3;

  const nodes = [{ id: 'start', type: 'start' }];
  const edges = [];

  // Plan-and-review loop entry. When review is enabled, the planner runs
  // inside a `while` loop alongside a toolless reviewer that judges
  // sufficiency. On the first iteration `_reviewRound` is undefined → enter.
  // On subsequent iterations enter only if the reviewer flagged gaps AND
  // we haven't spent the round budget. Hard cap on `maxIterations` is
  // `maxRounds + 1` defensively (the LoopNodeExecutor enforces it anyway).
  const reviewLoopId = 'review-loop';
  const plannerEntryId = useReview ? reviewLoopId : 'planner';

  // Entry edges and inbox-load (deterministic).
  if (hasInbox) {
    nodes.push({
      id: 'inbox-load',
      type: 'inbox-load',
      config: { inboxId: profile.inboxId }
    });
    edges.push({ source: 'start', target: 'inbox-load' });
    edges.push({ source: 'inbox-load', target: plannerEntryId });
  } else {
    edges.push({ source: 'start', target: plannerEntryId });
  }

  const plannerNode = buildPlannerNode(profile, { hasInbox });

  if (useReview) {
    // Wrap planner + reviewer in a while-loop. The body is two nodes; the
    // engine's LoopNodeExecutor.executeBodyNodes runs them sequentially per
    // iteration. Reviewer's outputSchema and the round-bumping branch in
    // PromptNodeExecutor._autoPersistResult populate _reviewOutput +
    // _reviewRound. PlannerNodeExecutor reads _reviewRound and
    // _lastReviewGaps to namespace task ids and steer the prompt.
    //
    // CRITICAL: the loop must carry its OWN execution.timeout. The engine
    // wraps every node.execute() in a per-node timeout (default 5min), but
    // LoopNodeExecutor.executeBodyNodes invokes child executors DIRECTLY
    // — bypassing the engine's timeout wrapper for the body nodes. That
    // means the inner planner's own execution.timeout (set by
    // plannerNodeTimeoutMs) is NEVER consulted inside the loop. We have to
    // raise the loop's own timeout instead, otherwise even a long-running
    // planner sub-workflow inside the loop fails the whole loop at 5min.
    //
    // Budget = planner-style timeout × maxRounds (each iteration can take
    // up to one full planner timeout), bounded above by the workflow's
    // wall-time clock which fires first if too generous.
    const reviewerNode = buildReviewerNode(profile);
    const condition =
      '(data._reviewRound === undefined) || (data._reviewOutput && ' +
      'data._reviewOutput.needs_more_work === true && ' +
      `data._reviewRound < ${maxRounds})`;
    const perRoundTimeoutMs = plannerNodeTimeoutMs(profile);
    const loopTimeoutMs = Math.max(perRoundTimeoutMs, perRoundTimeoutMs * maxRounds);
    nodes.push({
      id: reviewLoopId,
      type: 'loop',
      execution: { timeout: loopTimeoutMs },
      config: {
        mode: 'while',
        condition,
        body: [plannerNode, reviewerNode],
        maxIterations: maxRounds + 1
      }
    });
  } else {
    nodes.push(plannerNode);
  }

  // Tail: synthesizer (LLM, no tools) → memory-finalize (deterministic) →
  // inbox-finalize (deterministic, only when inbox-bound).
  let lastWorkflowNodeId = useReview ? reviewLoopId : 'planner';
  if (useSynth) {
    nodes.push(buildSynthesizerNode(profile));
    edges.push({ source: lastWorkflowNodeId, target: 'synthesize' });
    lastWorkflowNodeId = 'synthesize';
  }
  if (memoryEnabled) {
    // memory-compose: explicit LLM step that decides WHAT to remember
    // from this run, given brief + task results + citations + prior memory.
    // Its structured output lands in state.data._memoryDelta and a
    // PromptNodeExecutor branch (config._isMemoryComposer) pushes it onto
    // _pendingMemoryUpdates for the deterministic finalize step to drain.
    nodes.push(buildMemoryComposerNode(profile));
    edges.push({ source: lastWorkflowNodeId, target: 'memory-compose' });
    lastWorkflowNodeId = 'memory-compose';
    nodes.push({
      id: 'memory-finalize',
      type: 'memory-finalize',
      config: {}
    });
    edges.push({ source: lastWorkflowNodeId, target: 'memory-finalize' });
    lastWorkflowNodeId = 'memory-finalize';
  }
  if (hasInbox) {
    nodes.push({
      id: 'inbox-finalize',
      type: 'inbox-finalize',
      config: { inboxId: profile.inboxId }
    });
    edges.push({ source: lastWorkflowNodeId, target: 'inbox-finalize' });
    edges.push({ source: 'inbox-finalize', target: 'end' });
  } else {
    edges.push({ source: lastWorkflowNodeId, target: 'end' });
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
  const useDynamic = profile.dynamicTasks?.enabled === true;
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;

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
      config: {
        ...basePromptConfig(profile, {
          systemFallbackKey: 'You are an autonomous agent processing inbox items.',
          fallbackIterations: 10
        }),
        // When dynamicTasks is enabled the agent's job is decomposition,
        // not direct app calls. Strip apps from THIS node so the LLM can't
        // "helpfully" call them in addition to queueing tasks that also
        // call them. The drain task_runner still has apps registered and
        // executes the queued questions.
        ...(useDynamic ? { apps: [] } : {}),
        // The runtime puts the picked inbox item into state.data.currentInboxItem
        // (see InboxLoadNodeExecutor). Without an explicit prompt template the
        // PromptNodeExecutor would fall through to state.data.brief — which on
        // runs without an operator brief is empty or the system prompt itself,
        // leaving the agent with no actual question to answer.
        prompt: {
          en: useDynamic
            ? [
                'You have been assigned this inbox item to handle:',
                '',
                '{{currentInboxItem}}',
                '',
                'Your role on THIS step is to DECOMPOSE the request into sub-tasks that other workers will execute. The drain loop will then process each queued task with the configured apps / tools.',
                '',
                'Plan and enqueue sub-tasks using `create_task`:',
                '- One task per concrete question to a specific app / source.',
                '- Title each task with the app / source it should consult (e.g. "Ask ihub-support-bot: <question>").',
                '- Keep questions short and self-contained.',
                '- Do NOT call apps yourself on this step — the tasks will. Calling them here and queueing the same call duplicates work and wastes tokens.',
                '',
                'After enqueuing the sub-tasks, write a brief plan summary as your answer. The drain loop will then run each task, and the per-task artifacts will be available to the operator.'
              ].join('\n')
            : [
                'You have been assigned this inbox item to handle:',
                '',
                '{{currentInboxItem}}',
                '',
                'Before drafting an answer, consult the tools available to you in this turn:',
                '- If apps (app__*) are configured, call them with a concrete question — they are the authoritative voice for their domain.',
                '- If sources are configured, they are already injected into the system prompt; quote / cite them directly.',
                '- If web search is available, use it for facts you are not certain of.',
                '',
                'Do NOT answer from your own training memory alone. Cite the tool / app / source you used. If after consulting the available tools you still cannot answer, explicitly say so and point the user at IT support.'
              ].join('\n')
        },
        // When there is no synthesizer, this agent IS the final answer
        // producer for the run. Its output must be persisted as the primary
        // artifact, otherwise the run finishes with a step log but no
        // visible deliverable in the UI. With synthesizer enabled, the
        // synthesizer node owns persistence and this flag stays off so we
        // don't write two competing artifacts.
        // Drain-mode integration: when dynamicTasks is on, the agent's own
        // create_task calls feed _taskQueue, and the drain node below
        // processes them one by one. Without that the agent could call
        // create_task but nothing would execute the result. Pass
        // dynamicTasks on the node config so the registrar attaches
        // create_task / list_tasks here too.
        ...(useDynamic ? { dynamicTasks: { enabled: true, maxDepth } } : {}),
        // The agent is the primary producer for inbox-worker shapes
        // (with or without dynamicTasks). Its answer becomes report.md.
        // Tasks queued via create_task get processed afterwards by the
        // drain loop and produce per-task artifacts, but they don't
        // replace the agent's report. When synthesizer is enabled, the
        // synthesizer owns the primary artifact instead.
        ...(useSynth ? {} : { _persistAsArtifact: true })
      }
    }
  ];
  const edges = [
    { source: 'start', target: 'inbox-load' },
    { source: 'inbox-load', target: 'agent' }
  ];

  let lastId = 'agent';
  if (useDynamic) {
    // Drain loop that runs each dynamically-created task. The body is a
    // single prompt node that processes `state.data._currentTask`. When the
    // synthesizer is OFF, the LAST task_runner output becomes the primary
    // artifact (we tag every iteration, so the latest one wins).
    const taskRunnerConfig = {
      ...basePromptConfig(profile, {
        systemFallbackKey: 'Process the current task.',
        fallbackIterations: 10
      }),
      // Allow operators to pin a different model for dynamic task runners
      // (e.g. cheaper / faster model for the high-volume sub-task path
      // while the orchestrating agent uses a stronger one).
      ...(profile.dynamicTasks?.modelId ? { modelId: profile.dynamicTasks.modelId } : {}),
      prompt: {
        en: [
          'You are processing one dequeued sub-task from the dynamic-task queue.',
          '',
          'Title: {{_currentTask.title}}',
          'Brief: {{_currentTask.brief}}',
          '',
          'If the title or brief mentions an app, source, or tool by name (for example "Ask intrafind-websites-bot ...", "Consult ihub-support-bot ..."), you MUST call that app/tool. Do not paraphrase the question and answer it from memory — call the named tool, wait for its response, and use that response as the basis of your answer.',
          '',
          'Rules for this sub-task:',
          '- Call each named app / tool AT MOST ONCE. If the answer is insufficient, note that in your output — do NOT re-ask the same app with a rephrased question.',
          '- If sources are configured, they are already in the system prompt — quote / cite them directly. Do not invent additional sources.',
          '- If web search is available, use it for facts you are not certain of.',
          '- Do NOT answer from your own training memory alone. Cite the tool / app / source you used.',
          '- Do NOT enqueue further sub-tasks via create_task. This task is one leaf in a plan; just produce its answer.',
          '',
          'When you have gathered the information, produce a focused answer for THIS sub-task only — the orchestrating agent will compose the overall response.'
        ].join('\n')
      },
      dynamicTasks: { enabled: true, maxDepth },
      // Each task this node executes was just dequeued from _taskQueue;
      // tagging it as a planner-task lets _autoPersistResult mark it done
      // in the queue and write a per-task artifact. We do NOT set
      // _persistAsArtifact here — the agent's answer above is the
      // primary artifact; task_runner outputs are saved as per-task
      // markdown files (task_*.md) via the planner-task auto-persist path.
      _isPlannerTask: true
    };
    nodes.push({
      id: 'drain',
      type: 'loop',
      config: {
        mode: 'drain',
        queueKey: '_taskQueue',
        body: [{ id: 'task_runner', type: 'prompt', config: taskRunnerConfig }],
        maxIterations: 50
      }
    });
    edges.push({ source: 'agent', target: 'drain' });
    lastId = 'drain';
  }
  if (useSynth) {
    nodes.push(buildSynthesizerNode(profile));
    edges.push({ source: lastId, target: 'synthesize' });
    lastId = 'synthesize';
  }
  // memory-compose + memory-finalize sit between synthesizer and
  // inbox-finalize so the memory write happens BEFORE the inbox item is
  // marked done — keeps the run's user-visible closure (inbox marked)
  // honest about the side effects (memory updated).
  if (profile.memory?.enabled !== false) {
    nodes.push(buildMemoryComposerNode(profile));
    edges.push({ source: lastId, target: 'memory-compose' });
    lastId = 'memory-compose';
    nodes.push({
      id: 'memory-finalize',
      type: 'memory-finalize',
      config: {}
    });
    edges.push({ source: lastId, target: 'memory-finalize' });
    lastId = 'memory-finalize';
  }
  nodes.push({
    id: 'inbox-finalize',
    type: 'inbox-finalize',
    config: { inboxId: profile.inboxId }
  });
  edges.push({ source: lastId, target: 'inbox-finalize' });
  edges.push({ source: 'inbox-finalize', target: 'end' });

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
 * Take a Profile config and rebuild its embedded workflow definition from
 * scratch. Returns a NEW profile object (does not mutate).
 *
 *  - If profile.workflow.ref === 'external', leave it untouched (caller owns
 *    the workflow shape).
 *  - Otherwise, derive the workflow definition purely from the profile flags
 *    (inboxId, planner.enabled, synthesizer.enabled, dynamicTasks.enabled)
 *    and resource arrays. Any previously cached embedded definition is
 *    discarded — this is what lets toggling planner / synthesizer off
 *    actually remove those nodes from the next run.
 */
export function serializeProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('serializeProfile requires a profile object');
  }
  const next = JSON.parse(JSON.stringify(profile));

  if (!next.workflow) next.workflow = { ref: 'embedded' };
  if (next.workflow.ref === 'external') return next;

  // Embedded workflow definitions are PURELY derived from the profile flags
  // (inboxId, planner.enabled, synthesizer.enabled, dynamicTasks.enabled) and
  // the resource arrays (sources, apps, tools, skills). Always rebuild from
  // scratch so toggling planner or synthesizer off actually removes those
  // nodes — previously the cached definition stuck and only field values
  // got propagated, which left planner/synth nodes in the workflow
  // regardless of the flags. Custom workflows bypass this by setting
  // workflow.ref = 'external'.
  next.workflow.ref = 'embedded';
  next.workflow.definition = buildDefaultWorkflowForProfile(next);
  logger.info('Rebuilt embedded workflow definition for profile', {
    component: 'ProfileWorkflowSerializer',
    profileId: next.id,
    shape: next.planner?.enabled
      ? 'planner' +
        (next.review?.enabled ? '+review-loop' : '') +
        (next.synthesizer?.enabled !== false ? '+synth' : '') +
        (next.memory?.enabled !== false ? '+memory-finalize' : '')
      : next.inboxId
        ? 'inbox-worker' +
          (next.synthesizer?.enabled !== false ? '+synth' : '') +
          (next.memory?.enabled !== false ? '+memory-finalize' : '')
        : next.dynamicTasks?.enabled
          ? 'drain-only'
          : 'simple'
  });

  return next;
}

export default { serializeProfile, buildDefaultWorkflowForProfile };
