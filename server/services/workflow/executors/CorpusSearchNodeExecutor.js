/**
 * Executor for `corpus-search` workflow nodes.
 *
 * Runs multiple iFinder queries (one per topic + expansion in the plan),
 * deduplicates results by docId, optionally pre-fetches fulltext for each
 * deduped doc, and populates the workflow's `_corpus` array plus
 * `_coverage.candidates`.
 *
 * Within-topic pagination is intentionally not implemented in v1 —
 * `iFinderService.search()` caps `size` at 100 per call. Breadth comes
 * from multiple topics, not deep pagination.
 *
 * Loop-aware: when placed inside a `forEach`, the node's `query` config
 * can reference `_loopItem` via Handlebars (`{{_loopItem.lawReference}}`).
 * That's the case-B nested pattern used by `corpus-analysis-decomposed`.
 *
 * @module services/workflow/executors/CorpusSearchNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import iFinderService from '../../integrations/iFinderService.js';
import { actionTracker } from '../../../actionTracker.js';
import { activeWorkflowExecutions } from '../../../tools/workflowRunner.js';

export class CorpusSearchNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const config = node.config || {};
    const {
      planPath = '$.data._queryPlan',
      queryPath,
      corpusVar = '_corpus',
      coverageVar = '_coverage',
      maxPerTopic = 25,
      maxTotalDocs = 500,
      fetchFulltext = true,
      maxFulltextChars = 50000,
      filter: configFilter,
      filterPath = '$.data.filter',
      extraQueries
    } = config;
    // searchProfile can be either a literal id or a `$.data.x` reference so
    // workflows whose start node collects the profile from the user can pass
    // it through. Fail fast on unresolved references — silently falling back
    // to iFinder's default profile would query the wrong corpus.
    let searchProfile = config.searchProfile;
    if (typeof searchProfile === 'string' && searchProfile.startsWith('$.')) {
      const ref = searchProfile;
      searchProfile = this.resolveVariable(ref, state);
      if (typeof searchProfile !== 'string' || !searchProfile.trim()) {
        return this.createErrorResult(
          `corpus-search: searchProfile reference '${ref}' resolved to an empty value. ` +
            `Make sure the workflow's start node collects searchProfile and that the user supplied a value.`,
          { nodeId: node.id }
        );
      }
    }

    const user = context?.user;
    const chatId = context?.chatId || context?.runId || context?.executionId;
    if (!user || user.id === 'anonymous') {
      return this.createErrorResult(
        'corpus-search requires an authenticated user (iFinder access)',
        { nodeId: node.id }
      );
    }
    if (!chatId) {
      return this.createErrorResult(
        'corpus-search requires a chatId/runId in the execution context for iFinder action tracking',
        { nodeId: node.id }
      );
    }

    // Build the list of query strings to execute. Either a single literal
    // query (queryPath, useful inside loops) or a full plan with topics +
    // expansions (planPath, the typical case).
    const queries = [];
    if (queryPath) {
      const literalQuery = this.resolveVariable(queryPath, state);
      if (typeof literalQuery === 'string' && literalQuery.trim()) {
        queries.push(literalQuery.trim());
      }
    } else {
      const plan = this.resolveVariable(planPath, state);
      if (!plan || typeof plan !== 'object') {
        return this.createErrorResult(
          `corpus-search could not resolve a plan at '${planPath}' or a literal query at queryPath`,
          { nodeId: node.id }
        );
      }
      if (Array.isArray(plan.topics)) {
        for (const t of plan.topics) if (typeof t === 'string' && t.trim()) queries.push(t.trim());
      }
      if (Array.isArray(plan.expansions)) {
        for (const e of plan.expansions)
          if (typeof e === 'string' && e.trim()) queries.push(e.trim());
      }
    }

    // `extraQueries`: literal queries or `$.path` references that should be
    // run alongside the LLM-generated plan. Common uses:
    //   - "$.data.userPrompt" → search the user's raw prompt verbatim, so a
    //     well-phrased focus isn't lost to the planner's paraphrasing
    //   - "*"                 → match-all (relies on filters to bound the
    //     result set), gives a baseline of recent/top-scored docs
    // Resolved entries are appended; cross-iteration dedup via
    // `_executedQueries` keeps repeat runs idempotent.
    if (Array.isArray(extraQueries)) {
      for (const entry of extraQueries) {
        if (typeof entry !== 'string' || !entry.trim()) continue;
        let value = entry.trim();
        if (value.startsWith('$.')) {
          const resolved = this.resolveVariable(value, state);
          if (typeof resolved !== 'string' || !resolved.trim()) continue;
          value = resolved.trim();
        }
        queries.push(value);
      }
    }

    // Dedupe while preserving order — important for inter-iteration dedup
    // downstream and to avoid wasting iFinder calls on identical strings.
    const queriesSeen = new Set();
    const dedupedQueries = [];
    for (const q of queries) {
      if (queriesSeen.has(q)) continue;
      queriesSeen.add(q);
      dedupedQueries.push(q);
    }
    queries.length = 0;
    queries.push(...dedupedQueries);

    if (queries.length === 0) {
      return this.createErrorResult('corpus-search: no queries to execute (plan was empty?)', {
        nodeId: node.id
      });
    }

    // Resolve filters: config provides defaults, $.data.filter (from
    // inputVariable) appends/overrides. Both modes coexist — concatenated
    // and de-duplicated. iFinder treats multiple `filter=` params as AND.
    //
    // textarea inputVariables arrive as a single newline-separated string,
    // tool-call args arrive as an array — accept both shapes here.
    const stateFiltersRaw = this.resolveVariable(filterPath, state);
    const stateFilters =
      typeof stateFiltersRaw === 'string'
        ? stateFiltersRaw.split(/\r?\n/)
        : Array.isArray(stateFiltersRaw)
          ? stateFiltersRaw
          : [];
    const mergedFilters = [...(Array.isArray(configFilter) ? configFilter : []), ...stateFilters]
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => f.trim());
    const filters = Array.from(new Set(mergedFilters));

    const abortSignal = context?.abortSignal;
    const isCancelled = () => abortSignal?.aborted === true;

    // Per-query progress steps so the chat shows what we searched for and
    // how many hits each query returned. We use `trackWorkflowStep` with
    // status:'completed' (not the bare `workflow.node.progress` event the
    // admin UI consumes) because the chat client listens on `workflow.step`
    // and accumulates completed steps. Each step gets a unique `nodeName`
    // so they all stick instead of overwriting each other.
    //
    // Mapping chatId: `actionTracker.trackWorkflowStep` expects the *chat*
    // chatId. Inside workflow executors `context.chatId` is the executionId
    // — `workflowRunner` bridges executionId→chatId on its end. To reach
    // the chat directly we look up the original chat session via
    // activeWorkflowExecutions; if we're not in a chat-triggered run we
    // simply skip emission.
    const chatSessionId = (() => {
      for (const [cId, info] of activeWorkflowExecutions.entries()) {
        if (info?.executionId === chatId) return cId;
      }
      return null;
    })();
    const emitStep = (nodeName, status = 'completed') => {
      if (!chatSessionId || !nodeName) return;
      try {
        actionTracker.trackWorkflowStep(chatSessionId, {
          nodeName,
          nodeType: 'corpus-search',
          status,
          chatVisible: true
        });
      } catch {
        /* best-effort */
      }
    };

    // Cross-iteration query dedup. The refine loop calls corpus-search
    // multiple times with a growing topic list, which re-runs queries we
    // already executed. Track the set of executed queries in state so each
    // unique query+filter combination only hits iFinder once per run.
    const executedKey = q => `${q}||${filters.join(',')}`;
    const priorExecutedRaw = this.resolveVariable('$.data._executedQueries', state);
    const executedQueries = new Set(
      Array.isArray(priorExecutedRaw) ? priorExecutedRaw.filter(k => typeof k === 'string') : []
    );

    // Restore prior-run corpus and merge in this iteration's fresh hits so
    // the report can be composed over the union of all rounds, not just the
    // last one.
    const priorCorpus = this.resolveVariable(`$.data.${corpusVar}`, state);
    const dedup = new Map(); // docId -> doc
    if (Array.isArray(priorCorpus)) {
      for (const doc of priorCorpus) {
        if (doc?.docId) dedup.set(doc.docId, doc);
      }
    }

    const startedAt = new Date().toISOString();
    const errors = [];
    let cancelled = false;
    const queryStats = []; // for logging / debugging / coverage

    if (filters.length > 0) {
      emitStep(`Filters: ${filters.join(' AND ')}`);
    }

    // iFinder caps a single response at 100 results, so any `maxPerTopic`
    // larger than 100 has to be paged. We loop with `from` until we've
    // collected `maxPerTopic` hits for this query, hit the corpus-wide
    // `maxTotalDocs` cap, or iFinder reports no more results.
    const IFINDER_MAX_PAGE = 100;

    const buildDoc = (hit, query) => {
      const docId = hit?.id;
      if (!docId) return null;
      const title = typeof hit.title === 'string' ? hit.title.trim() : '';
      const fileName =
        (typeof hit.filename === 'string' && hit.filename.trim()) ||
        (hit.file && typeof hit.file.name === 'string' && hit.file.name.trim()) ||
        '';
      const sourceName = typeof hit.sourceName === 'string' ? hit.sourceName.trim() : '';
      const displayName = title || fileName || sourceName || docId;
      return {
        docId,
        title,
        fileName: fileName || null,
        displayName,
        url: hit.url || hit.deepLink,
        sourceSystem: 'ifinder',
        sourceName: sourceName || null,
        mediaType: hit.mediaType,
        language: hit.language,
        modificationDate: hit.modificationDate,
        score: hit.score,
        matchedQuery: query
      };
    };

    for (const query of queries) {
      if (dedup.size >= maxTotalDocs) break;
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      const qkey = executedKey(query);
      if (executedQueries.has(qkey)) {
        emitStep(`Skipped (already searched): "${query}"`);
        continue;
      }
      executedQueries.add(qkey);

      let hitsThisQuery = 0;
      let newHitsThisQuery = 0;
      let totalFound = 0;
      let from = 0;
      let pages = 0;
      let queryFailed = false;

      while (hitsThisQuery < maxPerTopic && dedup.size < maxTotalDocs && !isCancelled()) {
        const remainingForQuery = maxPerTopic - hitsThisQuery;
        const remainingForCorpus = maxTotalDocs - dedup.size;
        const pageSize = Math.min(remainingForQuery, remainingForCorpus, IFINDER_MAX_PAGE);
        if (pageSize <= 0) break;

        let result;
        try {
          result = await iFinderService.search({
            query,
            chatId,
            user,
            searchProfile,
            maxResults: pageSize,
            from,
            filter: filters,
            signal: abortSignal
          });
        } catch (err) {
          if (err?.name === 'AbortError' || isCancelled()) {
            cancelled = true;
            break;
          }
          this.logger.warn('corpus-search query failed', {
            component: 'CorpusSearchNodeExecutor',
            nodeId: node.id,
            query,
            from,
            error: err.message
          });
          errors.push({ query, error: err.message, from });
          emitStep(`iFinder "${query}" — failed: ${err.message}`);
          queryFailed = true;
          break;
        }

        const hits = Array.isArray(result?.results) ? result.results : [];
        totalFound = result?.totalFound ?? totalFound;
        pages++;
        hitsThisQuery += hits.length;

        for (const hit of hits) {
          if (dedup.size >= maxTotalDocs) break;
          const doc = buildDoc(hit, query);
          if (!doc || dedup.has(doc.docId)) continue;
          dedup.set(doc.docId, doc);
          newHitsThisQuery++;
        }

        // Stop paging when iFinder gives us less than a full page (no more
        // results) or we've reached the corpus-wide total.
        if (hits.length < pageSize) break;
        from += hits.length;
      }

      if (cancelled) break;

      if (!queryFailed) {
        queryStats.push({
          query,
          hits: hitsThisQuery,
          newHits: newHitsThisQuery,
          totalFound,
          pages
        });
        const truncated =
          totalFound > hitsThisQuery && hitsThisQuery >= maxPerTopic
            ? ` (capped at maxPerTopic=${maxPerTopic}, ${totalFound} available)`
            : totalFound > hitsThisQuery
              ? `, ${totalFound} total in profile`
              : '';
        emitStep(
          `iFinder "${query}" — ${hitsThisQuery} hit${hitsThisQuery === 1 ? '' : 's'} (${newHitsThisQuery} new${truncated}, ${pages} page${pages === 1 ? '' : 's'})`
        );
      }
    }

    const docs = Array.from(dedup.values());

    // Optionally fetch fulltext for each deduped doc. Sequential — keeps
    // this deterministic and well-behaved against iFinder throttling.
    if (fetchFulltext && !cancelled) {
      for (let i = 0; i < docs.length; i++) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }
        const doc = docs[i];
        // Skip docs whose fulltext we already loaded in a prior iteration.
        if (typeof doc.fulltext === 'string' && doc.fulltext.length > 0) continue;
        try {
          const content = await iFinderService.getContent({
            documentId: doc.docId,
            chatId,
            user,
            searchProfile,
            maxLength: maxFulltextChars,
            signal: abortSignal
          });
          doc.fulltext = content?.content || '';
          doc.contentLength = content?.contentLength || 0;
          emitStep(
            `Loaded fulltext ${i + 1}/${docs.length}: ${doc.displayName || doc.docId} (${doc.contentLength} chars)`
          );
        } catch (err) {
          if (err?.name === 'AbortError' || isCancelled()) {
            cancelled = true;
            break;
          }
          this.logger.warn('corpus-search fulltext fetch failed', {
            component: 'CorpusSearchNodeExecutor',
            nodeId: node.id,
            docId: doc.docId,
            error: err.message
          });
          doc.fulltextError = err.message;
          emitStep(`Fulltext load failed ${i + 1}/${docs.length}: ${doc.displayName || doc.docId}`);
        }
      }
    }

    if (cancelled) {
      emitStep(
        `Cancelled — kept ${docs.length} document${docs.length === 1 ? '' : 's'} found so far`
      );
    } else {
      const newThisRound = queryStats.reduce((sum, s) => sum + s.newHits, 0);
      emitStep(
        `iFinder search done — ${docs.length} unique doc${docs.length === 1 ? '' : 's'} total (+${newThisRound} new this round, ${queryStats.length} new quer${queryStats.length === 1 ? 'y' : 'ies'} run)`
      );
    }

    const planForCoverage = queryPath
      ? { topics: queries, expansions: [], synonyms: {}, entities: [], filters: {} }
      : this.resolveVariable(planPath, state) || {};
    const coverage = mergeCoverage(this.resolveVariable(`$.data.${coverageVar}`, state), {
      candidates: {
        total: docs.length,
        source: 'ifinder',
        queryPlan: planForCoverage,
        queriesExecuted: queries.length,
        queryErrors: errors,
        filters,
        cancelled
      },
      startedAt
    });

    this.logger.info('corpus-search complete', {
      component: 'CorpusSearchNodeExecutor',
      nodeId: node.id,
      queries: queries.length,
      candidates: docs.length,
      fetchedFulltext: fetchFulltext,
      filters,
      cancelled
    });

    // Compact per-doc summary for the execution UI's Parameters section.
    // Strips heavy fields (fulltext, rawDocument) so persisted nodeResults
    // stay small even when the workflow loads a few hundred docs.
    const docSummaries = docs.map(d => ({
      docId: d.docId,
      displayName: d.displayName,
      title: d.title || null,
      fileName: d.fileName || null,
      sourceName: d.sourceName || null,
      url: d.url || null,
      mediaType: d.mediaType || null,
      language: d.language || null,
      score: d.score,
      matchedQuery: d.matchedQuery,
      hasFulltext: typeof d.fulltext === 'string' && d.fulltext.length > 0,
      contentLength: d.contentLength || 0
    }));

    return this.createSuccessResult(
      {
        total: docs.length,
        queriesExecutedThisRound: queryStats.length,
        queriesRequested: queries.length,
        queriesSkippedAsDuplicate: queries.length - queryStats.length - errors.length,
        newHitsThisRound: queryStats.reduce((sum, s) => sum + s.newHits, 0),
        queryStats,
        queryErrors: errors,
        filters,
        cancelled
      },
      {
        stateUpdates: {
          [corpusVar]: docs,
          [coverageVar]: coverage,
          _executedQueries: Array.from(executedQueries)
        },
        resolvedInputs: {
          searchProfile,
          queries,
          filters,
          maxPerTopic,
          maxTotalDocs,
          fetchFulltext,
          maxFulltextChars,
          // Results surfaced here so the execution UI's Parameters section
          // shows them inline. The full corpus (with fulltext) lives in
          // state.data._corpus; this is a lightweight projection for
          // visibility only.
          docs: docSummaries,
          queryStats
        }
      }
    );
  }
}

function mergeCoverage(existing, additions) {
  const base =
    existing && typeof existing === 'object'
      ? { ...existing }
      : {
          candidates: { total: 0 },
          processed: 0,
          skipped: [],
          failed: [],
          quotesChecked: 0,
          quotesValidated: 0
        };
  return {
    candidates: { ...(base.candidates || {}), ...(additions.candidates || {}) },
    processed: base.processed || 0,
    skipped: Array.isArray(base.skipped) ? base.skipped : [],
    failed: Array.isArray(base.failed) ? base.failed : [],
    quotesChecked: base.quotesChecked || 0,
    quotesValidated: base.quotesValidated || 0,
    startedAt: base.startedAt || additions.startedAt
  };
}

export default CorpusSearchNodeExecutor;
