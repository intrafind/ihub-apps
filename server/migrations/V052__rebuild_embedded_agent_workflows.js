/**
 * Migration V052 — Rebuild embedded agent workflow definitions
 *
 * The agent workflow shape changed in two ways that on-disk profiles need to
 * catch up with:
 *
 *  1. Memory writes are now produced by an explicit `memory-compose` LLM node
 *     between `synthesize` and `memory-finalize`. Older embedded definitions
 *     wired `synthesize → memory-finalize` directly and relied on a legacy
 *     `memoryDelta` field in the synthesizer's outputSchema, which the new
 *     deterministic `memory-finalize` executor does not read. The end result
 *     is that memory never gets written.
 *
 *  2. Some hand-authored planner.system overrides still contain a legacy
 *     instruction telling the planner to "add another planner task to review
 *     what has been done". The dedicated `reviewer` node + review-loop now
 *     own that responsibility; the extra planner task just produces a
 *     duplicate full-report blob.
 *
 * This migration:
 *   - Strips the legacy "add another planner task ... review" sentence from
 *     each profile's `planner.system` (string or localized object).
 *   - Snapshots the prior `workflow.definition` (if any) into
 *     `workflow._preMigrationV052Backup` BEFORE regenerating, so operators
 *     who had inline customizations (extra nodes, custom timeouts, hand-
 *     authored edges) can recover them.
 *   - Rebuilds the embedded workflow definition from scratch — picking up
 *     `memory-compose` and dropping any hand-authored legacy nodes/outputSchemas.
 *   - Logs a structured node-id diff per profile so on-disk changes are
 *     visible in the migration log.
 *   - Leaves profiles with `workflow.ref === 'external'` untouched.
 *
 * Idempotent: re-running finds the backup already present and the new
 * definition matches what rebuildEmbeddedWorkflow would emit again, producing
 * no further changes.
 *
 * ─── Self-contained snapshot ────────────────────────────────────────────────
 * All workflow-building helpers below are a frozen snapshot of
 * profileWorkflowSerializer.js as it existed when V052 was written.
 * Do NOT replace them with an import — migrations must be self-contained so
 * that future changes to the serialiser do not alter what this migration does
 * on a fresh install. See server/migrations/README.md for the full rule.
 *
 * Differences from the live serialiser:
 *   - pickModel() returns profile.preferredModel || null (configCache is not
 *     available at migration time — it is initialised after migrations run).
 *   - The logger.info() call inside serializeProfile() is omitted (no logger
 *     dependency is needed here).
 * ────────────────────────────────────────────────────────────────────────────
 */

export const version = '052';
export const description = 'rebuild_embedded_agent_workflows';

// ─── Snapshot of profileWorkflowSerializer.js (as of V052) ──────────────────
// Captured: 2026-07-06
// All helpers below are copied verbatim from the live serialiser at the time
// this migration was written. They must NOT be replaced with an import so that
// future changes to the serialiser do not alter what this migration produces on
// a fresh install. See server/migrations/README.md.
//
// Simplifications vs. the live copy:
//   • pickModel() — configCache is unavailable at migration time (it is
//     initialised after migrations run), so we return profile.preferredModel
//     or null rather than looking up the default from the model list.
//   • logger.info() call removed from rebuildEmbeddedWorkflow() — no logger
//     dependency is needed in a migration.

const DEFAULT_PLANNER_SYSTEM =
  'You are a planner. Given a brief, decompose it into independently-' +
  'executable research or work tasks. Return a structured JSON plan.\n\n' +
  'DECOMPOSITION QUALITY BAR:\n' +
  '- ONE ANGLE PER TASK. A task addresses ONE question, ONE dimension, ONE ' +
  'deliverable. When the brief explicitly lists multiple angles for the ' +
  'SAME subject (e.g. "find out who X is, what they have written, their ' +
  'views on Y, and collect quotes"), emit a SEPARATE task per angle:\n' +
  '    * background / biography\n' +
  '    * publications & body of work\n' +
  '    * stated views / positions / criticisms\n' +
  '    * direct quotes & evidence extraction\n' +
  '  …not one "research everything about X" task. A task worker has ' +
  'multiple tool calls available, but ONE focused task with 3–5 searches ' +
  'on a single angle produces deeper, better-cited output than one broad ' +
  'task that has to context-switch across 4 angles in 25 tool calls.\n' +
  '- ONE ENTITY PER TASK. When the brief lists multiple distinct subjects ' +
  '(several people, several products, several companies, several documents), ' +
  'emit a separate task for EACH ONE. "Research A and B" is two tasks, never ' +
  'one. "Research products X, Y, Z" is three tasks, never one. Combining ' +
  'entities forces the worker to context-switch mid-task and dilutes the ' +
  'output. The only exception is when entities are intrinsically paired ' +
  '(e.g. compare X to Y) and the comparison itself is the deliverable — ' +
  'and that case STILL benefits from per-entity research tasks feeding a ' +
  'separate comparison task via `dependsOn`.\n' +
  '- DECOMPOSITION TEST. Before emitting a task, read its own title and ' +
  'description back: if you find the word "and" joining two research ' +
  'subjects, or a comma-separated list of distinct angles/entities, the ' +
  'task is too broad — split it. Examples of tasks that MUST be split:\n' +
  "    × \"Research Rowan Curran's background, publications, AI views, and quotes\" (4 angles → 4 tasks)\n" +
  '    × "Research Franz and Daniel" (2 people → 2 tasks)\n' +
  '    × "Research iFinder, iAssistant and iHub" (3 products → 3 tasks)\n' +
  '- Prefer 3–8 narrowly-scoped tasks over 1–2 broad ones. Each task ' +
  'should have a clear, falsifiable deliverable.\n' +
  '- Later tasks may build on earlier ones — sequence accordingly. Use the ' +
  '`dependsOn` array when a task genuinely requires another to complete ' +
  'first (e.g. "extract quotes from publications" dependsOn "find ' +
  'publications").\n' +
  '- DO NOT include workflow plumbing steps (reading the inbox, marking ' +
  'items done, writing artifacts); those are handled outside the plan by ' +
  'the runtime.\n' +
  '- DO NOT emit a "write the final report", "compile/assemble the report", ' +
  '"final synthesis", or "assessment write-up" task. Final composition of ' +
  'the report is owned by a separate synthesis step that runs after your ' +
  'plan. Your tasks produce RESEARCH, VERIFICATION, and ANALYSIS findings ' +
  'only — never the final deliverable document itself.';

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
    '3. CITATIONS — YOU assign the numbering. The citations pool you receive ' +
    'is an UNNUMBERED list of URLs. When a URL supports a claim, cite it ' +
    'inline as [N], numbering sources in order of FIRST appearance in your ' +
    'report and CONTIGUOUSLY from 1: the first source you cite is [1], the ' +
    'next NEW source is [2], and so on. Reuse the SAME [N] every later time ' +
    'you cite that same source. Do NOT invent gaps or jump to large numbers. ' +
    'If a fact appears in a sub-task result but no pool URL supports it, the ' +
    'fact is still GROUNDED — keep it without a bracket; do not mark it ' +
    '"[unverified]". Use "[unverified]" ONLY for facts you yourself added ' +
    'that were not in the sub-tasks (which should be never). ATTRIBUTION ' +
    'ACCURACY: every inline [N] must reflect what THAT source actually states ' +
    '— never attribute a figure, quote, percentage, or claim to a source that ' +
    'does not contain it.\n' +
    '4. Aim for thorough coverage. The report should be at least as ' +
    'information-dense as the sub-task results combined: timeline, roles, ' +
    'companies, projects, publications, open-source contributions, ' +
    'speaking engagements, philosophy — whatever the sub-tasks gathered.\n' +
    '5. QUOTE INTEGRITY: never alter, paraphrase, complete, "tidy up", or ' +
    'fabricate text inside quotation marks. Reproduce a quote EXACTLY as it ' +
    'appears in the sub-task results, character for character. If you do not ' +
    'have the exact wording, paraphrase WITHOUT quotation marks (e.g. "he ' +
    'argues that…") — never present invented or edited wording as a verbatim ' +
    'quote, even to make it fit the narrative.\n' +
    '6. DATE & IDENTIFIER INTEGRITY: never invent, guess, or extrapolate ' +
    'dates, publication years, document IDs, author lists, or version ' +
    'numbers. Use only values explicitly present in the sub-task results. ' +
    'Never state a publication date in the future relative to today. If a ' +
    'date or identifier is missing, ambiguous, or conflicting across sources, ' +
    'say so explicitly (e.g. "date not stated in the sources") rather than ' +
    'supplying one.\n' +
    '7. SUMMARY/BODY CONSISTENCY: the Summary (and any overview) must NOT make ' +
    'a claim stronger than the body and its sources support. If the body says ' +
    '"41% chance of light rain", the summary must not say "high probability of ' +
    'thundery showers". Every figure, probability, attribution, and qualifier ' +
    'in the summary must match the detailed findings — never round up, ' +
    'escalate, or restate a claim more confidently than the evidence allows.\n' +
    '8. End with a "## References" section that lists EXACTLY the sources you ' +
    'cited, in numerical order, one per line as "[N] URL". Every [N] you used ' +
    'inline MUST appear here exactly once, and every entry here MUST be cited ' +
    'at least once inline — numbering contiguous from [1], no gaps, no extras.\n' +
    '9. Do not call tools. Just write the report.\n\n' +
    'Note: the citations ledger is the run-time record of URLs the agent ' +
    'visited; it is NOT the same as the configured knowledge-base sources ' +
    'in the profile. Cite what the agent actually consulted, not what it ' +
    'could have consulted.'
};

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
    "fact, which URL backs it. Example: \"Found via app__intrafind-websites: " +
    "X is Y's lead engineer (source: https://...)\".\n" +
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
    '## Current item being processed (if any)\n${$.data.currentInboxItem.text}\n\n' +
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
    '## Citations pool (UNNUMBERED URLs the agent consulted — assign your OWN ' +
    'contiguous [N] for the ones you cite)\n' +
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
    '[N] when a pool URL supports a claim, assigning your own contiguous ' +
    'numbering (see the citation rule). Facts that the sub-tasks grounded ' +
    'inline are still grounded even if no pool URL matches — keep them; do ' +
    'not mark them "[unverified]".\n' +
    '- **Limitations** — what the sub-tasks themselves flagged as ' +
    'uncertain or could not verify. Be specific.\n' +
    '- **References** — list EXACTLY the sources you cited, one per line as ' +
    '"[N] URL", numbered contiguously from [1] to match your inline ' +
    'citations. No gaps, no uncited extras.'
};

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
    '{{#if _reviewOutput}}## Prior reviewer rationale\n${$.data._reviewOutput.rationale}\n\n{{/if}}' +
    'Judge whether the agent should run another planning round. Return the ' +
    'JSON shape specified in the system prompt.'
};

// Simplified for migration: returns preferredModel or null.
// configCache is unavailable at migration time — it initialises after
// migrations run. Nodes that omit a modelId fall back to the server's
// runtime default when the workflow actually executes.
function _v052_pickModel(profile) {
  return profile.preferredModel || null;
}

function _v052_pickIterations(profile, fallback) {
  if (typeof profile.maxIterations === 'number') return profile.maxIterations;
  return fallback;
}

function _v052_isLocalizedNonEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(v => typeof v === 'string' && v.trim().length > 0);
}

function _v052_localizedToString(value, fallback) {
  if (typeof value === 'string') return value.trim() || fallback;
  if (_v052_isLocalizedNonEmpty(value)) {
    const en = value.en && value.en.trim();
    if (en) return en;
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return fallback;
}

function _v052_basePromptConfig(profile, { systemFallbackKey, fallbackIterations }) {
  return {
    modelId: _v052_pickModel(profile),
    ...(profile.preferredTemperature !== undefined
      ? { temperature: profile.preferredTemperature }
      : {}),
    system: _v052_isLocalizedNonEmpty(profile.system)
      ? profile.system
      : profile.description || { en: systemFallbackKey },
    maxIterations: _v052_pickIterations(profile, fallbackIterations),
    tools: Array.isArray(profile.tools) ? profile.tools.slice() : [],
    apps: Array.isArray(profile.apps) ? profile.apps.slice() : [],
    sources: Array.isArray(profile.sources) ? profile.sources.slice() : [],
    skills: Array.isArray(profile.skills) ? profile.skills.slice() : []
  };
}

function _v052_buildSimpleWorkflow(profile) {
  return {
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'agent',
        type: 'prompt',
        config: {
          ..._v052_basePromptConfig(profile, {
            systemFallbackKey: 'You are a helpful agent.',
            fallbackIterations: 10
          }),
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

function _v052_buildDrainOnlyWorkflow(profile) {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const taskRunnerNode = {
    id: 'task_runner',
    type: 'prompt',
    config: {
      ..._v052_basePromptConfig(profile, {
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
          ..._v052_basePromptConfig(profile, {
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

function _v052_buildSynthesizerNode(profile) {
  return {
    id: 'synthesize',
    type: 'prompt',
    config: {
      modelId: profile.synthesizer?.modelId || _v052_pickModel(profile),
      ...(profile.preferredTemperature !== undefined
        ? { temperature: profile.preferredTemperature }
        : {}),
      system: _v052_isLocalizedNonEmpty(profile.synthesizer?.system)
        ? profile.synthesizer.system
        : DEFAULT_SYNTHESIZER_SYSTEM,
      prompt: _v052_isLocalizedNonEmpty(profile.synthesizer?.prompt)
        ? profile.synthesizer.prompt
        : DEFAULT_SYNTHESIZER_PROMPT,
      tools: [],
      maxIterations: 1,
      maxTokens:
        typeof profile.synthesizer?.maxTokens === 'number' && profile.synthesizer.maxTokens > 0
          ? profile.synthesizer.maxTokens
          : 8000,
      _isSynthesizer: true,
      outputVariable: '_synthesizerOutput'
    }
  };
}

function _v052_buildMemoryComposerNode(profile) {
  return {
    id: 'memory-compose',
    type: 'prompt',
    config: {
      modelId: profile.memory?.modelId || _v052_pickModel(profile),
      temperature:
        typeof profile.memory?.temperature === 'number' ? profile.memory.temperature : 0.2,
      system: _v052_isLocalizedNonEmpty(profile.memory?.system)
        ? profile.memory.system
        : DEFAULT_MEMORY_COMPOSER_SYSTEM,
      prompt: _v052_isLocalizedNonEmpty(profile.memory?.prompt)
        ? profile.memory.prompt
        : DEFAULT_MEMORY_COMPOSER_PROMPT,
      tools: [],
      maxIterations: 1,
      maxTokens: 2000,
      outputVariable: '_memoryDelta',
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

function _v052_buildReviewerNode(profile) {
  return {
    id: 'reviewer',
    type: 'prompt',
    config: {
      modelId: profile.review?.modelId || _v052_pickModel(profile),
      ...(profile.preferredTemperature !== undefined
        ? { temperature: profile.preferredTemperature }
        : {}),
      system: _v052_isLocalizedNonEmpty(profile.review?.system)
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
      _isReviewer: true
    }
  };
}

function _v052_plannerNodeTimeoutMs(profile) {
  const wallSec = Number(profile?.budgets?.maxWallTimeSec);
  if (Number.isFinite(wallSec) && wallSec > 30) {
    return Math.max(60_000, (wallSec - 5) * 1000);
  }
  return 30 * 60 * 1000; // 30 minutes
}

function _v052_buildPlannerNode(profile, { hasInbox }) {
  const maxDepth = profile.dynamicTasks?.maxDepth ?? 3;
  const useDrain = profile.dynamicTasks?.enabled !== false;

  const taskTemplate = {
    ..._v052_basePromptConfig(profile, {
      systemFallbackKey: 'Execute this planned sub-task as the agent persona.',
      fallbackIterations: 10
    }),
    dynamicTasks: { enabled: useDrain, maxDepth }
  };

  const plannerSystem = _v052_localizedToString(profile.planner?.system, DEFAULT_PLANNER_SYSTEM);
  const plannerGoal = _v052_localizedToString(
    profile.planner?.goal,
    hasInbox ? DEFAULT_PLANNER_GOAL : DEFAULT_PLANNER_GOAL_NO_INBOX
  );

  return {
    id: 'planner',
    type: 'planner',
    execution: { timeout: _v052_plannerNodeTimeoutMs(profile) },
    config: {
      modelId: profile.planner?.modelId || _v052_pickModel(profile),
      system: plannerSystem,
      goal: plannerGoal,
      maxTasks: profile.planner?.maxTasks ?? 10,
      taskTemplate,
      ...(useDrain ? { dynamicTasks: { enabled: true, maxDepth } } : {})
    }
  };
}

function _v052_buildPlannerWorkflow(profile) {
  const useSynth = profile.synthesizer?.enabled !== false;
  const hasInbox = typeof profile.inboxId === 'string' && profile.inboxId.length > 0;
  const memoryEnabled = profile.memory?.enabled !== false;
  const useReview = profile.review?.enabled === true;
  const maxRounds = profile.review?.maxRounds ?? 3;

  const nodes = [{ id: 'start', type: 'start' }];
  const edges = [];

  const reviewLoopId = 'review-loop';
  const plannerEntryId = useReview ? reviewLoopId : 'planner';

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

  const plannerNode = _v052_buildPlannerNode(profile, { hasInbox });

  if (useReview) {
    const reviewerNode = _v052_buildReviewerNode(profile);
    const condition =
      '(data._reviewRound === undefined) || (data._reviewOutput && ' +
      'data._reviewOutput.needs_more_work === true && ' +
      `data._reviewRound < ${maxRounds})`;
    const REVIEWER_BUDGET_PER_ROUND_MS = 120_000;
    const perRoundTimeoutMs =
      _v052_plannerNodeTimeoutMs(profile) + REVIEWER_BUDGET_PER_ROUND_MS;
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

  let lastWorkflowNodeId = useReview ? reviewLoopId : 'planner';
  if (useSynth) {
    nodes.push(_v052_buildSynthesizerNode(profile));
    edges.push({ source: lastWorkflowNodeId, target: 'synthesize' });
    lastWorkflowNodeId = 'synthesize';
  }
  if (memoryEnabled) {
    nodes.push(_v052_buildMemoryComposerNode(profile));
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

function _v052_buildInboxWorkerWorkflow(profile) {
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
        ..._v052_basePromptConfig(profile, {
          systemFallbackKey: 'You are an autonomous agent processing inbox items.',
          fallbackIterations: 10
        }),
        ...(useDynamic ? { apps: [] } : {}),
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
        ...(useDynamic ? { dynamicTasks: { enabled: true, maxDepth } } : {}),
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
    const taskRunnerConfig = {
      ..._v052_basePromptConfig(profile, {
        systemFallbackKey: 'Process the current task.',
        fallbackIterations: 10
      }),
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
    nodes.push(_v052_buildSynthesizerNode(profile));
    edges.push({ source: lastId, target: 'synthesize' });
    lastId = 'synthesize';
  }
  if (profile.memory?.enabled !== false) {
    nodes.push(_v052_buildMemoryComposerNode(profile));
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

function _v052_buildDefaultWorkflowForProfile(profile) {
  if (profile.planner?.enabled) return _v052_buildPlannerWorkflow(profile);
  if (profile.inboxId) return _v052_buildInboxWorkerWorkflow(profile);
  if (profile.dynamicTasks?.enabled) return _v052_buildDrainOnlyWorkflow(profile);
  return _v052_buildSimpleWorkflow(profile);
}

/**
 * Rebuild the embedded workflow definition for a profile.
 * Returns a new profile object (does not mutate).
 * Profiles with workflow.ref === 'external' are returned unchanged.
 */
function rebuildEmbeddedWorkflow(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('rebuildEmbeddedWorkflow requires a profile object');
  }
  const next = JSON.parse(JSON.stringify(profile));
  if (!next.workflow) next.workflow = { ref: 'embedded' };
  if (next.workflow.ref === 'external') return next;
  next.workflow.ref = 'embedded';
  next.workflow.definition = _v052_buildDefaultWorkflowForProfile(next);
  return next;
}

// ─── End of snapshot ─────────────────────────────────────────────────────────

// Sentences telling the planner to add an extra review task. Conservative —
// must mention "another planner task" (the specific legacy phrasing) so we
// don't accidentally strip legitimate review/QA instructions.
const LEGACY_REVIEW_INSTRUCTION =
  /\s*At the end of all tasks[^.]*another planner task[^.]*\.(\s*[^.\n]*\.)?/gi;

function stripLegacyReviewSentence(value) {
  if (typeof value !== 'string') return { value, changed: false };
  const next = value
    .replace(LEGACY_REVIEW_INSTRUCTION, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return { value: next, changed: next !== value };
}

function stripLegacyReviewFromLocalized(localized) {
  if (!localized || typeof localized !== 'object') {
    return { value: localized, changed: false };
  }
  let changed = false;
  const next = {};
  for (const [locale, text] of Object.entries(localized)) {
    const r = stripLegacyReviewSentence(text);
    next[locale] = r.value;
    if (r.changed) changed = true;
  }
  return { value: next, changed };
}

export async function precondition(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  let rebuilt = 0;
  let plannerStripped = 0;
  let skippedExternal = 0;
  let failed = 0;

  for (const file of files) {
    const path = `agents/profiles/${file}`;
    let profile;
    try {
      profile = await ctx.readJson(path);
    } catch (err) {
      ctx.warn(`Could not parse ${path}: ${err.message} — skipping`);
      failed++;
      continue;
    }
    if (!profile || typeof profile !== 'object' || !profile.id) {
      ctx.warn(`Skipping ${path} — missing or invalid profile shape`);
      continue;
    }

    let touched = false;

    // 1. Strip legacy "add another planner task" instruction from planner.system.
    if (profile.planner && profile.planner.system) {
      const sys = profile.planner.system;
      if (typeof sys === 'string') {
        const r = stripLegacyReviewSentence(sys);
        if (r.changed) {
          profile.planner.system = r.value;
          plannerStripped++;
          touched = true;
        }
      } else if (typeof sys === 'object') {
        const r = stripLegacyReviewFromLocalized(sys);
        if (r.changed) {
          profile.planner.system = r.value;
          plannerStripped++;
          touched = true;
        }
      }
    }

    // 2. Rebuild the embedded workflow definition (unless external).
    if (profile.workflow?.ref === 'external') {
      skippedExternal++;
    } else {
      try {
        // Snapshot the prior definition into a recovery slot before we
        // clobber it. Skip the backup if one is already present (idempotent
        // re-runs) or if the profile has no prior definition to lose.
        const priorDef = profile.workflow?.definition;
        const alreadyBackedUp = !!profile.workflow?._preMigrationV052Backup;
        if (priorDef && !alreadyBackedUp) {
          if (!profile.workflow) profile.workflow = { ref: 'embedded' };
          profile.workflow._preMigrationV052Backup = {
            snapshotAt: new Date().toISOString(),
            definition: priorDef
          };
          touched = true;
        }
        const beforeNodeIds = Array.isArray(priorDef?.nodes)
          ? priorDef.nodes.map(n => n?.id).filter(id => typeof id === 'string')
          : [];

        const rebuiltProfile = rebuildEmbeddedWorkflow(profile);
        profile = rebuiltProfile;
        rebuilt++;
        touched = true;

        // Log a structured diff so operators can see at a glance what
        // changed on disk. Quiet when the node-id sets match exactly.
        const afterNodeIds = Array.isArray(profile.workflow?.definition?.nodes)
          ? profile.workflow.definition.nodes.map(n => n?.id).filter(id => typeof id === 'string')
          : [];
        const added = afterNodeIds.filter(id => !beforeNodeIds.includes(id));
        const removed = beforeNodeIds.filter(id => !afterNodeIds.includes(id));
        if (added.length || removed.length) {
          ctx.log(
            `Workflow nodes for ${profile.id} — added:[${added.join(',') || '—'}] removed:[${removed.join(',') || '—'}]`
          );
        }
      } catch (err) {
        ctx.warn(`rebuildEmbeddedWorkflow failed for ${profile.id}: ${err.message} — leaving as-is`);
        failed++;
      }
    }

    if (touched) {
      await ctx.writeJson(path, profile);
      ctx.log(`Rebuilt ${profile.id}`);
    }
  }

  ctx.log(
    `Processed ${files.length} profile(s) — rebuilt=${rebuilt}, plannerStripped=${plannerStripped}, externalSkipped=${skippedExternal}, failed=${failed}`
  );
}
