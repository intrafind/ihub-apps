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
 *   - Calls `serializeProfile()` to regenerate the embedded workflow
 *     definition from scratch — picking up `memory-compose` and dropping any
 *     hand-authored legacy nodes/outputSchemas.
 *   - Logs a structured node-id diff per profile so on-disk changes are
 *     visible in the migration log.
 *   - Leaves profiles with `workflow.ref === 'external'` untouched.
 *
 * Idempotent: re-running finds the backup already present and the new
 * definition matches what serializeProfile would emit again, producing no
 * further changes.
 */

import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';

export const version = '052';
export const description = 'rebuild_embedded_agent_workflows';

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

        const rebuiltProfile = serializeProfile(profile);
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
        ctx.warn(`serializeProfile failed for ${profile.id}: ${err.message} — leaving as-is`);
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
