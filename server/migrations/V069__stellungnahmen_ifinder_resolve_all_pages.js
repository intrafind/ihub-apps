export const version = '069';
export const description = 'stellungnahmen_ifinder_resolve_all_pages';

// Existing installs already have contents/workflows/stellungnahmen-review-ifinder.json
// on disk (gitignored runtime data), so the fixed server/defaults copy does NOT
// reach them via performInitialSetup. This migration patches the `search-corpus`
// node in place so the workflow resolves ALL matching iFinder documents instead
// of only the first page per query.
//
// Background: CorpusSearchNodeExecutor pages iFinder (100 hits/call) but stops a
// query once it has collected `maxPerTopic` hits. With maxPerTopic=25 a query
// that reports 155 total hits contributed only its first 25 — the remaining 130
// were never fetched. Setting maxPerTopic=0 removes the per-query limit (page
// through every hit, bounded only by the corpus-wide `maxTotalDocs`), and raising
// maxTotalDocs 200 → 500 gives headroom above observed corpus sizes.
//
// Idempotent and conservative: only exact known-old values are replaced, so admin
// customizations and already-fixed installs (fresh installs seeded from the fixed
// defaults) are left untouched.

const WF = 'workflows/stellungnahmen-review-ifinder.json';

const OLD_MAX_PER_TOPIC = 25;
const NEW_MAX_PER_TOPIC = 0;
const OLD_MAX_TOTAL_DOCS = 200;
const NEW_MAX_TOTAL_DOCS = 500;

export async function precondition(ctx) {
  return await ctx.fileExists(WF);
}

export async function up(ctx) {
  const wf = await ctx.readJson(WF);
  if (!wf || !Array.isArray(wf.nodes)) {
    ctx.warn(`${WF} missing nodes; skipping`);
    return;
  }

  const search = wf.nodes.find(n => n?.id === 'search-corpus');
  if (!search || !search.config || typeof search.config !== 'object') {
    ctx.warn(`${WF} has no search-corpus node with config; skipping`);
    return;
  }

  let changed = false;

  // Remove the per-query cap so every matching document is paged in.
  if (search.config.maxPerTopic === OLD_MAX_PER_TOPIC) {
    search.config.maxPerTopic = NEW_MAX_PER_TOPIC;
    changed = true;
  }

  // Give the corpus-wide ceiling headroom above observed corpus sizes.
  if (search.config.maxTotalDocs === OLD_MAX_TOTAL_DOCS) {
    search.config.maxTotalDocs = NEW_MAX_TOTAL_DOCS;
    changed = true;
  }

  if (changed) {
    await ctx.writeJson(WF, wf);
    ctx.log(
      'Patched stellungnahmen-review-ifinder search-corpus (maxPerTopic=0, maxTotalDocs=500)'
    );
  } else {
    ctx.log('stellungnahmen-review-ifinder search-corpus already up to date; no changes');
  }
}
