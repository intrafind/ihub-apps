/**
 * Migration V047 — Split planner/synthesizer config and scrub orchestration prose
 *
 * Earlier profile schemas had a single `system` field that was used both as
 * the agent persona AND as a planner instruction. Profile authors wrote
 * orchestration prose like "On each wake call read_inbox, pick the highest-
 * priority item, do the work, call write_artifact, then write_inbox(mode=
 * markDone)" — which the serializer then propagated into every materialized
 * task. The result: tasks LLMs received orchestration instructions and
 * either hallucinated tool calls or duplicated lifecycle steps.
 *
 * The lifecycle redesign moves deterministic operations (inbox read,
 * inbox-done, artifact persistence, task completion) into the runtime. The
 * LLM now only does substantive work. Configuration is split into three
 * clearly-bounded fields:
 *
 *   profile.system               → Agent persona (used for task execution)
 *   profile.planner.system/goal  → Planner instructions and goal template
 *   profile.synthesizer.{system,prompt} → Final-artifact composition prompts
 *
 * This migration:
 *   1. Seeds `planner.system` / `planner.goal` defaults when planner.enabled
 *      and the fields are missing.
 *   2. Seeds `synthesizer.{system, prompt}` defaults when synthesizer is
 *      effectively enabled (planner.enabled OR inboxId set) and the fields
 *      are missing.
 *   3. Strips orchestration verbs out of `profile.system` (and any embedded
 *      taskTemplate.system) — they cause the very hallucinations this
 *      redesign fixes.
 *   4. Wipes `profile.workflow.definition` for embedded workflows so the
 *      new serializer rebuilds the workflow on next load. (External
 *      workflow refs are untouched — the author owns those.)
 *
 * Idempotent: profiles already in canonical shape are left untouched.
 */

export const version = '047';
export const description = 'split_planner_synthesizer_and_scrub_orchestration';

export async function precondition(ctx) {
  return await ctx.fileExists('agents/profiles');
}

const DEFAULT_PLANNER_SYSTEM = {
  en:
    'You are a planner. Given a brief, decompose it into independently-' +
    'executable research or work tasks. Return a structured JSON plan. Each ' +
    'task should describe ONE substantive piece of work — gathering ' +
    'information, analyzing data, drafting content. Do NOT include workflow ' +
    'plumbing steps (reading the inbox, marking items done, writing ' +
    'artifacts); those are handled outside the plan by the runtime.'
};

const DEFAULT_PLANNER_GOAL = {
  en:
    'Plan the work needed to satisfy this request.\n\n' +
    '## Item to process\n${$.data.currentInboxItem}\n\n' +
    '## Original brief\n${$.data.brief}'
};

const DEFAULT_SYNTHESIZER_SYSTEM = {
  en:
    'You are a synthesizer. You receive a brief, the item being processed, ' +
    'and the results of each planned sub-task. Produce one cohesive ' +
    'markdown deliverable that answers the request using only the ' +
    'information present in the sub-task results. Do not invent facts. Do ' +
    'not call tools — just write the report.'
};

const DEFAULT_SYNTHESIZER_PROMPT = {
  en:
    '## Brief\n${$.data.brief}\n\n' +
    '## Item being processed\n${$.data.currentInboxItem}\n\n' +
    '## Sub-task results\n{{previousTaskResults}}\n\n' +
    'Produce the final markdown report.'
};

// Patterns that indicate the field contains orchestration prose telling the
// LLM to operate the lifecycle. These should be the runtime's job now.
const ORCHESTRATION_PATTERNS = [
  /\b(?:call|use|invoke)\s+`?read_inbox`?[^.]*\.?/gi,
  /\b(?:call|use|invoke)\s+`?write_inbox`?[^.]*\.?/gi,
  /\b(?:call|use|invoke)\s+`?write_artifact`?[^.]*\.?/gi,
  /\b(?:call|use|invoke)\s+`?mark_task_done`?[^.]*\.?/gi,
  /\b(?:then|and)\s+(?:call|use|invoke)\s+`?write_inbox`?[^.]*\.?/gi,
  /\bwrite_inbox\s*\(\s*mode\s*=\s*(['"]?)markDone\1\s*\)[^.]*\.?/gi,
  /\bOn each wake[^.]*\.?/gi,
  /\bpick the highest[- ]priority item[^.]*\.?/gi,
  /\bmark (?:the )?item done[^.]*\.?/gi
];

function scrubOrchestrationFromString(value) {
  if (typeof value !== 'string') return { value, changed: false };
  let next = value;
  let changed = false;
  for (const pat of ORCHESTRATION_PATTERNS) {
    const before = next;
    next = next.replace(pat, '');
    if (next !== before) changed = true;
  }
  // Collapse repeated whitespace introduced by removals.
  const collapsed = next.replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  if (collapsed !== value) changed = true;
  return { value: collapsed, changed };
}

function scrubOrchestrationFromLocalized(value) {
  if (!value || typeof value !== 'object') return { value, changed: false };
  if (Array.isArray(value)) return { value, changed: false };
  let changed = false;
  const next = {};
  for (const [lang, str] of Object.entries(value)) {
    const { value: cleaned, changed: didChange } = scrubOrchestrationFromString(str);
    next[lang] = cleaned;
    if (didChange) changed = true;
  }
  return { value: next, changed };
}

function isLocalizedNonEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(v => typeof v === 'string' && v.trim().length > 0);
}

export async function up(ctx) {
  let files;
  try {
    files = await ctx.listFiles('agents/profiles', '*.json');
  } catch (err) {
    ctx.warn(`Could not list agents/profiles: ${err.message}`);
    return;
  }

  if (!Array.isArray(files) || files.length === 0) {
    ctx.log('No agent profile files to migrate');
    return;
  }

  let migrated = 0;
  for (const file of files) {
    const profilePath = `agents/profiles/${file}`;
    let profile;
    try {
      profile = await ctx.readJson(profilePath);
    } catch (err) {
      ctx.warn(`Skipping ${profilePath}: ${err.message}`);
      continue;
    }

    let changed = false;

    // 1. Scrub orchestration prose from profile.system.
    if (profile.system) {
      const { value, changed: didChange } = scrubOrchestrationFromLocalized(profile.system);
      if (didChange) {
        profile.system = value;
        changed = true;
        ctx.log(`Scrubbed orchestration prose from ${profilePath} profile.system`);
      }
    }

    // 2. Seed planner.system / planner.goal defaults when planner enabled.
    if (profile.planner && profile.planner.enabled) {
      if (!isLocalizedNonEmpty(profile.planner.system)) {
        profile.planner.system = { ...DEFAULT_PLANNER_SYSTEM };
        changed = true;
        ctx.log(`Set default planner.system for ${profilePath}`);
      }
      if (!isLocalizedNonEmpty(profile.planner.goal)) {
        profile.planner.goal = { ...DEFAULT_PLANNER_GOAL };
        changed = true;
        ctx.log(`Set default planner.goal for ${profilePath}`);
      }
    }

    // 3. Seed synthesizer defaults when effectively used (planner OR inbox).
    const synthEffective =
      (profile.planner && profile.planner.enabled) || typeof profile.inboxId === 'string';
    if (synthEffective) {
      if (!profile.synthesizer || typeof profile.synthesizer !== 'object') {
        profile.synthesizer = {};
        changed = true;
      }
      if (profile.synthesizer.enabled !== false) {
        if (!isLocalizedNonEmpty(profile.synthesizer.system)) {
          profile.synthesizer.system = { ...DEFAULT_SYNTHESIZER_SYSTEM };
          changed = true;
          ctx.log(`Set default synthesizer.system for ${profilePath}`);
        }
        if (!isLocalizedNonEmpty(profile.synthesizer.prompt)) {
          profile.synthesizer.prompt = { ...DEFAULT_SYNTHESIZER_PROMPT };
          changed = true;
          ctx.log(`Set default synthesizer.prompt for ${profilePath}`);
        }
      }
    }

    // 4. Wipe embedded workflow.definition so the new serializer rebuilds it.
    if (
      profile.workflow &&
      profile.workflow.ref !== 'external' &&
      profile.workflow.definition &&
      typeof profile.workflow.definition === 'object'
    ) {
      // Scrub orchestration prose from any embedded prompt-node system fields
      // before wiping — these may be re-saved as part of an author's custom
      // workflow if they re-author. We leave the structure but clean the text.
      const nodes = profile.workflow.definition.nodes;
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (node && node.config && node.config.system) {
            const { value, changed: didChange } = scrubOrchestrationFromLocalized(
              node.config.system
            );
            if (didChange) {
              node.config.system = value;
              changed = true;
            }
          }
          if (
            node &&
            node.type === 'planner' &&
            node.config &&
            node.config.taskTemplate &&
            node.config.taskTemplate.system
          ) {
            const { value, changed: didChange } = scrubOrchestrationFromLocalized(
              node.config.taskTemplate.system
            );
            if (didChange) {
              node.config.taskTemplate.system = value;
              changed = true;
            }
          }
        }
      }
      // Now wipe the definition. The serializer rebuilds on next save/load.
      delete profile.workflow.definition;
      changed = true;
      ctx.log(`Wiped embedded workflow.definition for ${profilePath} (will rebuild)`);
    }

    if (!changed) continue;

    try {
      await ctx.writeJson(profilePath, profile);
      migrated += 1;
    } catch (err) {
      ctx.warn(`Failed to write ${profilePath}: ${err.message}`);
    }
  }

  if (migrated === 0) {
    ctx.log('All agent profiles already in canonical shape');
  } else {
    ctx.log(`Migrated ${migrated} agent profile file(s) to split planner/synthesizer config`);
  }
}
