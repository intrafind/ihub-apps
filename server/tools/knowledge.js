// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project knowledge tools — `knowledge_search`, `knowledge_read` and
 * `knowledge_list` (#1036, spec 2 §4). One static definition
 * (`tools/knowledge.json`), a runtime scope: every call resolves which
 * projects the request reaches from the app object it was handed
 * (`appConfig.projects`, `_projectId`, `_attachedProjectIds`,
 * `_workflowProjects`) and the calling user, so the model cannot name a
 * project the request did not bring.
 *
 * Results carry a `sources` envelope: the hits as `Source`s of provider
 * `project`, so the sources panel shows them with their provenance and
 * offers Preview and Download (`services/sources/providers/project.js`).
 *
 * @module tools/knowledge
 */
import { resolveProjectScope } from '../services/knowledge/ProjectScope.js';
import { providerFor } from '../services/knowledge/registry.js';
import { KnowledgeError } from '../services/knowledge/types.js';
import { projectSource } from '../services/sources/producers/project.js';
import { RESULT_BUDGET_CHARS } from '../sources/documentRetrieval.js';

const MAX_LIMIT = 20;

async function scopeOf(params) {
  const scope = await resolveProjectScope({ appConfig: params.appConfig, user: params.user });
  const searchable = scope.filter(entry => entry.mode !== 'context' || true);
  return { all: scope, searchable };
}

function pick(scope, projectId) {
  if (!projectId) return scope;
  const entry = scope.find(item => item.project.id === projectId);
  if (!entry) {
    throw new KnowledgeError(
      'PROJECT_NOT_FOUND',
      `Project "${projectId}" is not available in this chat`
    );
  }
  return [entry];
}

function ctxOf(params) {
  return {
    user: params.user,
    chatId: params.chatId,
    language: params.language,
    purpose: params.appConfig?._workflowProjects ? 'workflow' : 'chat',
    run: params.appConfig?._run || null
  };
}

function errorResult(error) {
  if (error instanceof KnowledgeError) return { error: error.message, code: error.code };
  throw error;
}

/**
 * `knowledge_search`
 *
 * @param {{query: string, project?: string, limit?: number, user: Object, chatId?: string, appConfig: Object}} params
 */
export async function search(params) {
  try {
    const { searchable } = await scopeOf(params);
    if (!searchable.length)
      return { hits: [], unavailable: [], note: 'No project is available in this chat.' };
    const targets = pick(searchable, params.project);
    const query = String(params.query || '').trim();
    if (!query) return { error: 'query is required', code: 'INVALID_REF' };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.limit) || 8));
    const ctx = ctxOf(params);
    const perProject = Math.max(1, Math.ceil(limit / targets.length));
    const gathered = [];
    const unavailable = [];
    const retrieval = [];
    for (const entry of targets) {
      const provider = providerFor(entry.project);
      // Each project may fill the whole budget: the shared cap is applied
      // once the hits of every project are ranked together, so a long
      // matching section in one project is not dropped for the room others
      // leave unused.
      const result = await provider.search(entry.project, ctx, {
        query,
        limit: Math.min(limit, perProject + 2),
        budgetChars: RESULT_BUDGET_CHARS
      });
      for (const hit of result.hits) gathered.push({ hit, project: entry.project });
      for (const u of result.unavailable) unavailable.push({ ...u, project: entry.project.id });
      retrieval.push({ project: entry.project.id, ...result.retrieval });
    }
    gathered.sort((a, b) => b.hit.score - a.hit.score);
    const selected = [];
    let used = 0;
    for (const entry of gathered) {
      if (selected.length >= limit) break;
      const chars = entry.hit.text.length;
      if (used + chars > RESULT_BUDGET_CHARS) continue;
      used += chars;
      selected.push(entry);
    }
    const hits = selected.map(({ hit, project }, index) => ({
      n: index + 1,
      document: hit.docId,
      project: project.id,
      name: hit.name,
      section: hit.sectionId,
      path: hit.path.join(' › '),
      part: hit.part,
      score: hit.score,
      text: hit.text
    }));
    const sources = hits.map((hit, index) => {
      const project = selected[index].project;
      const item = (project.items || []).find(entry => entry.id === hit.document);
      return projectSource(project, item, {
        snippet: hit.text,
        passages: [{ text: hit.text.slice(0, 4000), marker: `s:${hit.n}` }]
      });
    });
    return {
      hits,
      unavailable,
      retrieval: { mode: 'search', query, projects: retrieval },
      note:
        hits.length === 0
          ? 'No passage matches. Try other keywords, or list the documents with knowledge_list and read one with knowledge_read.'
          : 'Cite a passage by its number in square brackets, e.g. [1].',
      sources: sources.filter(Boolean)
    };
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * `knowledge_read`
 *
 * @param {{document: string, project?: string, section?: string, user: Object, chatId?: string, appConfig: Object}} params
 */
export async function read(params) {
  try {
    const { all } = await scopeOf(params);
    if (!all.length)
      return { error: 'No project is available in this chat.', code: 'PROJECT_NOT_FOUND' };
    const documentId = String(params.document || '').trim();
    if (!documentId) return { error: 'document is required', code: 'INVALID_REF' };
    const targets = pick(all, params.project);
    const entry = targets.find(candidate =>
      (candidate.project.items || []).some(item => item.id === documentId)
    );
    if (!entry)
      return {
        error: `Document "${documentId}" is not in an available project`,
        code: 'ITEM_NOT_FOUND'
      };
    const provider = providerFor(entry.project);
    const result = await provider.read(
      entry.project,
      ctxOf(params),
      { itemId: documentId },
      {
        section: typeof params.section === 'string' ? params.section : undefined
      }
    );
    const item = (entry.project.items || []).find(candidate => candidate.id === documentId);
    return {
      document: documentId,
      project: entry.project.id,
      name: result.doc.name,
      content: result.text,
      retrieval: result.retrieval,
      sources: [
        projectSource(entry.project, item, {
          read: { ok: true, truncated: result.retrieval?.mode !== 'full' }
        })
      ].filter(Boolean)
    };
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * `knowledge_list`
 *
 * @param {{project?: string, user: Object, chatId?: string, appConfig: Object}} params
 */
export async function list(params) {
  try {
    const { all } = await scopeOf(params);
    const targets = pick(all, params.project);
    const ctx = ctxOf(params);
    const projects = [];
    for (const entry of targets) {
      const provider = providerFor(entry.project);
      const { items } = await provider.list(entry.project, ctx, { limit: 100 });
      projects.push({
        id: entry.project.id,
        name:
          typeof entry.project.name === 'string'
            ? entry.project.name
            : entry.project.name?.en || entry.project.id,
        mode: entry.mode,
        documents: items.map(doc => ({
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          status: doc.status,
          pinned: doc.pinned,
          tokens: doc.tokens,
          chars: doc.chars,
          origin: doc.provenance?.origin || 'linked',
          ...(doc.url ? { url: doc.url } : {}),
          ...(doc.snapshotAt ? { snapshotAt: doc.snapshotAt } : {})
        }))
      });
    }
    return { projects };
  } catch (error) {
    return errorResult(error);
  }
}
