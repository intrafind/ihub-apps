/**
 * Migration V054 — Clear stale planner.system overrides on agent profiles
 *
 * Earlier profile snapshots saved `planner.system` as a verbatim copy of the
 * default at the time. V052 stripped the legacy "add another planner task"
 * sentence from those snapshots, but what remains is still effectively the
 * old default — a weaker decomposition prompt without the ONE-ANGLE,
 * ONE-ENTITY, and decomposition-test rules now in DEFAULT_PLANNER_SYSTEM.
 * Because the snapshot is present as a profile override, the runtime never
 * reaches the updated default and the planner keeps producing broad,
 * multi-angle tasks.
 *
 * This migration detects the post-V052 stale snapshot by signature (opens
 * with "You are a planner. Given a brief, decompose" and is short enough
 * that no real customization could fit) and removes the override entirely
 * so `localizedToString(profile.planner?.system, DEFAULT_PLANNER_SYSTEM)`
 * falls back to the canonical default at runtime.
 *
 * Operator-customized prompts (longer or with a different opening) are
 * left untouched.
 *
 * After clearing, serializeProfile() regenerates the embedded workflow so
 * the planner node inside review-loop picks up the new default text.
 *
 * Idempotent: subsequent runs find nothing to clear.
 */

import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';

export const version = '054';
export const description = 'clear_stale_planner_system_overrides';

// Signature of the stale snapshot. The opening sentence is the cheapest
// reliable marker — it has been the first sentence of the default since
// the planner shipped, and operators who genuinely customize the prompt
// virtually always rewrite the opening.
const STALE_OPENING = 'You are a planner. Given a brief, decompose';
// Any genuine customization adds enough material to exceed this length.
// The post-V052 stale snapshot is ~430 chars; the current default is ~2700.
const STALE_MAX_LENGTH = 800;

function isStaleSnapshot(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > STALE_MAX_LENGTH) return false;
  return trimmed.startsWith(STALE_OPENING);
}

function clearStaleFromLocalized(localized) {
  if (typeof localized === 'string') {
    return isStaleSnapshot(localized)
      ? { value: undefined, changed: true }
      : { value: localized, changed: false };
  }
  if (!localized || typeof localized !== 'object') return { value: localized, changed: false };
  let changed = false;
  const next = {};
  for (const [locale, text] of Object.entries(localized)) {
    if (isStaleSnapshot(text)) {
      changed = true;
      // skip this locale entry
      continue;
    }
    next[locale] = text;
  }
  // If every locale was stale, drop the field entirely so the default kicks in.
  if (changed && Object.keys(next).length === 0) {
    return { value: undefined, changed: true };
  }
  return { value: changed ? next : localized, changed };
}

export async function precondition(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  let cleared = 0;
  let rebuilt = 0;
  let skippedExternal = 0;

  for (const file of files) {
    const path = `agents/profiles/${file}`;
    let profile;
    try {
      profile = await ctx.readJson(path);
    } catch (err) {
      ctx.warn(`Could not parse ${path}: ${err.message} — skipping`);
      continue;
    }
    if (!profile || typeof profile !== 'object' || !profile.id || !profile.planner) continue;

    const r = clearStaleFromLocalized(profile.planner.system);
    if (!r.changed) continue;

    if (r.value === undefined) {
      delete profile.planner.system;
    } else {
      profile.planner.system = r.value;
    }
    cleared++;

    if (profile.workflow?.ref === 'external') {
      skippedExternal++;
    } else {
      try {
        profile = serializeProfile(profile);
        rebuilt++;
      } catch (err) {
        ctx.warn(`serializeProfile failed for ${profile.id}: ${err.message}`);
      }
    }

    await ctx.writeJson(path, profile);
    ctx.log(`Cleared stale planner.system on ${profile.id}`);
  }

  ctx.log(
    `Processed ${files.length} profile(s) — cleared=${cleared}, rebuilt=${rebuilt}, externalSkipped=${skippedExternal}`
  );
}
