// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * KnowledgeScopePlanner — load all, or search (spec 2 §6).
 *
 * For every project in a request's scope, with its knowledge mode
 * (`shared/knowledgeModes.js`, decided by `resolveProjectScope`: link →
 * project default):
 *
 *  - `context` injects every usable item (the old `exposeAs: prompt`);
 *  - `tools` injects pinned items only and leaves the rest to the tools;
 *  - `relevant` injects the pinned items and the sections of all the other
 *    documents that best match the question, and leaves the rest to the tools;
 *    it works for a project that cannot be loaded in full (an iFinder smart
 *    collection) as well;
 *  - `pinned` injects the pinned items and nothing else: the other documents are
 *    not reachable, no knowledge tool is offered for the project;
 *  - `auto` injects everything when the project's text fits the remaining
 *    load-all budget and falls back to `relevant` when it does not.
 *
 * A model that cannot call tools (`supportsTools: "none"`) cannot search: for it
 * `tools` is `relevant`, so what is not pinned is not silently out of reach.
 * Documents marked "Not for AI" never reach the planner (`resolveProjectScope`
 * leaves them out).
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
 * When an `auto` project does not fit and the turn has a question
 * (`options.question`, the user's latest message — never a model-written
 * rewrite), the pinned documents are joined by the sections of the other
 * documents that best match it: BM25 over the project's cached corpus index
 * (`provider.search`), verbatim, each marked with its document id and section
 * id (`excerpt`), up to what is left of the budget. The same question decides
 * what is kept of the document the hard limit cuts: its best sections and an
 * outline, not its first characters. Without a question (a workflow node, an
 * empty message) the plan is what it was before.
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
import { estimateTokens, estimateTokensMemo } from '../../../shared/tokenEstimator.js';
import { modelSupportsTools } from '../../../shared/modelCapabilities.js';
import { selectContent } from '../../sources/documentRetrieval.js';
import logger from '../../utils/logger.js';
import { neutralizeStructuralTags } from '../../../shared/promptContext.js';
import { projectDescription, projectName } from '../projects/projectView.js';
import { providerFor } from './registry.js';
import configCache from '../../configCache.js';
import projectActivityTracker from '../../telemetry/ProjectActivityTracker.js';
import { isRefreshExpired } from '../projects/refreshTtl.js';
import { projectSettings } from '../projects/projectSettings.js';
import { docOf } from './types.js';
import { DEFAULT_KNOWLEDGE_MODE, KNOWLEDGE_MODES } from '../../../shared/knowledgeModes.js';

export const CONTEXT_SHARE = 0.4;

/** The share of the context window no injection may exceed, pinned or not. */
const HARD_CONTEXT_SHARE = 0.75;

/**
 * The share of the load-all budget the excerpts of a whole scope may take: a
 * later project that fits in full is not starved by an earlier one that does not.
 */
export const EXCERPT_SHARE = 0.5;

/** Most excerpt sections one project asks its search for. */
const EXCERPT_HITS = 12;

/** Below this many tokens of room, a cut document keeps its start, not excerpts. */
const MIN_EXCERPT_ROOM_TOKENS = 1500;

/** What the model is told about an excerpted document. */
const EXCERPT_NOTE =
  'Excerpt: the sections of this document that best match the question, not the whole document. ' +
  'Read the rest with knowledge_read (document id, section id).';

/** The same for a project the model has no tools for: there is nothing to read the rest with. */
const EXCERPT_NOTE_NO_TOOLS =
  'Excerpt: the sections of this document that best match the question, not the whole document.';

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
 * What remains of a document that does not fit the hard limit, when the turn
 * has a question: its best sections for it and an outline of the rest, within
 * `room` tokens. Null when nothing matches or the result does not fit.
 */
function focusedRemainder(entry, question, room) {
  let budgetChars = Math.floor(room * 3.5);
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = selectContent(entry.text, {
      focus: question,
      name: entry.doc.name,
      budgetChars,
      hint: 'Read a section in full with knowledge_read.'
    });
    if (selected.retrieval?.mode !== 'focus') return null;
    const tokens = estimateTokens(selected.content);
    if (tokens <= room)
      return { text: selected.content, tokens, sections: selected.retrieval.sections };
    budgetChars = Math.floor(budgetChars * 0.8);
  }
  return null;
}

/**
 * Keep the injected documents of the whole scope within the hard limit:
 * every project's pinned documents first, in scope order, then the other
 * documents in scope order. A pinned document of a later project is never
 * dropped for unpinned text of an earlier one. The first document that does
 * not fit is cut to the room left, the rest are dropped. With a `question` the
 * cut keeps the document's best sections for it and an outline of the rest
 * (`excerpt`); without one, or when nothing matches, its first characters
 * (`truncated`). An excerpt that does not fit is dropped whole.
 *
 * @param {Array<{injected: Array<{doc: Object, text: string, tokens?: number}>}>} projects
 * @param {number} limitTokens
 * @param {string|null} [question]
 * @returns {Array<{docs: Array, cut: string[]}>} Per project, in its order.
 */
function allocateHardLimit(projects, limitTokens, question = null) {
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
    // Sections picked for the question are not cut again.
    if (entry.excerpt) continue;
    const room = limitTokens - used;
    if (question && room >= MIN_EXCERPT_ROOM_TOKENS) {
      const remainder = focusedRemainder(entry, question, room);
      if (remainder) {
        result[index].docs.push({
          ...entry,
          text: remainder.text,
          tokens: remainder.tokens,
          sections: remainder.sections,
          excerpt: true
        });
        used = limitTokens;
        continue;
      }
    }
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

function escapeXmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** One hit as the text of an excerpt: its section, with the id the model reads it by. */
function renderExcerptSection(hit) {
  const attributes = [
    `id="${escapeXmlAttribute(hit.sectionId)}"`,
    `path="${escapeXmlAttribute(hit.path.join(' › '))}"`
  ];
  const [part, partCount] = String(hit.part).split('/');
  if (Number(partCount) > 1) attributes.push(`part="${part}/${partCount}"`);
  return `<section ${attributes.join(' ')}>\n${hit.text}\n</section>`;
}

/**
 * The sections of a project's unpinned documents that best match the question,
 * verbatim, one excerpt per document (the best document first), within
 * `roomTokens`. Ranked by the project's cached corpus index — the same one
 * `knowledge_search` uses — so a turn pays for no second index. Never throws:
 * a search that fails leaves the project as it would have been without
 * excerpts.
 *
 * @param {Object} provider
 * @param {Object} project
 * @param {Object} ctx
 * @param {{question: string, roomTokens: number, loaded: Object, pinnedIds: string[]}} options
 * @returns {Promise<Array>} Injected entries, `excerpt: true`.
 */
async function excerptsFor(provider, project, ctx, { question, roomTokens, loaded, pinnedIds }) {
  if (roomTokens <= 0) return [];
  const pinned = new Set(pinnedIds);
  const docIds = (project.items || [])
    .filter(item => (item.status === 'ready' || item.status === 'stale') && !pinned.has(item.id))
    .map(item => item.id);
  if (!docIds.length) return [];
  let found;
  try {
    found = await provider.search(
      project,
      { ...ctx, query: question },
      { query: question, limit: EXCERPT_HITS, docIds, budgetChars: roomTokens * 4 }
    );
  } catch (error) {
    logger.warn('Project excerpts could not be searched', {
      component: 'KnowledgeScopePlanner',
      projectId: project.id,
      error: error.message
    });
    return [];
  }
  const byDoc = new Map();
  let used = 0;
  for (const hit of found.hits || []) {
    const section = renderExcerptSection(hit);
    const tokens = estimateTokens(section);
    if (used + tokens > roomTokens) continue;
    used += tokens;
    if (!byDoc.has(hit.docId)) byDoc.set(hit.docId, []);
    byDoc.get(hit.docId).push({ hit, section, tokens });
  }
  const loadedById = new Map((loaded?.docs || []).map(entry => [entry.doc.id, entry]));
  const entries = [];
  for (const [docId, parts] of byDoc) {
    const item = (project.items || []).find(candidate => candidate.id === docId);
    if (!item) continue;
    const from = loadedById.get(docId);
    entries.push({
      doc: from?.doc || docOf(project, item),
      text: parts.map(part => part.section).join('\n\n'),
      tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      sections: parts.map(part => part.hit.sectionId),
      excerpt: true,
      ...(from?.sourceTruncated ? { sourceTruncated: true } : {}),
      ...(from?.sourceFailed ? { sourceFailed: from.sourceFailed } : {})
    });
  }
  return entries;
}

/**
 * The excerpts a `relevant` project, or an `auto` one that does not fit, injects
 * beside its pinned documents: none without a question or a search, otherwise
 * what {@link excerptsFor} finds within the room the pinned documents leave.
 */
async function relevantExcerpts(
  provider,
  project,
  ctx,
  { query, capabilities, injected, remaining, excerptRoom, loaded, pinnedIds }
) {
  if (!query || !capabilities.search) return [];
  const pinnedTokens = injected.reduce(
    (sum, doc) => sum + (doc.tokens ?? estimateTokens(doc.text)),
    0
  );
  return excerptsFor(provider, project, ctx, {
    question: query,
    roomTokens: Math.min(remaining - pinnedTokens, excerptRoom),
    loaded,
    pinnedIds
  });
}

/**
 * Plan a scope.
 *
 * @param {import('./ProjectScope.js').ScopeEntry[]} scope
 * @param {Object} options
 * @param {Object|null} options.model
 * @param {Object} options.settings - `projectSettings(platform)`
 * @param {import('./KnowledgeProvider.js').KnowledgeContext} options.ctx
 * @param {string|null} [options.question] - What the turn asks (the user's latest
 *   message, `focusQueryFromMessages`); null when there is none. Decides which
 *   sections an `auto` project that does not fit injects, and what the hard limit keeps
 * @param {number} [options.budgetTokens] - The load-all budget, instead of
 *   {@link loadAllBudget}: a caller that spends more or less on a turn (a research
 *   depth) says so here
 * @returns {Promise<{projects: Array, budgetTokens: number, usedTokens: number, tools: boolean,
 *   toolless: boolean}>} `tools`: a project is left to the knowledge tools; `toolless`: the
 *   model cannot call them
 */
export async function planKnowledgeScope(
  scope,
  { model, settings, ctx, question = null, budgetTokens: budgetOverride }
) {
  const budgetTokens =
    Number.isFinite(budgetOverride) && budgetOverride > 0
      ? Math.floor(budgetOverride)
      : loadAllBudget(model, settings);
  const query = typeof question === 'string' && question.trim() ? question.trim() : null;
  let excerptRoom = Math.floor(budgetTokens * EXCERPT_SHARE);
  const limitTokens = hardLimit(model, settings);
  // A model that cannot be given tools cannot call the knowledge tools either.
  // A model that does not say (a bare test double, an unknown model) is taken to have them.
  const toolless =
    Boolean(model) && model.supportsTools !== undefined && !modelSupportsTools(model);
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
    // A project in the scope of a chat turn is part of the working set, whether
    // or not this turn ends up reading it (a `tools` project is searched later).
    projectActivityTracker.recordProjectUse(project);
    const capabilities = provider.capabilities(project);
    const usable = (project.items || []).filter(
      item => item.status === 'ready' || item.status === 'stale'
    );
    const pinnedIds = usable.filter(item => item.pinned).map(item => item.id);

    // The mode the project is used in: its knowledge mode, and `relevant` for a
    // model that cannot search where the mode would have left the rest to a search.
    let knowledgeMode = KNOWLEDGE_MODES.includes(entry.mode) ? entry.mode : DEFAULT_KNOWLEDGE_MODE;
    if (toolless && knowledgeMode === 'tools') knowledgeMode = 'relevant';
    const fellBack = knowledgeMode !== entry.mode && KNOWLEDGE_MODES.includes(entry.mode);

    let effective;
    if (knowledgeMode === 'pinned') effective = 'pinned';
    else if (knowledgeMode === 'relevant') effective = 'relevant';
    // A project that cannot be loaded in full is searched, or, for a model
    // without tools, read by the question like `relevant` does.
    else if (!capabilities.loadAll) effective = toolless ? 'relevant' : 'searched';
    else if (knowledgeMode === 'context') effective = 'loaded';
    else if (knowledgeMode === 'tools') effective = 'searched';
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
          // The question's sections of the documents that did not fit, within
          // what the pinned ones leave of the budget and of the excerpts' share.
          const excerpts = await relevantExcerpts(provider, project, ctx, {
            query,
            capabilities,
            injected,
            remaining,
            excerptRoom,
            loaded,
            pinnedIds
          });
          excerptRoom -= excerpts.reduce((sum, entry) => sum + entry.tokens, 0);
          injected = [...injected, ...excerpts];
        }
      } else {
        injected = loaded.docs;
      }
    } else if (pinnedIds.length && capabilities.loadAll) {
      // `relevant`, `tools` and `pinned`: the pinned documents are in the prompt.
      const loaded = await provider.loadAll(project, ctx, { itemIds: pinnedIds });
      unavailable = loaded.unavailable;
      injected = loaded.docs;
    }
    if (effective === 'relevant') {
      // The pinned documents, and the best sections of every other one for
      // the question, whether or not the project would have fit.
      const excerpts = await relevantExcerpts(provider, project, ctx, {
        query,
        capabilities,
        injected,
        remaining,
        excerptRoom,
        loaded: null,
        pinnedIds
      });
      excerptRoom -= excerpts.reduce((sum, entry) => sum + entry.tokens, 0);
      injected = [...injected, ...excerpts];
      effective = 'searched';
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
      knowledgeMode,
      modeSource: entry.modeSource || 'default',
      ...(fellBack ? { modeFallback: entry.mode } : {}),
      documents: usable.length,
      // Snapshots past their refresh time (#3622): reading the project started
      // their refresh, and this turn uses the stored text meanwhile.
      outdated: outdatedCount(project, usable),
      tokens,
      pinned: pinnedIds.length,
      overBudget: false,
      injected,
      cut: [],
      unavailable,
      // The usable documents, for the list a searched project shows the model.
      catalog: usable.map(item => docOf(project, item))
    });
  }
  // The hard limit bounds the whole prompt, not each project of it, and
  // pinned text of every project comes before unpinned text of any.
  const allocated = allocateHardLimit(projects, limitTokens, query);
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
    if (cut.length > 0 && planned.mode !== 'pinned') planned.mode = 'searched';
    planned.overBudget = planned.tokens > budgetTokens || cut.length > 0;
    if (planned.mode === 'searched' && !toolless) tools = true;
  });
  // The document lists of the searched projects share one budget, spent in
  // scope order, so many searched projects cannot crowd a small window.
  // A model without tools gets no list to read from: it could not read from it.
  let listRoom = toolless ? 0 : listBudget(model, limitTokens, usedTokens);
  const listBudgetTokens = listRoom;
  for (const planned of projects) {
    if (planned.mode !== 'searched') continue;
    if (toolless) {
      planned.documentList = [];
      continue;
    }
    const list = documentListLines(planned, listRoom);
    planned.documentList = list.lines;
    listRoom = Math.max(0, listRoom - list.tokens);
  }
  return {
    projects,
    budgetTokens,
    limitTokens,
    toolless,
    listBudgetTokens,
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
  /<(\/?)(projects|project-instructions|project|document-list|document)((?:\s[^<>]*)?\/?)>/gi;

/**
 * Text from a document, a document's name, title or description, or a
 * project's instructions as it goes into the
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

/** Most documents a searched project lists in the prompt. */
export const MAX_LISTED_DOCUMENTS = 50;

/** Most tokens the document list of one searched project may take. */
export const MAX_LIST_TOKENS = 2000;

/**
 * The share of the model's context window the document lists of a whole
 * scope may take together: four searched projects must not add 8,000 tokens
 * to every turn of a model with an 8k window.
 */
export const LIST_CONTEXT_SHARE = 0.1;

/**
 * The tokens the document lists of a scope may take together: a share of the
 * context window (four full lists when the window is unknown), and never more
 * than the hard limit leaves beside the injected text.
 *
 * @param {{contextWindow?: number}|null} model
 * @param {number} limitTokens - {@link hardLimit}
 * @param {number} injectedTokens - What the plan's documents take.
 * @returns {number}
 */
export function listBudget(model, limitTokens, injectedTokens) {
  const window = Number(model?.contextWindow);
  const share =
    Number.isFinite(window) && window > 0
      ? Math.floor(window * LIST_CONTEXT_SHARE)
      : MAX_LIST_TOKENS * 4;
  return Math.max(0, Math.min(share, limitTokens - injectedTokens));
}

/** Longest description a list line carries, in characters. */
const LIST_DESCRIPTION_CHARS = 160;

/** One line of user-controlled text for the list: no line breaks, bounded, tags escaped. */
function listText(value, max = 300) {
  let text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return neutralizeProjectText(text);
}

/** One document of a searched project's list, about 20 tokens without a description. */
function listLine(doc) {
  const name = listText(doc.name);
  const facts = [];
  if (Number.isFinite(doc.tokens)) facts.push(`${doc.tokens} tokens`);
  if (doc.pinned) facts.push('pinned');
  let line = `- ${listText(doc.id, 100)} "${name}"`;
  if (facts.length) line += ` (${facts.join(', ')})`;
  if (doc.url) line += ` ${listText(doc.url, 300)}`;
  const title = doc.title ? listText(doc.title) : '';
  const about = [
    title && title !== name ? title : '',
    doc.description ? listText(doc.description, LIST_DESCRIPTION_CHARS) : ''
  ].filter(Boolean);
  if (about.length) line += ` — ${about.join(': ')}`;
  return line;
}

/**
 * The document list of a searched project: the documents that are not in the
 * prompt already, pinned ones first, within {@link MAX_LISTED_DOCUMENTS} and
 * `budgetTokens` (the list's lines included). Without it the model knows a
 * count and nothing it could read; with it, it can read the page it needs
 * instead of searching. What does not fit is counted and left to
 * `knowledge_list`.
 *
 * @param {Object} project - A planned project.
 * @param {number} [budgetTokens] - At most {@link MAX_LIST_TOKENS}.
 * @returns {{lines: string[], tokens: number}} The lines of the
 *   `<document-list>` element, none when every document is in the prompt.
 */
function documentListLines(project, budgetTokens = MAX_LIST_TOKENS) {
  // An excerpted document is in the prompt in part: it stays listed, so the
  // model knows there is more of it and can read it.
  const inPrompt = new Set(
    project.injected.filter(entry => !entry.excerpt).map(({ doc }) => doc.id)
  );
  const docs = (project.catalog || []).filter(doc => !inPrompt.has(doc.id));
  if (!docs.length) return { lines: [], tokens: 0 };
  const ordered = [...docs.filter(doc => doc.pinned), ...docs.filter(doc => !doc.pinned)];
  const intro =
    'Read a listed document directly with knowledge_read (its id), or search them all with knowledge_search.';
  const more = count =>
    `${count} ${count === ordered.length ? '' : 'more '}${count === 1 ? 'document is' : 'documents are'} not listed here: call knowledge_list with project="${escapeAttribute(project.id)}" for the complete list.`;
  const frame = (listedCount, withMore) => [
    `    <document-list documents="${ordered.length}" listed="${listedCount}">`,
    intro,
    ...(withMore ? [more(ordered.length - listedCount)] : []),
    '    </document-list>'
  ];
  const cap = Math.min(MAX_LIST_TOKENS, Math.max(0, budgetTokens));
  // The frame of a cut list is what the documents share the room with.
  const room = cap - estimateTokensMemo(frame(0, true).join('\n'));
  const listed = [];
  let used = 0;
  for (const doc of ordered) {
    if (listed.length >= MAX_LISTED_DOCUMENTS) break;
    const line = listLine(doc);
    const tokens = estimateTokensMemo(line);
    if (used + tokens > room) break;
    listed.push(line);
    used += tokens;
  }
  const left = ordered.length - listed.length;
  const [open, introLine, ...rest] = frame(listed.length, left > 0);
  const lines = [open, introLine, ...listed, ...rest];
  return { lines, tokens: estimateTokensMemo(lines.join('\n')) };
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
      attrs.push(`documents="${project.documents}"`);
      if (!plan.toolless) attrs.push('tool="knowledge_search"');
    }
    // Said to the model in so many words: a project it was told about, that the
    // user attached, and whose documents are not in this answer. Without it the
    // model answers as if it had searched them.
    if (project.mode === 'unavailable' && project.reason === 'IFINDER_UNAVAILABLE') {
      attrs.push(
        'reason="iFinder could not be reached. The documents of this project are missing from this answer: say so to the user instead of answering as if you had searched them."'
      );
    }
    // A searched project names what it holds beyond what is in the prompt.
    // The planner sized it against the scope's list budget; a plan built
    // elsewhere (a test) gets a list within the per-project cap.
    const listLines =
      project.mode === 'searched' ? project.documentList || documentListLines(project).lines : [];
    if (project.mode !== 'loaded' && !project.injected.length && !listLines.length) {
      lines.push(`  <project ${attrs.join(' ')}/>`);
      continue;
    }
    lines.push(`  <project ${attrs.join(' ')}>`);
    for (const { doc, text, truncated, sourceFailed, excerpt } of project.injected) {
      const docAttrs = [
        `id="${escapeAttribute(doc.id)}"`,
        `name="${escapeAttribute(doc.name)}"`,
        `origin="${escapeAttribute(doc.provenance?.origin || 'linked')}"`
      ];
      if (doc.pinned) docAttrs.push('pinned="true"');
      if (truncated) docAttrs.push('truncated="true"');
      if (excerpt) docAttrs.push('excerpt="true"');
      if (sourceFailed) docAttrs.push('incomplete="true"');
      lines.push(
        `    <document ${docAttrs.join(' ')}>`,
        ...(excerpt
          ? [plan.toolless || project.mode === 'pinned' ? EXCERPT_NOTE_NO_TOOLS : EXCERPT_NOTE]
          : []),
        neutralizeProjectText(text),
        '    </document>'
      );
    }
    lines.push(...listLines);
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
 * The client-facing summary of a plan: the `knowledge/scope` event. Only a
 * project that `contributed` counts as a basis of the answer; the others were
 * in scope and are reported as not used.
 *
 * @param {Awaited<ReturnType<typeof planKnowledgeScope>>} plan
 * @returns {{projects: Array, budgetTokens: number}}
 */
/**
 * How many usable documents of a project are past their refresh time or being
 * refreshed (#3622): the answer reads their stored text while the refresh
 * that reading the project started runs.
 *
 * @param {Object} project
 * @param {Object[]} usable
 * @returns {number}
 */
function outdatedCount(project, usable) {
  const settings = projectSettings(configCache.getPlatform?.() || {});
  const now = Date.now();
  return usable.filter(
    item =>
      Boolean(item.refreshingAt) ||
      (item.status === 'ready' && isRefreshExpired(item, project, settings, now))
  ).length;
}

export function scopeSummary(plan) {
  return {
    budgetTokens: plan.budgetTokens,
    projects: plan.projects.map(project => ({
      id: project.id,
      name: project.name,
      ownership: project.ownership,
      origin: project.origin,
      mode: project.mode,
      // The knowledge mode the project is used in and the level that chose it
      // (`chat`, `link`, `project` or `default`); `modeFallback` names the mode
      // it replaced when the model cannot call the knowledge tools.
      ...(project.knowledgeMode
        ? {
            knowledgeMode: project.knowledgeMode,
            modeSource: project.modeSource,
            ...(project.modeFallback ? { modeFallback: project.modeFallback } : {})
          }
        : {}),
      documents: project.documents,
      tokens: project.tokens,
      pinned: project.pinned,
      // Whether the project's text went into the prompt: the first half of "the
      // answer rests on it". A searched project also contributes when a search
      // of the turn returns its documents, which only the end of the turn knows.
      contributed: Boolean(project.injected?.length),
      ...(project.mode === 'unavailable' && project.reason ? { reason: project.reason } : {}),
      ...(project.overBudget ? { overBudget: true } : {}),
      ...(project.injected?.some(entry => entry.excerpt) ? { excerpted: true } : {}),
      ...(project.cut?.length ? { cut: project.cut.length } : {}),
      ...(project.unavailable?.length ? { unavailable: project.unavailable.length } : {}),
      ...(project.outdated ? { outdated: project.outdated } : {})
    }))
  };
}
