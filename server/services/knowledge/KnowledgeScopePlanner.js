// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * KnowledgeScopePlanner — load all, or search (spec 2 §6).
 *
 * For every project in a request's scope, with its link mode:
 *
 *  - `context` injects every usable item (the old `exposeAs: prompt`);
 *  - `tools` injects pinned items only and leaves the rest to the tools;
 *  - `auto` injects everything when the project's text fits the remaining
 *    load-all budget and falls back to pinned-plus-tools when it does not.
 *
 * The budget is `min(platform.projects.loadAllMaxTokens, 0.4 × the model's
 * context window)`, spent in scope order (container, app links,
 * attachments). Pinned items are always injected ahead of everything else;
 * when pinned text alone exceeds the budget the plan still injects it and
 * says so (`overBudget`), but never past the hard limit of 75 % of the
 * model's context window, shared by every project of the scope: beyond it
 * the rest is cut (`cut` lists the documents) and stays reachable through
 * `knowledge_read`.
 *
 * A project whose usable documents could not all be loaded (a failed link,
 * an iFinder search without a configured query, a link its source cut at its
 * length limit) is `searched` as well: what did load is injected, the rest is
 * left to the tools.
 *
 * The plan is what the prompt renders (`renderProjectsBlock`) and what the
 * client is told (`knowledge/scope`): per project, `loaded` or `searched`.
 *
 * @module services/knowledge/KnowledgeScopePlanner
 */
import { estimateTokens } from '../../../shared/tokenEstimator.js';
import { neutralizeStructuralTags } from '../../../shared/promptContext.js';
import { projectDescription, projectName } from '../projects/projectView.js';
import { providerFor } from './registry.js';

export const CONTEXT_SHARE = 0.4;

/** The share of the context window no injection may exceed, pinned or not. */
const HARD_CONTEXT_SHARE = 0.75;

/**
 * The load-all budget of a request.
 *
 * @param {{contextWindow?: number}|null} model
 * @param {{loadAllMaxTokens?: number}} settings
 * @returns {number}
 */
export function loadAllBudget(model, settings) {
  const cap = Number(settings?.loadAllMaxTokens) > 0 ? Number(settings.loadAllMaxTokens) : 50000;
  const window = Number(model?.contextWindow);
  if (Number.isFinite(window) && window > 0)
    return Math.min(cap, Math.floor(window * CONTEXT_SHARE));
  return cap;
}

/**
 * The hard limit of injected text: what the prompt may never exceed.
 *
 * @param {{contextWindow?: number}|null} model
 * @param {{loadAllMaxTokens?: number}} settings
 * @returns {number}
 */
export function hardLimit(model, settings) {
  const window = Number(model?.contextWindow);
  if (Number.isFinite(window) && window > 0) {
    return Math.max(1, Math.floor(window * HARD_CONTEXT_SHARE));
  }
  return loadAllBudget(model, settings) * 4;
}

/**
 * Keep the injected documents of the whole scope within the hard limit:
 * every project's pinned documents first, in scope order, then the other
 * documents in scope order. A pinned document of a later project is never
 * dropped for unpinned text of an earlier one. The first document that does
 * not fit is truncated to the room left, the rest are dropped.
 *
 * @param {Array<{injected: Array<{doc: Object, text: string, tokens?: number}>}>} projects
 * @param {number} limitTokens
 * @returns {Array<{docs: Array, cut: string[]}>} Per project, in its order.
 */
function allocateHardLimit(projects, limitTokens) {
  const result = projects.map(() => ({ docs: [], cut: [] }));
  const queue = [];
  for (const pinned of [true, false]) {
    projects.forEach((project, index) => {
      for (const entry of project.injected || []) {
        if (Boolean(entry.doc.pinned) === pinned) queue.push({ index, entry });
      }
    });
  }
  let used = 0;
  for (const { index, entry } of queue) {
    const tokens = entry.tokens ?? estimateTokens(entry.text);
    if (used + tokens <= limitTokens) {
      result[index].docs.push(entry);
      used += tokens;
      continue;
    }
    result[index].cut.push(entry.doc.id);
    const room = limitTokens - used;
    if (room > 0 && tokens > 0) {
      const chars = Math.floor(entry.text.length * (room / tokens));
      if (chars > 0) {
        result[index].docs.push({
          ...entry,
          text: entry.text.slice(0, chars),
          tokens: room,
          truncated: true
        });
        used = limitTokens;
      }
    }
  }
  return result;
}

/** The same documents, pinned ones ahead, otherwise in their order. */
function pinnedFirst(docs) {
  return [...docs.filter(({ doc }) => doc.pinned), ...docs.filter(({ doc }) => !doc.pinned)];
}

/**
 * Plan a scope.
 *
 * @param {import('./ProjectScope.js').ScopeEntry[]} scope
 * @param {Object} options
 * @param {Object|null} options.model
 * @param {Object} options.settings - `projectSettings(platform)`
 * @param {import('./KnowledgeProvider.js').KnowledgeContext} options.ctx
 * @returns {Promise<{projects: Array, budgetTokens: number, usedTokens: number, tools: boolean}>}
 */
export async function planKnowledgeScope(scope, { model, settings, ctx }) {
  const budgetTokens = loadAllBudget(model, settings);
  const limitTokens = hardLimit(model, settings);
  let remaining = budgetTokens;
  const projects = [];
  let tools = false;
  for (const entry of scope) {
    const { project } = entry;
    const name = projectName(project, ctx?.language);
    const description = projectDescription(project, ctx?.language);
    // A project that could not be loaded at all (iFinder down): no provider is
    // asked, and the model and the chat are told it is missing.
    if (entry.unavailable) {
      projects.push({
        id: project.id,
        name,
        description: '',
        ownership: project.ownership,
        origin: entry.origin,
        mode: 'unavailable',
        reason: entry.unavailable,
        documents: 0,
        tokens: 0,
        pinned: 0,
        injected: [],
        cut: [],
        unavailable: []
      });
      continue;
    }
    let provider;
    try {
      provider = providerFor(project);
    } catch (error) {
      projects.push({
        id: project.id,
        name,
        description,
        mode: 'unavailable',
        reason: error.code,
        documents: 0,
        tokens: 0,
        pinned: 0,
        injected: [],
        cut: [],
        unavailable: []
      });
      continue;
    }
    const capabilities = provider.capabilities(project);
    const usable = (project.items || []).filter(
      item => item.status === 'ready' || item.status === 'stale'
    );
    const pinnedIds = usable.filter(item => item.pinned).map(item => item.id);

    let effective;
    if (!capabilities.loadAll) effective = 'searched';
    else if (entry.mode === 'context') effective = 'loaded';
    else if (entry.mode === 'tools') effective = 'searched';
    else effective = 'auto';

    let injected = [];
    let unavailable = [];
    let tokens = 0;
    if (effective === 'loaded' || effective === 'auto') {
      const loaded = await provider.loadAll(project, ctx);
      unavailable = loaded.unavailable;
      if (effective === 'auto') {
        if (loaded.tokens <= remaining) {
          effective = 'loaded';
          injected = loaded.docs;
        } else {
          effective = 'searched';
          injected = loaded.docs.filter(({ doc }) => doc.pinned);
        }
      } else {
        injected = loaded.docs;
      }
    } else if (pinnedIds.length && capabilities.loadAll) {
      const loaded = await provider.loadAll(project, ctx, { itemIds: pinnedIds });
      unavailable = loaded.unavailable;
      injected = loaded.docs;
    }
    // A usable document whose text could not be loaded (its source failed,
    // or it is an iFinder search that needs the question's query) is not in
    // the prompt, so the project is not "loaded in full": the model and the
    // badge are told to search, whether or not other documents made it in.
    const usableIds = new Set(usable.map(item => item.id));
    if (effective === 'loaded' && unavailable.some(doc => usableIds.has(doc.document))) {
      effective = 'searched';
    }
    // A document its source handed over only in part (a link past its
    // handler's length limit, marked `truncated`; an iFinder search missing
    // documents it could not fetch, marked `incomplete`) is in the prompt as
    // far as it goes: the project is not "loaded in full" either.
    if (effective === 'loaded' && injected.some(doc => doc.sourceTruncated || doc.sourceFailed)) {
      effective = 'searched';
    }
    tokens = injected.reduce((sum, doc) => sum + (doc.tokens ?? estimateTokens(doc.text)), 0);
    remaining = Math.max(0, remaining - tokens);
    projects.push({
      id: project.id,
      name,
      description,
      ownership: project.ownership,
      origin: entry.origin,
      instructions: entry.instructions && project.instructions ? project.instructions : '',
      mode: effective,
      documents: usable.length,
      tokens,
      pinned: pinnedIds.length,
      overBudget: false,
      injected,
      cut: [],
      unavailable
    });
  }
  // The hard limit bounds the whole prompt, not each project of it, and
  // pinned text of every project comes before unpinned text of any.
  const allocated = allocateHardLimit(projects, limitTokens);
  let usedTokens = 0;
  projects.forEach((planned, index) => {
    if (planned.mode === 'unavailable') return;
    const { docs, cut } = allocated[index];
    planned.injected = pinnedFirst(docs);
    planned.cut = cut;
    planned.tokens = docs.reduce((sum, doc) => sum + (doc.tokens ?? estimateTokens(doc.text)), 0);
    usedTokens += planned.tokens;
    // What was cut from the prompt stays reachable through the tools, and a
    // project that lost text to the cap is not "loaded in full": the model
    // and the badge are told to search for the rest.
    if (cut.length > 0) planned.mode = 'searched';
    planned.overBudget = planned.tokens > budgetTokens || cut.length > 0;
    if (planned.mode === 'searched') tools = true;
  });
  return {
    projects,
    budgetTokens,
    limitTokens,
    usedTokens: Math.min(budgetTokens, usedTokens),
    tools
  };
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/**
 * The tags the projects block and the instructions are built from. Document
 * text and instructions are scanned for them (open or close, with
 * attributes, any case) and their angle brackets escaped, so a linked page
 * that writes `</document></project></projects><project-instructions>` stays
 * inside its document as literal text instead of closing the block and
 * posing as instructions — the same protection `shared/promptContext.js`
 * gives its content blocks, whose tags are escaped here too.
 */
const PROJECT_TAG_RE =
  /<(\/?)(projects|project-instructions|project|document)((?:\s[^<>]*)?\/?)>/gi;

/**
 * Text from a document or a project's instructions as it goes into the
 * prompt: the structural tags escaped, everything else as it is.
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeProjectText(text) {
  const escaped = String(text ?? '').replace(
    PROJECT_TAG_RE,
    (match, slash, name, rest = '') => `&lt;${slash}${name}${rest}&gt;`
  );
  return neutralizeStructuralTags(escaped);
}

/**
 * The `<projects>` block a plan puts into the system prompt.
 *
 * @param {Awaited<ReturnType<typeof planKnowledgeScope>>} plan
 * @returns {string} Empty when the scope is empty.
 */
export function renderProjectsBlock(plan) {
  if (!plan?.projects?.length) return '';
  const lines = ['<projects>'];
  for (const project of plan.projects) {
    const attrs = [
      `id="${escapeAttribute(project.id)}"`,
      `name="${escapeAttribute(project.name)}"`,
      `mode="${project.mode}"`
    ];
    // What the project holds: without it a searched project is an id and a
    // count, and the model cannot tell that the documentation also carries
    // the release notes.
    if (project.description) {
      attrs.push(`description="${escapeAttribute(neutralizeProjectText(project.description))}"`);
    }
    if (project.mode === 'searched') {
      attrs.push(`documents="${project.documents}"`, 'tool="knowledge_search"');
    }
    // Said to the model in so many words: a project it was told about, that the
    // user attached, and whose documents are not in this answer. Without it the
    // model answers as if it had searched them.
    if (project.mode === 'unavailable' && project.reason === 'IFINDER_UNAVAILABLE') {
      attrs.push(
        'reason="iFinder could not be reached. The documents of this project are missing from this answer: say so to the user instead of answering as if you had searched them."'
      );
    }
    if (project.mode !== 'loaded' && !project.injected.length) {
      lines.push(`  <project ${attrs.join(' ')}/>`);
      continue;
    }
    lines.push(`  <project ${attrs.join(' ')}>`);
    for (const { doc, text, truncated, sourceFailed } of project.injected) {
      const docAttrs = [
        `id="${escapeAttribute(doc.id)}"`,
        `name="${escapeAttribute(doc.name)}"`,
        `origin="${escapeAttribute(doc.provenance?.origin || 'linked')}"`
      ];
      if (doc.pinned) docAttrs.push('pinned="true"');
      if (truncated) docAttrs.push('truncated="true"');
      if (sourceFailed) docAttrs.push('incomplete="true"');
      lines.push(
        `    <document ${docAttrs.join(' ')}>`,
        neutralizeProjectText(text),
        '    </document>'
      );
    }
    lines.push('  </project>');
  }
  lines.push('</projects>');
  return lines.join('\n');
}

/**
 * The instructions of the projects whose instructions apply, as one block.
 *
 * @param {Awaited<ReturnType<typeof planKnowledgeScope>>} plan
 * @returns {string}
 */
export function renderProjectInstructions(plan) {
  const parts = (plan?.projects || [])
    .filter(project => project.instructions)
    .map(
      project =>
        `<project-instructions project="${escapeAttribute(project.id)}">\n${neutralizeProjectText(project.instructions)}\n</project-instructions>`
    );
  return parts.join('\n\n');
}

/**
 * The client-facing summary of a plan: the `knowledge/scope` event.
 *
 * @param {Awaited<ReturnType<typeof planKnowledgeScope>>} plan
 * @returns {{projects: Array, budgetTokens: number}}
 */
export function scopeSummary(plan) {
  return {
    budgetTokens: plan.budgetTokens,
    projects: plan.projects.map(project => ({
      id: project.id,
      name: project.name,
      ownership: project.ownership,
      origin: project.origin,
      mode: project.mode,
      documents: project.documents,
      tokens: project.tokens,
      pinned: project.pinned,
      ...(project.mode === 'unavailable' && project.reason ? { reason: project.reason } : {}),
      ...(project.overBudget ? { overBudget: true } : {}),
      ...(project.cut?.length ? { cut: project.cut.length } : {}),
      ...(project.unavailable?.length ? { unavailable: project.unavailable.length } : {})
    }))
  };
}
