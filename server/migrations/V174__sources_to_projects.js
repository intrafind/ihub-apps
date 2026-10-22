// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V174 — Sources become admin projects (#1036, spec 1 §10.1)
 *
 * Every entry of `config/sources.json` becomes `projects/<id>.json` with the
 * same id and one item of the source's kind: a filesystem source an `upload`
 * item the startup import extracts and encrypts (`import: { file }`), a URL,
 * page or iFinder source a link item. The `sources` lists on apps, workflows
 * (top level, nodes and planner task templates) and agent profiles become
 * `projects` links whose mode keeps the old behaviour (`exposeAs: prompt` →
 * `context`, `exposeAs: tool` → `tools`); `{{sources}}` becomes
 * `{{projects}}`; `source_<id>` tool entries go, the knowledge tools are
 * offered at runtime. The `sources` feature flag and admin page carry over
 * to `projects`, and `config/sources.json` is kept as
 * `config/sources.json.migrated`.
 *
 * A source id starting with `prj_` would collide with the user-project
 * namespace: it is remapped to `legacy-<id>` everywhere, and logged.
 *
 * Idempotent per file: a project that already exists is not overwritten, a
 * document without `sources` is left alone.
 */
import crypto from 'node:crypto';

export const version = '174';
export const description = 'sources_to_projects';

const SOURCES_FILE = 'config/sources.json';
const MIGRATED_FILE = 'config/sources.json.migrated';
const NOW = () => new Date().toISOString();

/** The deterministic item id of a migrated source. */
export function itemIdForSource(sourceId) {
  return `itm_${crypto.createHash('sha256').update(String(sourceId)).digest('hex').slice(0, 12)}`;
}

const MAX_PROJECT_ID_LENGTH = 50;

function hashOf(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Whether a source id can stay the project id: it must not look like a user
 * project (`prj_` is reserved, spec 1 §2) and must fit the admin id limit.
 */
function keepsId(sourceId) {
  return !sourceId.startsWith('prj_') && sourceId.length <= MAX_PROJECT_ID_LENGTH;
}

/**
 * The project id a source id becomes on its own: kept when it may be,
 * otherwise `legacy-<id>` when that fits, otherwise `legacy-<hash>`.
 */
export function projectIdForSource(sourceId) {
  const id = String(sourceId);
  if (keepsId(id)) return id;
  const prefixed = `legacy-${id}`;
  return prefixed.length <= MAX_PROJECT_ID_LENGTH ? prefixed : `legacy-${hashOf(id)}`;
}

/**
 * Deterministic, collision-free project ids for a whole source set, decided
 * before any file is written: a remapped id that another source already
 * occupies falls back to `legacy-<hash>`.
 *
 * @param {Array<{id?: string}>} sources
 * @returns {Map<string, string>} source id → project id
 */
export function projectIdsForSources(sources) {
  const ids = [];
  for (const source of sources) {
    if (typeof source?.id === 'string' && source.id && !ids.includes(source.id))
      ids.push(source.id);
  }
  const taken = new Set(ids.filter(keepsId));
  const map = new Map();
  for (const id of ids) {
    if (keepsId(id)) {
      map.set(id, id);
      continue;
    }
    let candidate = projectIdForSource(id);
    if (taken.has(candidate)) candidate = `legacy-${hashOf(id)}`;
    taken.add(candidate);
    map.set(id, candidate);
  }
  return map;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function actor() {
  return { id: 'system', name: 'Sources migration' };
}

/**
 * The item a source turns into, or null for a type nothing maps.
 *
 * @param {Object} source
 * @param {string} now
 * @returns {Object|null}
 */
export function itemFromSource(source, now = NOW()) {
  const config = source.config || {};
  const base = {
    id: itemIdForSource(source.id),
    pinned: false,
    error: null,
    snapshotAt: null,
    createdAt: source.created || now,
    updatedAt: now
  };
  const linked = extra => ({
    origin: 'linked',
    by: actor(),
    at: now,
    run: null,
    source: extra
  });
  switch (source.type) {
    case 'filesystem': {
      const file = String(config.path || '');
      const item = {
        ...base,
        kind: 'upload',
        name: file.split('/').pop() || source.id,
        ref: { contentType: 'text/markdown' },
        storage: 'text',
        status: 'pending',
        provenance: { origin: 'migrated', by: actor(), at: now, run: null, source: null }
      };
      if (source.id === 'ihub-documentation') item.managedFile = file;
      else item.import = { file, encoding: config.encoding || 'utf-8' };
      return item;
    }
    case 'url': {
      const ref = { url: String(config.url || '') };
      if (Number.isFinite(Number(config.maxContentLength)) && Number(config.maxContentLength) > 0) {
        ref.maxContentLength = Number(config.maxContentLength);
      }
      const ttl = Number(source.caching?.ttl) > 0 ? Number(source.caching.ttl) : 7200;
      return {
        ...base,
        kind: 'url',
        name: ref.url,
        ref,
        storage: 'link',
        status: 'ready',
        cache: { ttlSeconds: ttl },
        provenance: linked({ site: hostOf(ref.url), url: ref.url })
      };
    }
    case 'page': {
      const ref = { pageId: String(config.pageId || ''), language: config.language || 'en' };
      const url =
        ref.language === 'en' ? `/pages/${ref.pageId}` : `/${ref.language}/pages/${ref.pageId}`;
      return {
        ...base,
        kind: 'page',
        name: ref.pageId,
        ref,
        storage: 'link',
        status: 'ready',
        cache: { ttlSeconds: 7200 },
        provenance: linked({ site: 'iHub', url })
      };
    }
    case 'ifinder': {
      const common = {};
      if (config.searchProfile) common.searchProfile = String(config.searchProfile);
      if (Number(config.maxLength) > 0) common.maxLength = Number(config.maxLength);
      if (config.documentId) {
        return {
          ...base,
          kind: 'ifinder-document',
          name: String(config.documentId),
          ref: { documentId: String(config.documentId), ...common },
          storage: 'link',
          status: 'ready',
          cache: { ttlSeconds: 7200 },
          provenance: linked({ site: 'iFinder' })
        };
      }
      const ref = { query: String(config.query || ''), ...common };
      if (Number(config.maxResults) > 0) ref.maxResults = Number(config.maxResults);
      return {
        ...base,
        kind: 'ifinder-query',
        name: ref.query || 'iFinder search',
        ref,
        storage: 'link',
        status: 'ready',
        cache: { ttlSeconds: 7200 },
        provenance: linked({ site: 'iFinder' })
      };
    }
    default:
      return null;
  }
}

/**
 * The admin project document of a source.
 *
 * @param {Object} source
 * @param {string} [now]
 * @returns {{project: Object, item: Object|null}}
 */
export function projectFromSource(source, now = NOW()) {
  const item = itemFromSource(source, now);
  return {
    item,
    project: {
      version: 1,
      id: projectIdForSource(source.id),
      ownership: 'admin',
      tier: 'ihub',
      name: source.name || { en: source.id },
      description: source.description || {},
      instructions: '',
      enabled: source.enabled !== false,
      category: typeof source.category === 'string' ? source.category : '',
      tags: Array.isArray(source.tags) ? source.tags : [],
      items: item ? [item] : [],
      createdAt: source.created || now,
      updatedAt: source.updated || now,
      createdBy: null
    }
  };
}

function replacePlaceholders(value) {
  if (typeof value === 'string') return value.replace(/\{\{sources?\}\}/g, '{{projects}}');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [key, text] of Object.entries(value)) out[key] = replacePlaceholders(text);
    return out;
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rewrite one document in place: `sources` → `projects`, placeholders,
 * `source_*` tools. Returns whether anything changed.
 */
function rewriteDocument(doc, modeOf, idOf, ctx, label, { textFields = ['system'] } = {}) {
  if (!doc || typeof doc !== 'object') return false;
  const before = JSON.stringify(doc);
  if (Array.isArray(doc.sources)) {
    const links = doc.sources
      .filter(id => typeof id === 'string' && id)
      .map(id => {
        const mode = modeOf(id);
        if (!mode)
          ctx.warn(`${label}: source "${id}" is not in config/sources.json — linked in auto mode`);
        return { id: idOf(id), mode: mode || 'auto', write: false };
      });
    const existing = Array.isArray(doc.projects) ? doc.projects : [];
    const known = new Set(existing.map(link => (typeof link === 'string' ? link : link?.id)));
    doc.projects = [...existing, ...links.filter(link => !known.has(link.id))];
    delete doc.sources;
  }
  if (doc.sourceSupplements !== undefined) {
    ctx.warn(`${label}: legacy sourceSupplements dropped`);
    delete doc.sourceSupplements;
  }
  for (const field of textFields) {
    if (doc[field] !== undefined) doc[field] = replacePlaceholders(doc[field]);
  }
  if (Array.isArray(doc.tools)) {
    doc.tools = doc.tools.filter(
      tool =>
        !(typeof tool === 'string' && tool.startsWith('source_')) &&
        !(tool?.id && String(tool.id).startsWith('source_'))
    );
  }
  return JSON.stringify(doc) !== before;
}

async function eachFile(ctx, directory, fn) {
  let files = [];
  try {
    files = await ctx.listFiles(directory, '*.json');
  } catch {
    return;
  }
  for (const file of files) {
    const relPath = `${directory}/${file}`;
    let doc;
    try {
      doc = await ctx.readJson(relPath);
    } catch (error) {
      ctx.warn(`Skipping ${relPath}: ${error.message}`);
      continue;
    }
    const changed = await fn(doc, relPath);
    if (changed) await ctx.writeJson(relPath, doc);
  }
}

function hasSourcesKey(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (Array.isArray(doc.sources)) return true;
  if (Array.isArray(doc.nodes)) {
    return doc.nodes.some(
      node =>
        Array.isArray(node?.config?.sources) || Array.isArray(node?.config?.taskTemplate?.sources)
    );
  }
  return false;
}

export async function precondition(ctx) {
  if (await ctx.fileExists(SOURCES_FILE)) return true;
  for (const directory of ['apps', 'workflows', 'agents/profiles']) {
    let files = [];
    try {
      files = await ctx.listFiles(directory, '*.json');
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        if (hasSourcesKey(await ctx.readJson(`${directory}/${file}`))) return true;
      } catch {
        // Unreadable here; up() skips it with a warning.
      }
    }
  }
  return false;
}

/**
 * Whether `relPath` holds exactly the shipped default: the default copy runs
 * before the migrations, so on an upgrade a project file identical to
 * `server/defaults/projects/<id>.json` was written moments ago by that copy,
 * not kept by an admin, and the admin's source of the same id must win.
 *
 * @param {Object} ctx
 * @param {string} relPath
 * @returns {Promise<boolean>}
 */
async function isSeededDefault(ctx, relPath) {
  if (typeof ctx.readDefaultJson !== 'function') return false;
  let shipped;
  let existing;
  try {
    shipped = await ctx.readDefaultJson(relPath);
    existing = await ctx.readJson(relPath);
  } catch {
    return false;
  }
  return JSON.stringify(existing) === JSON.stringify(shipped);
}

export async function up(ctx) {
  const now = NOW();
  let sources = [];
  if (await ctx.fileExists(SOURCES_FILE)) {
    const raw = await ctx.readJson(SOURCES_FILE);
    sources = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [];
  }

  // Preflight: ids that would collide with user projects or exceed the admin
  // id limit are remapped for the whole set before anything is written.
  const ids = projectIdsForSources(sources);
  const idOf = id => ids.get(id) || projectIdForSource(id);
  for (const [sourceId, projectId] of ids) {
    if (sourceId !== projectId) {
      ctx.log(
        `Source "${sourceId}" is remapped to "${projectId}" (the prj_ prefix belongs to user projects and ids are at most ${MAX_PROJECT_ID_LENGTH} characters)`
      );
    }
  }
  const modes = new Map();
  for (const source of sources) {
    if (typeof source?.id !== 'string' || !source.id) continue;
    modes.set(source.id, source.exposeAs === 'tool' ? 'tools' : 'context');
  }
  const modeOf = id => modes.get(id) || null;

  // 1. Sources become admin projects.
  let created = 0;
  for (const source of sources) {
    if (typeof source?.id !== 'string' || !source.id) continue;
    const { project, item } = projectFromSource(source, now);
    project.id = idOf(source.id);
    const relPath = `projects/${project.id}.json`;
    if (await ctx.fileExists(relPath)) {
      if (await isSeededDefault(ctx, relPath)) {
        ctx.log(
          `Project ${project.id} is the shipped default seeded on this start — replaced by the converted source "${source.id}"`
        );
      } else {
        ctx.log(`Project ${project.id} already exists — not overwritten`);
        continue;
      }
    }
    if (!item)
      ctx.warn(
        `Source "${source.id}" has the unknown type "${source.type}" — the project has no item`
      );
    await ctx.writeJson(relPath, project);
    created += 1;
  }
  if (created) ctx.log(`Created ${created} admin project(s) from config/sources.json`);

  // 2–4. Links, placeholders and tool lists on apps, workflows and profiles.
  let rewritten = 0;
  await eachFile(ctx, 'apps', (app, relPath) => {
    const changed = rewriteDocument(app, modeOf, idOf, ctx, relPath, { textFields: ['system'] });
    if (changed) rewritten += 1;
    return changed;
  });
  await eachFile(ctx, 'workflows', (workflow, relPath) => {
    let changed = rewriteDocument(workflow, modeOf, idOf, ctx, relPath, { textFields: [] });
    for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
      if (!node?.config || typeof node.config !== 'object') continue;
      const label = `${relPath} node ${node.id}`;
      if (
        rewriteDocument(node.config, modeOf, idOf, ctx, label, {
          textFields: ['system', 'prompt', 'instructions']
        })
      ) {
        changed = true;
      }
      const template = node.config.taskTemplate;
      if (
        template &&
        typeof template === 'object' &&
        rewriteDocument(template, modeOf, idOf, ctx, `${label} taskTemplate`, {
          textFields: ['system']
        })
      ) {
        changed = true;
      }
    }
    if (changed) rewritten += 1;
    return changed;
  });
  await eachFile(ctx, 'agents/profiles', (profile, relPath) => {
    const changed = rewriteDocument(profile, modeOf, idOf, ctx, relPath, {
      textFields: ['system']
    });
    if (changed) rewritten += 1;
    return changed;
  });
  if (rewritten)
    ctx.log(`Rewrote sources → projects on ${rewritten} app, workflow and profile file(s)`);

  // 5. The feature flag and the admin page.
  if (await ctx.fileExists('config/features.json')) {
    const features = await ctx.readJson('config/features.json');
    if (features && typeof features === 'object' && features.sources !== undefined) {
      if (features.projects === undefined) features.projects = features.sources;
      delete features.sources;
      await ctx.writeJson('config/features.json', features);
      ctx.log('features.json: sources → projects');
    }
  }
  if (await ctx.fileExists('config/platform.json')) {
    const platform = await ctx.readJson('config/platform.json');
    const pages = platform?.admin?.pages;
    if (pages && typeof pages === 'object' && pages.sources !== undefined) {
      const before = JSON.stringify(platform);
      if (pages.projects === undefined) pages.projects = pages.sources;
      delete pages.sources;
      if (!sameJson(before, JSON.stringify(platform))) {
        await ctx.writeJson('config/platform.json', platform);
        ctx.log('platform.json: admin.pages.sources → admin.pages.projects');
      }
    }
  }

  // 6. Retire the file.
  if (await ctx.fileExists(SOURCES_FILE)) {
    if (await ctx.fileExists(MIGRATED_FILE)) await ctx.deleteFile(MIGRATED_FILE);
    await ctx.moveFile(SOURCES_FILE, MIGRATED_FILE);
    ctx.log(
      `Moved ${SOURCES_FILE} to ${MIGRATED_FILE}; the files under contents/sources/ are imported at the next start and removed once their project item is ready`
    );
  }
}
