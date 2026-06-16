/**
 * Migration V057 — Rebuild embedded agent workflows for tripartite memory
 *
 * The memory composer node changed shape:
 *   - Its outputSchema replaced the single flat `content` field with one string
 *     per memory section (`semantic` / `episodic` / `procedural`).
 *   - `memory-finalize` now drains the composer delta through
 *     `memoryFile.applyMemoryDelta()`, sorting bullets into the canonical
 *     `## Semantic` / `## Episodic` / `## Procedural` sections with per-entry
 *     source markers.
 *
 * Embedded workflow definitions persisted on existing profiles still carry the
 * old composer schema/prompt, so the LLM would keep emitting a flat `content`
 * field (which the new pipeline still accepts as a Semantic-section fallback,
 * but without the section sorting the operator expects). This migration
 * re-serializes each embedded profile so the new composer node lands on disk.
 *
 * Existing memory FILES are intentionally left untouched: their current content
 * has no agent source markers, so it is treated as human-authored and immutable
 * — the safe default. New runs add marked agent entries under the canonical
 * sections going forward.
 *
 * Idempotent: re-running re-serializes to the same shape, producing no further
 * changes. Profiles with `workflow.ref === 'external'` are left alone.
 */

import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';

export const version = '057';
export const description = 'rebuild_agent_workflows_tripartite_memory';

export async function precondition(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  let rebuilt = 0;
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

    if (profile.workflow?.ref === 'external') {
      skippedExternal++;
      continue;
    }

    try {
      const rebuiltProfile = serializeProfile(profile);
      await ctx.writeJson(path, rebuiltProfile);
      rebuilt++;
      ctx.log(`Rebuilt ${profile.id} for tripartite memory composer`);
    } catch (err) {
      ctx.warn(`serializeProfile failed for ${profile.id}: ${err.message} — leaving as-is`);
      failed++;
    }
  }

  ctx.log(
    `Processed ${files.length} profile(s) — rebuilt=${rebuilt}, externalSkipped=${skippedExternal}, failed=${failed}`
  );
}
