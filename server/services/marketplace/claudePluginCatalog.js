// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Claude Code plugin marketplaces as iHub registries.
 *
 * A Claude Code marketplace (`.claude-plugin/marketplace.json`, such as
 * Anthropic's `knowledge-work-plugins` and `claude-plugins-official`) lists
 * *plugins*. iHub installs *skills*, so a registry whose catalog has a
 * `plugins` array is translated here, in memory, into catalog items: one
 * `skill` item per `SKILL.md` a plugin ships. Nothing is written to the
 * registry; the result is cached like any other catalog.
 *
 * Where a plugin lives (its `source`):
 *
 * | `source`                                   | resolved to                                   |
 * | ------------------------------------------ | --------------------------------------------- |
 * | `"./path"`                                 | a folder of the marketplace's own GitHub repo |
 * | `{ source: "github", repo: "o/r" }`        | the root of `o/r`                             |
 * | `{ source: "url", url: "https://github.com/o/r.git" }` | the root of `o/r`                 |
 * | `{ source: "git-subdir", url, path }`      | the folder `path` of that repository          |
 *
 * `ref` and `sha` pin the revision; the commit `sha` wins. Other sources
 * (`npm`, `command`, a git host other than GitHub) cannot be read by the
 * server and are skipped with a log entry.
 *
 * Which skills a plugin ships follows the Claude Code layout: a `SKILL.md` at
 * the plugin root (one skill, named like the plugin), the folders
 * `skills/<name>/SKILL.md`, and the paths of the plugin's `skills` field
 * (relative to the plugin root, each a skill folder or a folder of skill
 * folders). Commands, agents, hooks and MCP/LSP configuration of a plugin
 * have no iHub counterpart and are not imported.
 *
 * The file listing of a repository comes from the GitHub Trees API, one call
 * per distinct repository and revision, through the injected `fetchTree` (so
 * the registry's TLS, proxy and credential rules apply). A marketplace with
 * many plugins from other repositories makes many calls; GitHub allows 60 an
 * hour without a token, so such a registry needs a bearer token.
 *
 * @module services/marketplace/claudePluginCatalog
 */

import path from 'node:path';

/** Repositories whose tree is fetched at the same time. */
export const TREE_FETCH_CONCURRENCY = 4;

/** Companion files of one skill that are kept; more are dropped with a warning. */
export const MAX_COMPANIONS_PER_SKILL = 200;

/** A skill name is a folder name below `contents/skills/`. */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Companion files are written as UTF-8 text, which would corrupt these, so
 * they are not offered.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.7z',
  '.xlsx',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
  '.so',
  '.dll',
  '.dylib',
  '.exe',
  '.bin',
  '.wasm',
  '.pyc'
]);

/** Subfolders of a plugin root that belong to a root-level skill. */
const ROOT_SKILL_SUBDIRS = [
  'references',
  'scripts',
  'assets',
  'templates',
  'examples',
  'resources'
];

/**
 * "ab-test-setup" → "Ab Test Setup".
 *
 * @param {string} value
 * @returns {string}
 */
export function humanize(value) {
  return String(value || '')
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * The owner and repository of a GitHub repository URL (`https://github.com/o/r`,
 * `https://github.com/o/r.git`, `git@github.com:o/r.git`) or of the `o/r`
 * shorthand. Another host is null.
 *
 * @param {unknown} value
 * @returns {{ owner: string, repo: string }|null}
 */
export function parseGitHubRepo(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match =
    text.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i) ||
    text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i) ||
    text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * A relative path inside a repository, normalised (`./a//b/` → `a/b`); empty
 * for the root. `null` when it is not a safe in-repository path.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanRepoPath(value) {
  if (value === undefined || value === null || value === '' || value === '.' || value === './') {
    return '';
  }
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) return null;
  const normalized = path.posix.normalize(value).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/**
 * Where a plugin lives.
 *
 * @param {object} plugin - Entry of `marketplace.json`
 * @param {{ owner: string, repo: string, ref: string }|null} ownRepo - The
 *   GitHub repository the marketplace itself is read from, when it is one
 * @returns {{ owner: string, repo: string, ref: string, dir: string }|{ skip: string }}
 *   `ref` is what the tree is read at and the file URLs point to (the commit
 *   `sha` when the source has one); `dir` the plugin folder inside the repository
 */
export function resolvePluginRoot(plugin, ownRepo) {
  const source = plugin?.source;

  if (typeof source === 'string') {
    if (!source.startsWith('.')) return { skip: `unsupported source '${source}'` };
    if (!ownRepo) {
      return { skip: 'a relative source needs a marketplace served from GitHub' };
    }
    const dir = cleanRepoPath(source);
    if (dir === null) return { skip: `unsafe source path '${source}'` };
    return { ...ownRepo, dir };
  }

  if (!source || typeof source !== 'object') return { skip: 'no source' };

  let repo = null;
  let dir = '';
  switch (source.source) {
    case 'github':
      repo = parseGitHubRepo(source.repo || source.url);
      break;
    case 'url':
      repo = parseGitHubRepo(source.url);
      break;
    case 'git-subdir': {
      repo = parseGitHubRepo(source.url);
      dir = cleanRepoPath(source.path);
      break;
    }
    default:
      return { skip: `source type '${source.source}' cannot be read by the server` };
  }
  if (!repo) return { skip: 'the repository is not on GitHub' };
  if (dir === null) return { skip: `unsafe source path '${source.path}'` };

  const ref = [source.sha, source.ref].find(v => typeof v === 'string' && v.trim());
  return { ...repo, ref: ref ? ref.trim() : 'HEAD', dir };
}

/**
 * The folders of a tree that hold a `SKILL.md`, and the files by folder.
 *
 * @param {Array<{ path: string, type: string }>} tree - GitHub tree entries
 * @returns {{ skillDirs: Set<string>, blobs: string[] }}
 */
export function indexTree(tree) {
  const skillDirs = new Set();
  const blobs = [];
  for (const entry of tree) {
    if (entry?.type !== 'blob' || typeof entry.path !== 'string') continue;
    blobs.push(entry.path);
    if (entry.path === 'SKILL.md') skillDirs.add('');
    else if (entry.path.endsWith('/SKILL.md'))
      skillDirs.add(entry.path.slice(0, -'/SKILL.md'.length));
  }
  return { skillDirs, blobs };
}

const joinPath = (...parts) => parts.filter(Boolean).join('/');
const parentOf = dir => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');

/**
 * The skill folders a plugin ships, in discovery order, each once.
 *
 * @param {object} plugin - Entry of `marketplace.json`
 * @param {string} root - Plugin folder in the repository ('' for the root)
 * @param {Set<string>} skillDirs - Folders of the repository that hold a `SKILL.md`
 * @returns {string[]} Repository paths of skill folders
 */
export function findSkillDirs(plugin, root, skillDirs) {
  const found = [];
  const add = dir => {
    if (skillDirs.has(dir) && !found.includes(dir)) found.push(dir);
  };
  const addChildren = base => {
    for (const dir of [...skillDirs].sort()) {
      if (dir !== base && parentOf(dir) === base) add(dir);
    }
  };

  // One skill at the plugin root.
  add(root);
  // The default folder.
  addChildren(joinPath(root, 'skills'));
  // Paths the plugin names: a skill folder, or a folder of skill folders.
  const custom = Array.isArray(plugin?.skills)
    ? plugin.skills
    : typeof plugin?.skills === 'string'
      ? [plugin.skills]
      : [];
  for (const entry of custom) {
    const relative = cleanRepoPath(entry);
    if (relative === null) continue;
    const base = joinPath(root, relative);
    add(base);
    addChildren(base);
  }
  return found;
}

/**
 * The companion files of a skill: its files other than `SKILL.md`, as paths
 * relative to the skill folder, without the files of a skill folder nested in
 * it and without binary files. A skill at the plugin root (whose folder also
 * holds commands, agents and the other skills) keeps only its conventional
 * subfolders.
 *
 * @param {string[]} blobs - Every file of the repository
 * @param {string} skillDir - The skill folder
 * @param {Set<string>} skillDirs - Folders of the repository that hold a `SKILL.md`
 * @param {{ rootSkill: boolean }} options
 * @returns {{ companions: string[], truncated: boolean }}
 */
export function findCompanions(blobs, skillDir, skillDirs, { rootSkill }) {
  const prefix = skillDir ? `${skillDir}/` : '';
  const nested = [...skillDirs].filter(
    dir => dir !== skillDir && (!skillDir || dir.startsWith(prefix))
  );
  const companions = [];
  for (const blob of blobs) {
    if (!blob.startsWith(prefix)) continue;
    const relative = blob.slice(prefix.length);
    if (!relative || relative === 'SKILL.md') continue;
    if (BINARY_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) continue;
    if (nested.some(dir => blob.startsWith(`${dir}/`))) continue;
    if (rootSkill && !ROOT_SKILL_SUBDIRS.some(sub => relative.startsWith(`${sub}/`))) continue;
    companions.push(relative);
  }
  companions.sort();
  const truncated = companions.length > MAX_COMPANIONS_PER_SKILL;
  return { companions: companions.slice(0, MAX_COMPANIONS_PER_SKILL), truncated };
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Whether a failed tree call means GitHub's rate limit (no point asking again). */
function isRateLimited(error) {
  return /\b(403|429)\b/.test(String(error?.message || ''));
}

/**
 * Translate the plugins of a Claude Code marketplace into skill catalog items.
 *
 * A plugin that cannot be read (unsupported source, repository not found,
 * rate limit) is skipped with a log entry; it never fails the catalog. When
 * the marketplace's own repository cannot be read at all, the error is thrown,
 * so *Test Connection* shows it.
 *
 * @param {Object} params
 * @param {Array<object>} params.plugins - `plugins` of `marketplace.json`
 * @param {{ name?: string }|undefined} params.owner - `owner` of `marketplace.json`
 * @param {{ owner: string, repo: string, ref: string }|null} params.ownRepo -
 *   The repository the marketplace is served from, when it is a GitHub one
 * @param {(owner: string, repo: string, ref: string) => Promise<Array<{ path: string, type: string }>>} params.fetchTree
 *   Reads a repository's file tree
 * @param {{ warn: Function, info?: Function }} params.logger
 * @param {object} [params.logContext] - Fields added to every log entry
 * @returns {Promise<Array<object>>} `skill` catalog items
 */
export async function buildPluginSkillItems({
  plugins,
  owner,
  ownRepo,
  fetchTree,
  logger,
  logContext = {}
}) {
  const log = (message, extra) => logger.warn(message, { ...logContext, ...extra });
  const skipped = [];

  /** @type {Map<string, { owner: string, repo: string, ref: string, entries: object[] }>} */
  const repos = new Map();
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name) continue;
    const root = resolvePluginRoot(plugin, ownRepo);
    if (root.skip) {
      skipped.push({ plugin: plugin.name, reason: root.skip });
      continue;
    }
    const key = `${root.owner}/${root.repo}@${root.ref}`;
    if (!repos.has(key)) {
      repos.set(key, { owner: root.owner, repo: root.repo, ref: root.ref, entries: [] });
    }
    repos.get(key).entries.push({ plugin, dir: root.dir });
  }

  let rateLimited = false;
  let ownRepoError = null;
  const items = [];
  const usedNames = new Set();

  await mapWithConcurrency([...repos.values()], TREE_FETCH_CONCURRENCY, async repo => {
    const isOwn = ownRepo && repo.owner === ownRepo.owner && repo.repo === ownRepo.repo;
    if (rateLimited) {
      for (const { plugin } of repo.entries) {
        skipped.push({ plugin: plugin.name, reason: 'GitHub API rate limit reached' });
      }
      return;
    }

    let tree;
    try {
      tree = await fetchTree(repo.owner, repo.repo, repo.ref);
    } catch (error) {
      if (isRateLimited(error)) rateLimited = true;
      if (isOwn && !ownRepoError) ownRepoError = error;
      for (const { plugin } of repo.entries) {
        skipped.push({
          plugin: plugin.name,
          reason: `could not read ${repo.owner}/${repo.repo}: ${error.message}`
        });
      }
      return;
    }

    const { skillDirs, blobs } = indexTree(tree);
    const rawBase = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.ref}`;

    for (const { plugin, dir: root } of repo.entries) {
      const dirs = findSkillDirs(plugin, root, skillDirs);
      const sha =
        typeof plugin.source === 'object' && typeof plugin.source?.sha === 'string'
          ? plugin.source.sha
          : null;
      const category = humanize(plugin.category || plugin.name);
      const tags = [
        ...new Set(
          [plugin.name, ...(plugin.tags || []), ...(plugin.keywords || [])].filter(
            tag => typeof tag === 'string' && tag
          )
        )
      ];

      for (const dir of dirs) {
        const rootSkill = dir === root;
        const leaf = dir.split('/').pop() || plugin.name;
        const name = rootSkill ? plugin.name : `${plugin.name}-${leaf}`;
        if (!SKILL_NAME_PATTERN.test(name) || usedNames.has(name)) {
          log('A plugin skill was left out: its name is unusable or taken', {
            plugin: plugin.name,
            skillDir: dir,
            name
          });
          continue;
        }
        usedNames.add(name);

        const { companions, truncated } = findCompanions(blobs, dir, skillDirs, { rootSkill });
        if (truncated) {
          log(
            `A plugin skill has more than ${MAX_COMPANIONS_PER_SKILL} files; the rest is left out`,
            {
              plugin: plugin.name,
              skillDir: dir
            }
          );
        }

        const description =
          typeof plugin.description === 'string'
            ? { en: plugin.description }
            : plugin.description || undefined;
        const version =
          typeof plugin.version === 'string' && plugin.version
            ? plugin.version
            : sha
              ? sha.slice(0, 7)
              : undefined;

        items.push({
          type: 'skill',
          name,
          displayName: {
            en: rootSkill ? plugin.displayName || humanize(plugin.name) : humanize(leaf)
          },
          description,
          version,
          author: plugin.author?.name || owner?.name,
          category,
          tags,
          source: {
            type: 'url',
            url: `${rawBase}/${joinPath(dir, 'SKILL.md')}`,
            companions,
            rawBase
          }
        });
      }
    }
  });

  if (skipped.length > 0) {
    logger.warn(`${skipped.length} plugin(s) of the marketplace were not imported`, {
      ...logContext,
      skipped: skipped.slice(0, 50),
      rateLimited
    });
  }
  if (items.length === 0 && ownRepoError) throw ownRepoError;
  return items;
}
