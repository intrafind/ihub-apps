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
 * The hits become `Source`s of provider `project`, so the sources panel shows
 * them with their provenance and offers Preview and Download
 * (`services/sources/providers/project.js`): `knowledge_read` carries them in
 * a `sources` envelope, `knowledge_search` reports them beside its result
 * (`services/sources/toolCallScope.js`), so the passages it returns are not
 * repeated for the model. A search numbers its passages for the whole answer
 * (`s:N`, cited as `<cite type="s">N</cite>`, `shared/sources/citations.js`).
 *
 * @module tools/knowledge
 */
import { resolveProjectScope } from '../services/knowledge/ProjectScope.js';
import { providerFor } from '../services/knowledge/registry.js';
import { KnowledgeError } from '../services/knowledge/types.js';
import { projectSource } from '../services/sources/producers/project.js';
import {
  allocatePassageMarkers,
  reportToolCallSources
} from '../services/sources/toolCallScope.js';
import { RESULT_BUDGET_CHARS } from '../sources/documentRetrieval.js';

const MAX_LIMIT = 20;

/**
 * Most bytes a search result serializes to. Below the loop's 64 KiB spill
 * threshold with room to spare, like {@link RESULT_BUDGET_CHARS} for text.
 */
const PAYLOAD_BUDGET_BYTES = RESULT_BUDGET_CHARS;

/**
 * What a read reserves beside its text for the retrieval details (the
 * section ids it returned), and how often it narrows the text when the
 * result still came out over the budget.
 */
const READ_ROOM_BYTES = 1024;
const READ_ATTEMPTS = 3;

/** What a read of a document its source cut short tells the model. */
const SOURCE_TRUNCATED_NOTE =
  'The source of this document handed over only its beginning (its length limit), so this ' +
  'is not the whole document and no section or search reaches the rest. Say so when the ' +
  'answer may depend on the missing part.';

/** What a read of an iFinder search that could not fetch some documents tells the model. */
const SOURCE_FAILED_NOTE =
  'Some documents this search found could not be loaded from their source, so they are ' +
  'missing from this text; it is not the complete result. Say so when the answer may ' +
  'depend on them.';

/** The note a read's source completeness calls for, or null. */
function sourceNote(retrieval) {
  const notes = [];
  if (retrieval?.sourceTruncated) notes.push(SOURCE_TRUNCATED_NOTE);
  if (retrieval?.sourceFailed > 0) notes.push(SOURCE_FAILED_NOTE);
  return notes.length ? notes.join(' ') : null;
}

/** What the note and a passage number may take, reserved before they are known. */
const NOTE_ROOM = 'x'.repeat(200);
const MARKER_ROOM = 999999;

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** One hit as the model reads it, numbered `n`. */
function hitOf({ hit, project }, n) {
  return {
    n,
    document: hit.docId,
    project: project.id,
    name: hit.name,
    section: hit.sectionId,
    path: hit.path.join(' › '),
    part: hit.part,
    score: hit.score,
    text: hit.text
  };
}

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
    const gathered = [];
    const unavailable = [];
    const retrieval = [];
    for (const entry of targets) {
      const provider = providerFor(entry.project);
      // Each project may fill the whole limit and budget: the shared cap is
      // applied once the hits of every project are ranked together, so the
      // passages of a project that matches are not dropped for the room an
      // unrelated attached project leaves unused.
      const found = await provider.search(entry.project, ctx, {
        query,
        limit,
        budgetChars: RESULT_BUDGET_CHARS
      });
      for (const hit of found.hits) gathered.push({ hit, project: entry.project });
      for (const u of found.unavailable) unavailable.push({ ...u, project: entry.project.id });
      retrieval.push({ project: entry.project.id, ...found.retrieval });
    }
    gathered.sort((a, b) => b.hit.score - a.hit.score);
    const result = {
      hits: [],
      unavailable,
      retrieval: { mode: 'search', query, projects: retrieval },
      note: ''
    };
    // The whole serialized result stays within the budget, in bytes: the
    // loop replaces a larger tool result with a short preview, which would
    // drop every hit past it. The citation data (snippets, passages) goes to
    // the sources beside the result, so the model reads each passage once.
    const room = PAYLOAD_BUDGET_BYTES - jsonBytes({ ...result, note: NOTE_ROOM });
    const selected = [];
    let used = 0;
    for (const entry of gathered) {
      if (selected.length >= limit) break;
      const bytes = jsonBytes(hitOf(entry, MARKER_ROOM)) + 1;
      if (used + bytes > room) continue;
      used += bytes;
      selected.push(entry);
    }
    // Passage numbers run on across the answer's searches, so a citation
    // names one passage even when several searches found different ones.
    const first = allocatePassageMarkers(selected.length);
    result.hits = selected.map((entry, index) => hitOf(entry, first + index));
    result.note =
      result.hits.length === 0
        ? 'No passage matches. Try other keywords, or list the documents with knowledge_list and read one with knowledge_read.'
        : `Cite a passage with its number n in a cite tag, e.g. <cite type="s">${result.hits[0].n}</cite> for the first hit.`;
    reportToolCallSources(
      result.hits
        .map((hit, index) => {
          const project = selected[index].project;
          const item = (project.items || []).find(entry => entry.id === hit.document);
          return projectSource(project, item, {
            snippet: hit.text,
            passages: [{ text: hit.text.slice(0, 4000), marker: `s:${hit.n}` }],
            // Also as a marker of the source: two searches that return the
            // same passage number it twice, and merging keeps only the first
            // passage of one text, while markers merge on their own.
            markers: [`s:${hit.n}`]
          });
        })
        .filter(Boolean)
    );
    return result;
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
    const item = (entry.project.items || []).find(candidate => candidate.id === documentId);
    const respond = result => ({
      document: documentId,
      project: entry.project.id,
      name: result.doc.name,
      content: result.text,
      retrieval: result.retrieval,
      ...(sourceNote(result.retrieval) ? { note: sourceNote(result.retrieval) } : {}),
      sources: [
        projectSource(entry.project, item, {
          read: {
            ok: true,
            truncated:
              result.retrieval?.mode !== 'full' ||
              result.retrieval?.sourceTruncated === true ||
              result.retrieval?.sourceFailed > 0
          }
        })
      ].filter(Boolean)
    });
    // The whole serialized result stays within the budget, in bytes, like a
    // search: the loop replaces a larger tool result with a short preview,
    // and a document that is short in characters can be long in bytes. The
    // text gets what the envelope leaves; a document over it is outlined and
    // read in sections, each naming the id it continues at.
    const envelope = jsonBytes(
      respond({
        doc: { name: item?.name || '' },
        text: '',
        retrieval: { mode: 'full', sourceTruncated: true, sourceFailed: 999 }
      })
    );
    let budgetBytes = PAYLOAD_BUDGET_BYTES - envelope - READ_ROOM_BYTES;
    let response;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const result = await provider.read(
        entry.project,
        ctxOf(params),
        { itemId: documentId },
        {
          section: typeof params.section === 'string' ? params.section : undefined,
          budgetBytes
        }
      );
      response = respond(result);
      const over = jsonBytes(response) - PAYLOAD_BUDGET_BYTES;
      if (over <= 0) break;
      budgetBytes -= over + READ_ROOM_BYTES;
    }
    return response;
  } catch (error) {
    return errorResult(error);
  }
}

/** A document as `knowledge_list` reports it. */
function listedDoc(doc) {
  return {
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
  };
}

/** Documents asked of a provider per page while listing. */
const LIST_PAGE = 100;

/**
 * Where a listing continues: the project (its index in the call's scope),
 * the provider's own cursor of the page it stopped in, and how many
 * documents of that page were already returned. Opaque to the model.
 */
function encodeListCursor(position) {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeListCursor(value) {
  if (typeof value !== 'string' || !value) return { project: 0, page: null, skip: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const project = Number.isInteger(parsed?.project) && parsed.project >= 0 ? parsed.project : 0;
    const skip = Number.isInteger(parsed?.skip) && parsed.skip >= 0 ? parsed.skip : 0;
    const page = typeof parsed?.page === 'string' ? parsed.page : null;
    return { project, page, skip };
  } catch {
    throw new KnowledgeError('INVALID_REF', 'The cursor is not one knowledge_list returned');
  }
}

/**
 * `knowledge_list`
 *
 * One page of the scope's documents, project after project, within the
 * same serialized byte budget as a search: the loop replaces a larger tool
 * result with a short preview, which would hide every document id past it.
 * A page that stops early says where to continue (`nextCursor`).
 *
 * @param {{project?: string, cursor?: string, user: Object, chatId?: string, appConfig: Object}} params
 */
export async function list(params) {
  try {
    const { all } = await scopeOf(params);
    const targets = pick(all, params.project);
    const ctx = ctxOf(params);
    const start = decodeListCursor(params.cursor);
    const projects = [];
    let nextCursor = null;
    let returned = 0;
    let used = jsonBytes({ projects: [], nextCursor: encodeListCursor(start), note: NOTE_ROOM });
    scan: for (let index = start.project; index < targets.length; index++) {
      const entry = targets[index];
      const provider = providerFor(entry.project);
      const listed = {
        id: entry.project.id,
        name:
          typeof entry.project.name === 'string'
            ? entry.project.name
            : entry.project.name?.en || entry.project.id,
        mode: entry.mode,
        documents: []
      };
      let page = index === start.project ? start.page : null;
      let skip = index === start.project ? start.skip : 0;
      const headerBytes = jsonBytes(listed) + 1;
      if (returned > 0 && used + headerBytes > PAYLOAD_BUDGET_BYTES) {
        nextCursor = encodeListCursor({ project: index, page, skip });
        break;
      }
      used += headerBytes;
      projects.push(listed);
      do {
        const { items, nextCursor: following } = await provider.list(entry.project, ctx, {
          cursor: page,
          limit: LIST_PAGE
        });
        for (let at = skip; at < items.length; at++) {
          const doc = listedDoc(items[at]);
          const bytes = jsonBytes(doc) + 1;
          // At least one document per page, so a listing always moves on.
          if (returned > 0 && used + bytes > PAYLOAD_BUDGET_BYTES) {
            nextCursor = encodeListCursor({ project: index, page, skip: at });
            break scan;
          }
          used += bytes;
          returned += 1;
          listed.documents.push(doc);
        }
        page = following || null;
        skip = 0;
      } while (page);
    }
    return nextCursor
      ? {
          projects,
          nextCursor,
          note: 'More documents follow: call knowledge_list again with cursor set to nextCursor.'
        }
      : { projects };
  } catch (error) {
    return errorResult(error);
  }
}
