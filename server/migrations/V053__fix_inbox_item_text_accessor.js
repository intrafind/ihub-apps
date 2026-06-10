/**
 * Migration V053 — Normalize legacy `${$.data.currentInboxItem}` JSONPath
 *
 * Agent profiles authored before the inbox-item accessor fix use the JSONPath
 * template `${$.data.currentInboxItem}` directly in planner/reviewer/memory
 * prompts. The runtime's `resolveVariables` calls `String(value)` on the
 * matched node — and `currentInboxItem` is an object
 * `{ id, line, text, priority, raw }`, so it renders literally as
 * `"[object Object]"`. The planner LLM then receives no usable goal and
 * returns no plan; the review-loop's body produces `null`, the loop exits,
 * and the run completes without any tasks.
 *
 * Fix: rewrite `${$.data.currentInboxItem}` → `${$.data.currentInboxItem.text}`
 * in every string value of every profile, then re-run `serializeProfile()`
 * so the embedded workflow definition picks up the corrected template.
 *
 * Leaves the handlebars-style `{{currentInboxItem}}` alone — that variant is
 * handled by PromptNodeExecutor's templating layer which renders the inbox
 * item as `(P1) <text>` with priority prefix.
 *
 * Idempotent: subsequent runs find nothing to rewrite.
 */

import { serializeProfile } from '../agents/profile/profileWorkflowSerializer.js';

export const version = '053';
export const description = 'fix_inbox_item_text_accessor';

// Match the JSONPath template that does NOT already drill into a property.
// `${$.data.currentInboxItem}`               → rewrite
// `${$.data.currentInboxItem.text}`          → leave alone
// `${$.data.currentInboxItem.priority}`      → leave alone
// `{{currentInboxItem}}`                     → leave alone (handlebars layer)
const LEGACY_INBOX_TEMPLATE = /\$\{\$\.data\.currentInboxItem\}/g;
const FIXED_INBOX_TEMPLATE = '${$.data.currentInboxItem.text}';

function rewriteValue(value) {
  if (typeof value === 'string') {
    if (!LEGACY_INBOX_TEMPLATE.test(value)) return { value, changed: false };
    LEGACY_INBOX_TEMPLATE.lastIndex = 0;
    const next = value.replace(LEGACY_INBOX_TEMPLATE, FIXED_INBOX_TEMPLATE);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const r = rewriteValue(item);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      const r = rewriteValue(v);
      next[k] = r.value;
      if (r.changed) changed = true;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

export async function precondition(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles('agents/profiles', '*.json');
  let rewritten = 0;
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
    if (!profile || typeof profile !== 'object' || !profile.id) continue;

    const rewriteResult = rewriteValue(profile);
    let touched = rewriteResult.changed;
    profile = rewriteResult.value;
    if (touched) rewritten++;

    if (profile.workflow?.ref === 'external') {
      skippedExternal++;
    } else if (touched) {
      // Only rebuild if we changed something — V052 already produced the
      // canonical shape for untouched profiles.
      try {
        profile = serializeProfile(profile);
        rebuilt++;
      } catch (err) {
        ctx.warn(`serializeProfile failed for ${profile.id}: ${err.message}`);
        failed++;
      }
    }

    if (touched) {
      await ctx.writeJson(path, profile);
      ctx.log(`Fixed inbox-item accessor in ${profile.id}`);
    }
  }

  ctx.log(
    `Processed ${files.length} profile(s) — rewritten=${rewritten}, rebuilt=${rebuilt}, externalSkipped=${skippedExternal}, failed=${failed}`
  );
}
