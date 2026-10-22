// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V177 — One project for the IntraFind website
 *
 * The sources of the IntraFind website (home page, iFinder, its features and
 * connectors, iAssistant, iHub) became six admin projects with one web page
 * each (V174), and the shipped IntraFind Website Bot linked all six. They are
 * one body of knowledge, so the shipped default is now the single project
 * `intrafind-website` holding the six pages.
 *
 * What is changed:
 *   - The six projects below are merged into `intrafind-website`: their items
 *     (with any setting an admin changed on them) move there, the files are
 *     deleted.
 *   - The `projects` lists of apps, workflows (their project steps, loop
 *     bodies and planner task templates included) and agent profiles that
 *     linked one of them link `intrafind-website` instead. When one list
 *     linked several of them, it keeps one link, at the position of the
 *     first; its mode is the one they shared, or `auto` when they differed,
 *     and it may write when any of them could.
 *
 * What is left alone: a project that an admin changed beyond the shipped shape
 * (instructions, an item that is not a web page, a user-owned id) is not
 * merged and stays linked where it was. An installation that has none of the
 * six projects is not touched. Running it again changes nothing.
 */

export const version = '177';
export const description = 'merge_intrafind_website_projects';

const TARGET_ID = 'intrafind-website';

/**
 * The projects that shipped as one web page each, in the order their items
 * appear in the merged project.
 *
 * Snapshot as of V177 — do NOT replace with a read of server/defaults/projects/:
 * the shipped projects change, this migration must not.
 */
const SHIPPED_PAGES = Object.freeze({
  'intrafind-website-home': 'https://www.intrafind.com',
  'intrafind-website-ifinder': 'https://intrafind.com/en/ifinder',
  'intrafind-website-ifinder-features': 'https://intrafind.com/en/ifinder/features',
  'intrafind-website-ifinder-connectors': 'https://intrafind.com/en/ifinder/connectors',
  'intrafind-website-iassistant': 'https://intrafind.com/en/iassistant',
  'intrafind-website-ihub': 'https://intrafind.com/en/ihub'
});

export const MERGED_PROJECT_IDS = Object.freeze(Object.keys(SHIPPED_PAGES));

const LINK_MODES = ['auto', 'context', 'tools'];

function projectFile(id) {
  return `projects/${id}.json`;
}

function normalizeLink(link) {
  if (typeof link === 'string') return { id: link, mode: 'auto', write: false };
  return {
    id: String(link?.id || ''),
    mode: LINK_MODES.includes(link?.mode) ? link.mode : 'auto',
    write: link?.write === true
  };
}

/**
 * The `projects` list after the links to `fromIds` became one link to
 * `toId`, or null when the list names none of them (same rule as the merge
 * in the admin pages, `services/projects/projectRelink.js`).
 */
export function relinkList(list, fromIds, toId) {
  if (!Array.isArray(list)) return null;
  const merges = link => {
    const { id } = normalizeLink(link);
    return fromIds.has(id) || id === toId;
  };
  if (!list.some(link => fromIds.has(normalizeLink(link).id))) return null;
  const merging = list.filter(merges).map(normalizeLink);
  const mode = merging.every(link => link.mode === merging[0].mode) ? merging[0].mode : 'auto';
  const write = merging.some(link => link.write);
  const merged = mode === 'auto' && !write ? toId : { id: toId, mode, write };
  const first = list.findIndex(merges);
  const result = [];
  list.forEach((link, index) => {
    if (!merges(link)) result.push(link);
    else if (index === first) result.push(merged);
  });
  return result;
}

const withoutTrailingSlash = url => String(url || '').replace(/\/+$/, '');

/**
 * Whether a project is still the shipped shape: its one web page, no
 * instructions. Settings of the item (cache time, length limit) may differ; a
 * replaced page or a further item is an admin's change and keeps the project.
 */
function isPlainWebsiteProject(project) {
  if (!project || typeof project !== 'object') return false;
  if (project.ownership !== 'admin') return false;
  if (typeof project.instructions === 'string' && project.instructions.trim()) return false;
  const items = Array.isArray(project.items) ? project.items : [];
  if (items.length !== 1) return false;
  const [item] = items;
  return (
    item?.kind === 'url' &&
    item?.storage === 'link' &&
    withoutTrailingSlash(item?.ref?.url) === withoutTrailingSlash(SHIPPED_PAGES[project.id])
  );
}

async function readProject(ctx, id) {
  const relPath = projectFile(id);
  if (!(await ctx.fileExists(relPath))) return null;
  try {
    return await ctx.readJson(relPath);
  } catch (error) {
    ctx.warn(`Skipping ${relPath}: ${error.message}`);
    return null;
  }
}

/** The merged project as it exists, else the shipped one. */
async function readTarget(ctx) {
  const existing = await readProject(ctx, TARGET_ID);
  if (existing) return existing;
  if (typeof ctx.readDefaultJson !== 'function') return null;
  try {
    return await ctx.readDefaultJson(projectFile(TARGET_ID));
  } catch {
    return null;
  }
}

/** Items key: the page they read, else their id. */
function itemKey(item) {
  return item?.ref?.url ? `url:${item.ref.url}` : `id:${item?.id}`;
}

async function eachFile(ctx, directory, fn) {
  // `listFiles` answers an empty list for a missing directory; any other
  // failure stops the migration before the merged projects are deleted.
  const files = await ctx.listFiles(directory, '*.json');
  for (const file of files) {
    const relPath = `${directory}/${file}`;
    let doc;
    try {
      doc = await ctx.readJson(relPath);
    } catch (error) {
      ctx.warn(`Skipping ${relPath}: ${error.message}`);
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    if (fn(doc)) await ctx.writeJson(relPath, doc);
  }
}

/** The documents of a workflow whose `projects` list counts as a link. */
function workflowOwners(workflow) {
  const owners = [workflow];
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > 8) return;
    for (const node of nodes) {
      if (node?.type === 'loop') walk(node.config?.body, depth + 1);
      if (node?.config && typeof node.config === 'object') {
        owners.push(node.config);
        if (node.config.taskTemplate && typeof node.config.taskTemplate === 'object') {
          owners.push(node.config.taskTemplate);
        }
      }
    }
  };
  walk(workflow.nodes, 0);
  return owners;
}

function relinkOwners(owners, fromIds) {
  let changed = false;
  for (const owner of owners) {
    const next = relinkList(owner?.projects, fromIds, TARGET_ID);
    if (next) {
      owner.projects = next;
      changed = true;
    }
  }
  return changed;
}

export async function precondition(ctx) {
  for (const id of MERGED_PROJECT_IDS) {
    if (await ctx.fileExists(projectFile(id))) return true;
  }
  return false;
}

export async function up(ctx) {
  const merging = [];
  for (const id of MERGED_PROJECT_IDS) {
    const project = await readProject(ctx, id);
    if (!project) continue;
    if (!isPlainWebsiteProject(project)) {
      ctx.log(`Project ${id} was changed beyond the shipped shape — not merged`);
      continue;
    }
    merging.push(project);
  }
  if (merging.length === 0) return;

  const target = await readTarget(ctx);
  if (!target || target.ownership !== 'admin') {
    ctx.warn(`Project ${TARGET_ID} is not available — the website projects are left as they are`);
    return;
  }

  // The items of the merged projects replace the shipped ones for the same
  // page, so a cache time or length limit an admin set stays.
  const moved = merging.flatMap(project => project.items);
  const movedKeys = new Set(moved.map(itemKey));
  const kept = (Array.isArray(target.items) ? target.items : []).filter(
    item => !movedKeys.has(itemKey(item))
  );
  const items = [...moved, ...kept];
  const seen = new Set();
  target.items = items.filter(item => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  // Disabled only when every merged project was.
  if (target.enabled !== false || merging.some(project => project.enabled !== false)) {
    target.enabled = true;
  }
  target.updatedAt = new Date().toISOString();
  await ctx.writeJson(projectFile(TARGET_ID), target);

  const fromIds = new Set(merging.map(project => project.id));
  let relinked = 0;
  await eachFile(ctx, 'apps', app => {
    const changed = relinkOwners([app], fromIds);
    if (changed) relinked += 1;
    return changed;
  });
  await eachFile(ctx, 'workflows', workflow => {
    const changed = relinkOwners(workflowOwners(workflow), fromIds);
    if (changed) relinked += 1;
    return changed;
  });
  await eachFile(ctx, 'agents/profiles', profile => {
    const changed = relinkOwners([profile], fromIds);
    if (changed) relinked += 1;
    return changed;
  });

  for (const id of fromIds) await ctx.deleteFile(projectFile(id));
  ctx.log(
    `Merged ${fromIds.size} website project(s) into ${TARGET_ID} (${target.items.length} items); ` +
      `re-linked ${relinked} app, workflow and profile file(s)`
  );
}
