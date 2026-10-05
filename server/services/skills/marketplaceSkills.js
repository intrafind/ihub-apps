/**
 * Skills from the marketplace, for users.
 *
 * Admins install marketplace skills for everyone (`ContentInstaller`). Users
 * may also browse the skills the configured registries offer and copy one into
 * their own skills, so a skill only a few people want does not have to be
 * installed for everybody. The copy is an ordinary user skill: private until
 * shared, editable, versioned, and independent of the catalog from then on.
 *
 * Users never name a URL. They pick a registry id and a catalog item name, and
 * the item is fetched from the source the admin-configured catalog lists, with
 * the registry's own credentials — the same fetch as an admin install. Only
 * enabled registries with a fetched catalog are offered; users cannot refresh
 * a catalog.
 *
 * What reaches the user skill is what a user skill can hold: the `SKILL.md`
 * instructions and text files one folder deep (`references/`, `assets/`,
 * `scripts/`), within the file and size limits of `platform.userSkills`. Every
 * other file is left out and reported back, so the user knows.
 *
 * @module services/skills/marketplaceSkills
 */
import registryService from '../marketplace/RegistryService.js';
import { fetchItemContent } from '../marketplace/ContentInstaller.js';
import { parseFrontMatter } from '../../utils/frontMatter.js';
import logger from '../../utils/logger.js';
import { SKILL_FILE_PATH_PATTERN, SKILL_NAME_PATTERN } from '../../validators/userSkillSchema.js';

const COMPONENT = 'MarketplaceSkills';

/** Items per page when the caller asks for none, and the most it may ask for. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

/** Longest description a skill may have (Agent Skills rule). */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Longest skill name (Agent Skills rule). */
const MAX_NAME_LENGTH = 64;

/** Why a file of a marketplace skill was left out of the user's copy. */
export const SKIPPED_REASONS = Object.freeze({
  unsupported: 'unsupported',
  fileLimit: 'fileLimit',
  sizeLimit: 'sizeLimit'
});

/**
 * A refusal with the HTTP status and `details.code` the routes send.
 */
export class MarketplaceSkillError extends Error {
  constructor(message, { status = 400, code = 'MARKETPLACE_SKILL_ERROR' } = {}) {
    super(message);
    this.name = 'MarketplaceSkillError';
    this.status = status;
    this.code = code;
  }
}

function notFound() {
  return new MarketplaceSkillError('Skill not found in the marketplace', {
    status: 404,
    code: 'MARKETPLACE_SKILL_NOT_FOUND'
  });
}

/**
 * Whether an enabled registry has a fetched catalog — what "the marketplace
 * has something to offer" means. Reads the registry list only, never a catalog.
 *
 * @param {{registries?: Array<Object>}|null|undefined} registriesData - `config/registries.json`.
 * @returns {boolean}
 */
export function hasSyncedRegistry(registriesData) {
  const registries = Array.isArray(registriesData?.registries) ? registriesData.registries : [];
  return registries.some(registry => registry?.enabled && registry.lastSynced);
}

/** Whether a string is a valid user skill name. */
function isSkillName(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_NAME_LENGTH &&
    SKILL_NAME_PATTERN.test(value) &&
    !value.includes('--')
  );
}

/**
 * A valid skill name made from any string: lowercase, hyphens for everything
 * else, no doubled or edge hyphens.
 */
function toSkillName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-$/, '');
}

/** Every text a localized catalog field holds: a string, or `{ en, de, … }`. */
function localizedTexts(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    return Object.values(value).filter(text => typeof text === 'string');
  }
  return [];
}

/** The English text of a localized catalog field, else its first one. */
function englishText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.en === 'string') return value.en;
  return localizedTexts(value)[0] || '';
}

/** A localized catalog field as the client gets it: a string or `{ lang: text }`. */
function localizedView(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, text]) => typeof text === 'string');
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The enabled registries, with their redacted config. A registry that is
 * switched off is not offered, and its items cannot be added.
 */
async function enabledRegistries() {
  const registries = await registryService.listRegistries();
  return registries.filter(registry => registry?.enabled && registry.id);
}

async function findEnabledRegistry(registryId) {
  const registry = (await enabledRegistries()).find(entry => entry.id === registryId);
  if (!registry) throw notFound();
  return registry;
}

/**
 * The public view of a catalog skill — what the catalog says about it, never
 * how it is fetched (its source, the registry's credentials) or who installed
 * what on this instance.
 *
 * @param {Object} item - Catalog item with `registryId` and `registryName`.
 * @returns {Object}
 */
export function marketplaceSkillView(item) {
  return {
    registryId: item.registryId,
    registryName: item.registryName || item.registryId,
    name: item.name,
    displayName: localizedView(item.displayName),
    description: localizedView(item.description),
    version: textOrNull(item.version),
    author: textOrNull(item.author),
    category: textOrNull(item.category),
    tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string') : [],
    icon: textOrNull(item.icon),
    license: textOrNull(item.license),
    licenseUrl: textOrNull(item.licenseUrl)
  };
}

function matchesSearch(item, term) {
  const haystack = [
    item.name,
    item.author,
    item.category,
    ...localizedTexts(item.displayName),
    ...localizedTexts(item.description),
    ...(Array.isArray(item.tags) ? item.tags : [])
  ];
  return haystack.some(value => typeof value === 'string' && value.toLowerCase().includes(term));
}

/**
 * The skills the enabled registries offer, filtered and paged, with the
 * registries and categories to filter by. Reads the cached catalogs only.
 *
 * @param {Object} [filters]
 * @param {string} [filters.search] - Matches name, display name, description,
 *   tags, category and author, in every language the catalog has.
 * @param {string} [filters.registry] - Registry id.
 * @param {string} [filters.category] - Catalog category.
 * @param {number|string} [filters.page=1] - 1-based page.
 * @param {number|string} [filters.limit=24] - Items per page, at most 60.
 * @returns {Promise<{items: Object[], total: number, page: number, limit: number,
 *   totalPages: number, registries: Array<{id: string, name: string, count: number}>,
 *   categories: string[]}>}
 */
export async function listMarketplaceSkills(filters = {}) {
  const all = [];
  const registries = [];
  const categories = new Set();

  for (const registry of await enabledRegistries()) {
    const cached = await registryService.getCachedCatalogAsync(registry.id);
    const skills = (cached?.catalog?.items || []).filter(
      item => item?.type === 'skill' && typeof item.name === 'string' && item.name
    );
    if (skills.length === 0) continue;
    const registryName = registry.name || registry.id;
    registries.push({ id: registry.id, name: registryName, count: skills.length });
    for (const item of skills) {
      all.push({ ...item, registryId: registry.id, registryName });
      if (typeof item.category === 'string' && item.category) categories.add(item.category);
    }
  }

  let filtered = all;
  if (typeof filters.registry === 'string' && filters.registry) {
    filtered = filtered.filter(item => item.registryId === filters.registry);
  }
  if (typeof filters.category === 'string' && filters.category) {
    filtered = filtered.filter(item => item.category === filters.category);
  }
  const term = typeof filters.search === 'string' ? filters.search.trim().toLowerCase() : '';
  if (term) filtered = filtered.filter(item => matchesSearch(item, term));

  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(filters.limit, 10) || DEFAULT_PAGE_SIZE)
  );
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(totalPages, Math.max(1, parseInt(filters.page, 10) || 1));
  const start = (page - 1) * limit;

  return {
    items: filtered.slice(start, start + limit),
    total,
    page,
    limit,
    totalPages,
    registries,
    categories: [...categories].sort((a, b) => a.localeCompare(b))
  };
}

/**
 * One marketplace skill with a preview of its instructions and the files the
 * catalog says come with it. The preview is fetched from the item's source.
 *
 * @param {string} registryId - Registry id.
 * @param {string} name - Catalog item name.
 * @returns {Promise<Object>} The skill view plus `preview: { body, files }`.
 * @throws {MarketplaceSkillError} 404 when the registry is off or the item unknown.
 */
export async function getMarketplaceSkill(registryId, name) {
  const registry = await findEnabledRegistry(registryId);
  let detail;
  try {
    detail = await registryService.getItemDetail(registryId, 'skill', name);
  } catch {
    throw notFound();
  }

  const preview = detail.contentPreview;
  const body =
    typeof preview === 'string'
      ? preview
      : preview && typeof preview.body === 'string'
        ? preview.body
        : null;
  const companions = Array.isArray(detail.source?.companions) ? detail.source.companions : [];

  return {
    ...marketplaceSkillView({ ...detail, registryName: registry.name || registry.id }),
    preview: {
      body,
      files: companions
        .filter(path => typeof path === 'string')
        .map(path => ({ path, included: SKILL_FILE_PATH_PATTERN.test(path) }))
    }
  };
}

/**
 * Fetch a marketplace skill and turn it into the content of a user skill.
 *
 * The name is the one asked for, else the catalog name (the name the skill
 * would have if an admin installed it), else the `SKILL.md` name, else one
 * made from the catalog name. The description is the `SKILL.md` one, else the
 * catalog's English one. Files are taken in path order while they are text
 * files one folder deep and fit the file and size limits; the rest are
 * returned as `skipped`. The caller validates the result like any other user
 * skill, so an instruction body beyond the size limit is refused there.
 *
 * @param {string} registryId - Registry id.
 * @param {string} name - Catalog item name.
 * @param {{maxFilesPerSkill: number, maxSkillSizeKB: number}} settings - Effective user skill settings.
 * @param {Object} [options]
 * @param {string} [options.requestedName] - Name for the copy (already validated).
 * @returns {Promise<{item: Object, content: {name: string, description: string,
 *   body: string, files: Array<{path: string, content: string}>},
 *   skipped: Array<{path: string, reason: string}>}>}
 * @throws {MarketplaceSkillError} 404 unknown, 422 not a skill, 502 fetch failed.
 */
export async function buildUserSkillFromMarketplace(
  registryId,
  name,
  settings,
  { requestedName } = {}
) {
  const registry = await findEnabledRegistry(registryId);
  const cached = await registryService.getCachedCatalogAsync(registryId);
  const listed = (cached?.catalog?.items || []).some(
    item => item?.type === 'skill' && item.name === name
  );
  if (!listed) throw notFound();

  let fetched;
  try {
    fetched = await fetchItemContent(registryId, 'skill', name);
  } catch (error) {
    logger.warn('Could not fetch a marketplace skill for a user', {
      component: COMPONENT,
      registryId,
      skillName: name,
      error
    });
    throw new MarketplaceSkillError('The marketplace could not be reached. Try again later.', {
      status: 502,
      code: 'MARKETPLACE_FETCH_FAILED'
    });
  }

  const { item, content } = fetched;
  const files =
    typeof content === 'string'
      ? { 'SKILL.md': content }
      : content && typeof content.files === 'object' && content.files !== null
        ? content.files
        : null;
  if (!files || typeof files['SKILL.md'] !== 'string') {
    throw new MarketplaceSkillError('This marketplace item is not a skill', {
      status: 422,
      code: 'MARKETPLACE_SKILL_INVALID'
    });
  }

  let parsed;
  try {
    parsed = parseFrontMatter(files['SKILL.md']);
  } catch {
    throw new MarketplaceSkillError('The SKILL.md of this skill cannot be read', {
      status: 422,
      code: 'MARKETPLACE_SKILL_INVALID'
    });
  }
  const frontmatter = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};

  const skillName =
    [requestedName, item.name, frontmatter.name].find(isSkillName) || toSkillName(item.name);
  const description = String(
    (typeof frontmatter.description === 'string' && frontmatter.description.trim()) ||
      englishText(item.description)
  )
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
  const body = String(parsed.content || '').trim();

  const budget = settings.maxSkillSizeKB * 1024;
  let size = Buffer.byteLength(body, 'utf8');
  const accepted = [];
  const skipped = [];
  const paths = Object.keys(files)
    .filter(path => path !== 'SKILL.md')
    .sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const text = files[path];
    if (!SKILL_FILE_PATH_PATTERN.test(path) || typeof text !== 'string') {
      skipped.push({ path, reason: SKIPPED_REASONS.unsupported });
      continue;
    }
    if (accepted.length >= settings.maxFilesPerSkill) {
      skipped.push({ path, reason: SKIPPED_REASONS.fileLimit });
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (size + bytes > budget) {
      skipped.push({ path, reason: SKIPPED_REASONS.sizeLimit });
      continue;
    }
    accepted.push({ path, content: text });
    size += bytes;
  }

  return {
    item: { ...item, registryId, registryName: registry.name || registry.id },
    content: { name: skillName, description, body, files: accepted },
    skipped
  };
}

/**
 * The marker a copy from the marketplace carries in `copiedFrom`: where it
 * came from, which version, and under which license.
 *
 * @param {Object} item - The catalog item, with `registryId` and `registryName`.
 * @returns {{scope: 'marketplace', id: string, registryId: string,
 *   registryName: string, version: string|null, license: string|null}}
 */
export function marketplaceCopiedFrom(item) {
  return {
    scope: 'marketplace',
    id: item.name,
    registryId: item.registryId,
    registryName: item.registryName || item.registryId,
    version: textOrNull(item.version),
    license: textOrNull(item.license)
  };
}

/**
 * The caller's copies of marketplace skills, by `<registryId>:<name>`, newest
 * copy first — what the browse list marks as "added".
 *
 * @param {Object[]} ownedSkills - The caller's own user skills.
 * @returns {Map<string, {id: string, name: string}>}
 */
export function marketplaceCopiesByItem(ownedSkills) {
  const copies = new Map();
  const sorted = [...(ownedSkills || [])].sort((a, b) =>
    String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''))
  );
  for (const skill of sorted) {
    const from = skill?.copiedFrom;
    if (from?.scope !== 'marketplace' || !from.registryId || !from.id) continue;
    const key = `${from.registryId}:${from.id}`;
    if (!copies.has(key)) copies.set(key, { id: skill.id, name: skill.name });
  }
  return copies;
}
