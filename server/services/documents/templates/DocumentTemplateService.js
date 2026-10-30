// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getContentsPath } from '../../../utils/contentsPath.js';
import { atomicWriteFile, atomicWriteJSON } from '../../../utils/atomicWrite.js';
import { withFileLock } from '../../../utils/fileLock.js';
import { getLocalizedString } from '../../../utils/localize.js';
import logger from '../../../utils/logger.js';
import {
  ASSET_NAME_PATTERN,
  ASSET_SLOTS,
  FONT_FACES,
  TEMPLATE_ID_PATTERN,
  documentTemplateSchema,
  referencedAssets
} from '../../../validators/documentTemplateSchema.js';
import { checkTemplateAsset, TemplateAssetError } from './templateAssets.js';

/**
 * Document templates: a company's corporate design, applied to every PDF,
 * Word and PowerPoint file iHub generates — by the `pdf`, `docx` and `pptx`
 * system skills and by the PDF export.
 *
 * Storage: `contents/document-templates/<id>/template.json` plus the files it
 * names (logo, fonts, letterhead, Word and PowerPoint templates). Admins
 * manage them in Admin → Document templates; the files are checked on upload
 * (`templateAssets.js`).
 *
 * Which template a document gets (`resolveTemplateId`):
 * 1. the app's `documentTemplate`, when it names an enabled template — the
 *    app's documents then always look that way;
 * 2. otherwise the one the model or the user picked;
 * 3. otherwise the template marked as default;
 * 4. otherwise none: the built-in look.
 */

const COMPONENT = 'DocumentTemplates';
const DIR_NAME = 'document-templates';
const CONFIG_FILE = 'template.json';
const LIST_TTL_MS = 5000;
const ASSET_CACHE_BYTES = 150 * 1024 * 1024;

export class DocumentTemplateError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] - HTTP status for the admin API.
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'DocumentTemplateError';
    this.status = status;
  }
}

export function templatesDirectory() {
  return getContentsPath(DIR_NAME);
}

/**
 * A path inside a directory, refused when it would leave it. Ids and file
 * names are already restricted by their patterns; this is the boundary check
 * on top (the relative-path shape `utils/pathSecurity.js` uses).
 */
function inside(baseDir, name, message) {
  const base = path.resolve(baseDir);
  const relative = path.relative(base, path.resolve(base, name));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DocumentTemplateError(message);
  }
  return path.join(base, relative);
}

function templateDirectory(id) {
  if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) {
    throw new DocumentTemplateError('Invalid template id.');
  }
  return inside(templatesDirectory(), id, 'Invalid template id.');
}

function configPath(id) {
  return inside(templateDirectory(id), CONFIG_FILE, 'Invalid template id.');
}

function assetPath(id, name) {
  if (typeof name !== 'string' || !ASSET_NAME_PATTERN.test(name) || name === CONFIG_FILE) {
    throw new DocumentTemplateError('Invalid template file name.');
  }
  return inside(templateDirectory(id), name, 'Invalid template file name.');
}

let listCache = null;

function invalidate() {
  listCache = null;
}

async function readTemplateFile(id) {
  const file = configPath(id);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = documentTemplateSchema.safeParse({ ...JSON.parse(raw), id });
  if (!parsed.success) {
    logger.warn('Ignoring an invalid document template', {
      component: COMPONENT,
      templateId: id,
      issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`)
    });
    return null;
  }
  return parsed.data;
}

/**
 * Every valid template, sorted by id. Invalid ones are skipped with a warning.
 *
 * @param {Object} [options]
 * @param {boolean} [options.includeDisabled]
 * @returns {Promise<Object[]>}
 */
export async function listTemplates({ includeDisabled = false } = {}) {
  if (!listCache || listCache.expires < Date.now()) {
    let entries = [];
    try {
      entries = await fs.readdir(templatesDirectory(), { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const templates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TEMPLATE_ID_PATTERN.test(entry.name)) continue;
      try {
        const template = await readTemplateFile(entry.name);
        if (template) templates.push(template);
      } catch (error) {
        logger.warn('Could not read a document template', {
          component: COMPONENT,
          templateId: entry.name,
          error: error.message
        });
      }
    }
    templates.sort((a, b) => a.id.localeCompare(b.id));
    listCache = { templates, expires: Date.now() + LIST_TTL_MS };
  }
  return includeDisabled ? listCache.templates : listCache.templates.filter(t => t.enabled);
}

/**
 * One template, or null.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {boolean} [options.includeDisabled]
 * @returns {Promise<Object|null>}
 */
export async function getTemplate(id, { includeDisabled = false } = {}) {
  if (typeof id !== 'string' || !TEMPLATE_ID_PATTERN.test(id)) return null;
  const templates = await listTemplates({ includeDisabled });
  return templates.find(t => t.id === id) || null;
}

/**
 * The template a document gets (see the module comment).
 *
 * @param {Object} params
 * @param {Object} [params.app] - App config; its `documentTemplate` wins.
 * @param {string} [params.requested] - A template id the model or user
 *   picked; `default` means the default template.
 * @returns {Promise<{ id: string|null, pinned: boolean }>} `pinned` when the
 *   app fixes the template (nothing else may change it).
 */
export async function resolveTemplateId({ app, requested } = {}) {
  const templates = await listTemplates();
  const enabled = id => templates.some(t => t.id === id);
  if (typeof app?.documentTemplate === 'string' && enabled(app.documentTemplate)) {
    return { id: app.documentTemplate, pinned: true };
  }
  if (typeof requested === 'string' && requested !== 'default' && enabled(requested)) {
    return { id: requested, pinned: false };
  }
  return { id: templates.find(t => t.default)?.id || null, pinned: false };
}

/**
 * Templates for pickers (export dialog, the tools' `template` parameter).
 *
 * @param {string} [language]
 * @returns {Promise<Array<{ id: string, name: string, description: string, default: boolean }>>}
 */
export async function templateChoices(language = 'en') {
  return (await listTemplates()).map(t => ({
    id: t.id,
    name: getLocalizedString(t.name, language) || t.id,
    description: getLocalizedString(t.description, language) || '',
    default: Boolean(t.default)
  }));
}

/**
 * The document templates as the tools of the document skills see them in
 * an app: the one the app pins, or the choices.
 *
 * @param {Object} params
 * @param {Object} [params.app]
 * @param {string} [params.language]
 * @returns {Promise<{ pinned: { id: string, name: string } | null, choices: Array<Object>, defaultName: string|null }>}
 */
export async function documentTemplateContext({ app, language = 'en' } = {}) {
  const choices = await templateChoices(language);
  const pinned = app?.documentTemplate ? choices.find(c => c.id === app.documentTemplate) : null;
  return {
    pinned: pinned ? { id: pinned.id, name: pinned.name } : null,
    choices,
    defaultName: choices.find(c => c.default)?.name || null
  };
}

// --- Assets -------------------------------------------------------------------

/** Asset bytes by absolute path, checked against size and mtime. */
const assetCache = new Map();
let assetCacheBytes = 0;

async function readAsset(id, name) {
  const file = assetPath(id, name);
  const stat = await fs.stat(file);
  const cached = assetCache.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    assetCache.delete(file);
    assetCache.set(file, cached);
    return cached.data;
  }
  const data = await fs.readFile(file);
  // Another read of the same file may have cached it meanwhile.
  const previous = assetCache.get(file);
  if (previous) assetCacheBytes -= previous.size;
  assetCache.delete(file);
  assetCache.set(file, { data, mtimeMs: stat.mtimeMs, size: stat.size });
  assetCacheBytes += stat.size;
  for (const [key, entry] of assetCache) {
    if (assetCacheBytes <= ASSET_CACHE_BYTES) break;
    assetCache.delete(key);
    assetCacheBytes -= entry.size;
  }
  return data;
}

function extensionOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}

async function optionalAsset(template, name, label) {
  if (!name) return null;
  try {
    return { name, extension: extensionOf(name), data: await readAsset(template.id, name) };
  } catch (error) {
    logger.warn('A document template file is missing', {
      component: COMPONENT,
      templateId: template.id,
      file: name,
      role: label,
      error: error.message
    });
    return null;
  }
}

/**
 * A template with the files one output format needs.
 *
 * @param {string|Object} idOrTemplate - An enabled template's id, or a
 *   template itself (the admin's sample of a disabled one).
 * @param {'pdf'|'docx'|'pptx'} format
 * @returns {Promise<{ template: Object, assets: Object } | null>}
 */
export async function loadTemplateBundle(idOrTemplate, format) {
  const template =
    typeof idOrTemplate === 'object' && idOrTemplate
      ? idOrTemplate
      : idOrTemplate
        ? await getTemplate(idOrTemplate)
        : null;
  if (!template) return null;
  const assets = { logo: await optionalAsset(template, template.brand.logo, 'logo') };
  if (format === 'pdf') {
    assets.letterhead = await optionalAsset(template, template.pdf.letterhead, 'letterhead');
    assets.letterheadFollowing = await optionalAsset(
      template,
      template.pdf.letterheadFollowing,
      'letterheadFollowing'
    );
    const letterhead = assets.letterhead || assets.letterheadFollowing;
    if (letterhead) {
      // The page format the letterhead was made for, for templates that do
      // not set one.
      const { letterheadPageFormat } = await import('../pdf/letterhead.js');
      letterhead.pageFormat = await letterheadPageFormat(letterhead.data).catch(() => null);
    }
    assets.fonts = [];
    for (const font of template.fonts) {
      const faces = {};
      for (const face of FONT_FACES) {
        const file = await optionalAsset(template, font[face], `font ${font.family} ${face}`);
        if (file) faces[face] = file.data;
      }
      if (faces.normal) assets.fonts.push({ family: font.family, faces });
    }
  } else if (format === 'docx') {
    assets.wordTemplate = await optionalAsset(template, template.docx.template, 'wordTemplate');
  } else if (format === 'pptx') {
    assets.powerpointTemplate = await optionalAsset(
      template,
      template.pptx.template,
      'powerpointTemplate'
    );
  }
  return { template, assets };
}

// --- Admin writes -----------------------------------------------------------

function lockPath() {
  return path.join(templatesDirectory(), '.lock');
}

async function locked(fn) {
  await fs.mkdir(templatesDirectory(), { recursive: true });
  try {
    return await withFileLock(lockPath(), fn);
  } finally {
    invalidate();
  }
}

async function assetExists(id, name) {
  try {
    return (await fs.stat(assetPath(id, name))).isFile();
  } catch {
    return false;
  }
}

/** Clear `default` on every other template, read from disk under the lock. */
async function clearOtherDefaults(id) {
  for (const entry of await fs.readdir(templatesDirectory(), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === id || !TEMPLATE_ID_PATTERN.test(entry.name)) {
      continue;
    }
    const other = await readTemplateFile(entry.name);
    if (other?.default) await atomicWriteJSON(configPath(other.id), { ...other, default: false });
  }
}

/**
 * A template with the file references of the stored one. Files are only
 * ever set by the upload and remove calls; a settings save — perhaps from an
 * editor opened before an upload — never adds, drops or swaps them.
 */
function withStoredFiles(template, stored) {
  const next = structuredClone(template);
  const set = (section, key, value) => {
    if (value) next[section][key] = value;
    else delete next[section][key];
  };
  set('brand', 'logo', stored?.brand?.logo);
  set('pdf', 'letterhead', stored?.pdf?.letterhead);
  set('pdf', 'letterheadFollowing', stored?.pdf?.letterheadFollowing);
  set('docx', 'template', stored?.docx?.template);
  set('pptx', 'template', stored?.pptx?.template);
  next.fonts = stored?.fonts ? structuredClone(stored.fonts) : [];
  return next;
}

function validate(input, id) {
  const parsed = documentTemplateSchema.safeParse({ ...input, id });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DocumentTemplateError(
      `${issue.path.join('.') || 'template'}: ${issue.message}`.slice(0, 300)
    );
  }
  return parsed.data;
}

/**
 * Create or replace a template's settings. Files are uploaded and removed
 * separately (`saveTemplateAsset`, `removeTemplateAsset`); the file
 * references stay as stored.
 *
 * @param {string} id
 * @param {Object} input
 * @param {Object} [options]
 * @param {boolean} [options.create] - Fail when the template exists.
 * @returns {Promise<Object>} The saved template.
 */
export async function saveTemplate(id, input, { create = false } = {}) {
  const requested = validate(input, id);
  return locked(async () => {
    const dir = templateDirectory(id);
    const exists = await fs
      .stat(configPath(id))
      .then(() => true)
      .catch(() => false);
    if (create && exists) {
      throw new DocumentTemplateError(`A template "${id}" already exists.`, 409);
    }
    if (!create && !exists) throw new DocumentTemplateError('Template not found.', 404);
    const stored = exists ? await readTemplateFile(id) : null;
    // A stored file that does not parse keeps the references sent with the
    // save (the files are not removed for a typo in template.json).
    const template =
      exists && !stored ? requested : validate(withStoredFiles(requested, stored), id);
    for (const name of referencedAssets(template)) {
      if (!(await assetExists(id, name))) {
        throw new DocumentTemplateError(`The file "${name}" is not uploaded.`);
      }
    }
    await fs.mkdir(dir, { recursive: true });
    if (template.default) await clearOtherDefaults(id);
    await atomicWriteJSON(configPath(id), template);
    await removeUnusedAssets(id, template);
    logger.info(create ? 'Document template created' : 'Document template saved', {
      component: COMPONENT,
      templateId: id
    });
    return template;
  });
}

async function removeUnusedAssets(id, template) {
  const used = new Set([CONFIG_FILE, ...referencedAssets(template)]);
  const dir = templateDirectory(id);
  for (const name of await fs.readdir(dir)) {
    if (used.has(name) || !ASSET_NAME_PATTERN.test(name)) continue;
    await fs.rm(assetPath(id, name), { force: true });
  }
}

/**
 * Delete a template and its files.
 *
 * @param {string} id
 */
export async function deleteTemplate(id) {
  await locked(async () => {
    const dir = templateDirectory(id);
    try {
      await fs.stat(configPath(id));
    } catch {
      throw new DocumentTemplateError('Template not found.', 404);
    }
    await fs.rm(dir, { recursive: true, force: true });
    logger.info('Document template deleted', { component: COMPONENT, templateId: id });
  });
}

/**
 * The file name prefix of a font family's files: the one its regular style
 * already has, else a new one no other family uses (family names that slug
 * alike, or that have no Latin letters, get a number).
 */
function fontFilePrefix(fonts, entry, family) {
  if (entry?.normal) return entry.normal.replace(/-normal\.[a-z]+$/, '');
  const taken = new Set(fonts.map(font => font.normal?.replace(/-normal\.[a-z]+$/, '')));
  const base = `font-${fontSlug(family)}`;
  let prefix = base;
  for (let n = 2; taken.has(prefix); n += 1) prefix = `${base}-${n}`;
  return prefix;
}

function fontSlug(family) {
  const words = family
    .toLowerCase()
    .normalize('NFKD')
    .split(/[^a-z0-9]/)
    .filter(Boolean);
  return words.join('-').slice(0, 40) || 'font';
}

/**
 * Store an uploaded file in a template slot and point the template at it.
 *
 * @param {string} id
 * @param {Object} params
 * @param {string} params.slot - A key of `ASSET_SLOTS`.
 * @param {Buffer} params.data
 * @param {string} params.originalName - For the extension.
 * @param {string} [params.family] - Font slot: the family name.
 * @param {string} [params.face] - Font slot: `normal`, `bold`, `italics`, `bolditalics`.
 * @returns {Promise<{ template: Object, file: string, info: Object }>}
 */
export async function saveTemplateAsset(id, { slot, data, originalName, family, face }) {
  const extension = extensionOf(String(originalName || ''));
  let info;
  try {
    info = await checkTemplateAsset(slot, data, extension);
  } catch (error) {
    if (error instanceof TemplateAssetError) throw new DocumentTemplateError(error.message);
    throw error;
  }
  return locked(async () => {
    const current = await readTemplateFile(id);
    if (!current) throw new DocumentTemplateError('Template not found.', 404);
    const next = structuredClone(current);
    let name;
    if (slot === 'font') {
      const familyName = String(family || info.familyName || '').trim();
      if (!familyName) throw new DocumentTemplateError('Name the font family.');
      if (!FONT_FACES.includes(face)) throw new DocumentTemplateError('Unknown font style.');
      const entry = next.fonts.find(f => f.family.toLowerCase() === familyName.toLowerCase());
      if (!entry && face !== 'normal') {
        throw new DocumentTemplateError('Upload the regular style of a font first.');
      }
      name = `${fontFilePrefix(next.fonts, entry, familyName)}-${face}.${extension}`;
      if (entry) entry[face] = name;
      else next.fonts.push({ family: familyName, normal: name });
    } else {
      name = `${ASSET_SLOTS[slot].baseName}.${extension}`;
      if (slot === 'logo') next.brand.logo = name;
      else if (slot === 'letterhead') next.pdf.letterhead = name;
      else if (slot === 'letterheadFollowing') next.pdf.letterheadFollowing = name;
      else if (slot === 'wordTemplate') next.docx.template = name;
      else if (slot === 'powerpointTemplate') next.pptx.template = name;
    }
    const template = validate(next, id);
    await atomicWriteFile(assetPath(id, name), data, null);
    await atomicWriteJSON(configPath(id), template);
    await removeUnusedAssets(id, template);
    logger.info('Document template file uploaded', {
      component: COMPONENT,
      templateId: id,
      slot,
      file: name,
      bytes: data.length
    });
    return { template, file: name, info };
  });
}

/**
 * Remove a file from a template slot.
 *
 * @param {string} id
 * @param {Object} params
 * @param {string} params.slot
 * @param {string} [params.family] - Font slot.
 * @param {string} [params.face] - Font slot; `normal` removes the family.
 * @returns {Promise<Object>} The template.
 */
export async function removeTemplateAsset(id, { slot, family, face }) {
  return locked(async () => {
    const current = await readTemplateFile(id);
    if (!current) throw new DocumentTemplateError('Template not found.', 404);
    const next = structuredClone(current);
    if (slot === 'font') {
      const index = next.fonts.findIndex(
        f => f.family.toLowerCase() === String(family || '').toLowerCase()
      );
      if (index < 0) throw new DocumentTemplateError('Font not found.', 404);
      if (face === 'normal' || !face) next.fonts.splice(index, 1);
      else delete next.fonts[index][face];
    } else if (slot === 'logo') delete next.brand.logo;
    else if (slot === 'letterhead') delete next.pdf.letterhead;
    else if (slot === 'letterheadFollowing') delete next.pdf.letterheadFollowing;
    else if (slot === 'wordTemplate') delete next.docx.template;
    else if (slot === 'powerpointTemplate') {
      delete next.pptx.template;
      delete next.pptx.layouts;
    } else throw new DocumentTemplateError(`Unknown template file slot "${slot}".`);
    const template = validate(next, id);
    await atomicWriteJSON(configPath(id), template);
    await removeUnusedAssets(id, template);
    return template;
  });
}

/**
 * Bytes of a template file, for the admin page (logo preview, re-analysis).
 *
 * @param {string} id
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
export async function readTemplateAsset(id, name) {
  const template = await getTemplate(id, { includeDisabled: true });
  if (!template || !referencedAssets(template).includes(name)) {
    throw new DocumentTemplateError('File not found.', 404);
  }
  return readAsset(id, name);
}

/** Forget cached lists and files (tests). */
export function clearTemplateCaches() {
  invalidate();
  assetCache.clear();
  assetCacheBytes = 0;
}
