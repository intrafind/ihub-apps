// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V248 — Web pages in admin projects become stored snapshots (#3622)
 *
 * A web page item (`kind: 'url'`) was a live link (`storage: 'link'`): every
 * worker fetched and converted the page whenever its own cache was cold. It
 * is a stored snapshot now, fetched once by an ingest job and refreshed after
 * its TTL.
 *
 * What is changed, in every admin project file (`contents/projects/*.json`):
 * each `url` item stored as a link becomes a snapshot waiting for its first
 * fetch — `storage: 'text'`, `status: 'pending'`, no error, no snapshot yet;
 * its link cache lifetime (`cache`) and last check (`checkedAt`) go. Its id,
 * name, reference, pinned flag, refresh TTL and provenance stay. The ingest
 * reconciler fetches it shortly after startup, on one worker.
 *
 * What is left alone: every other item, and projects without a web page link.
 * User projects live in the storage provider, not in these files: the
 * reconciler converts their web page links the same way. Running it again
 * changes nothing.
 */

export const version = '248';
export const description = 'project_web_pages_stored';

const PROJECTS_DIR = 'projects';

/** Snapshot of `isLinkedWebPage` as of V248 — migrations do not import live code. */
function isLinkedWebPage(item) {
  return item?.kind === 'url' && item.storage === 'link';
}

/** Snapshot of `convertLinkedWebPage` as of V248. */
function convert(item) {
  item.storage = 'text';
  item.status = 'pending';
  item.error = null;
  item.snapshotAt = null;
  delete item.cache;
  delete item.checkedAt;
  delete item.refreshingAt;
  delete item.ingestAttempt;
}

export async function precondition(ctx) {
  const files = await ctx.listFiles(PROJECTS_DIR, '*.json');
  return files.length > 0;
}

export async function up(ctx) {
  const files = await ctx.listFiles(PROJECTS_DIR, '*.json');
  let converted = 0;
  for (const file of files) {
    const relPath = `${PROJECTS_DIR}/${file}`;
    let project;
    try {
      project = await ctx.readJson(relPath);
    } catch (error) {
      ctx.warn(`Skipping ${relPath}: ${error.message}`);
      continue;
    }
    const items = Array.isArray(project?.items) ? project.items : [];
    const links = items.filter(isLinkedWebPage);
    if (links.length === 0) continue;
    links.forEach(convert);
    await ctx.writeJson(relPath, project);
    converted += links.length;
    ctx.log(`${relPath}: ${links.length} web page(s) now wait for their first fetch`);
  }
  if (converted === 0) ctx.log('No web page links in admin projects');
}
