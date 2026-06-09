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
      maxFulltextChars = 50000
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
    if (queries.length === 0) {
      return this.createErrorResult('corpus-search: no queries to execute (plan was empty?)', {
        nodeId: node.id
      });
    }

    const startedAt = new Date().toISOString();
    const dedup = new Map(); // docId -> doc
    const errors = [];

    for (const query of queries) {
      if (dedup.size >= maxTotalDocs) break;
      try {
        const result = await iFinderService.search({
          query,
          chatId,
          user,
          searchProfile,
          maxResults: Math.min(maxPerTopic, 100)
        });
        const hits = Array.isArray(result?.results) ? result.results : [];
        for (const hit of hits) {
          if (dedup.size >= maxTotalDocs) break;
          const docId = hit?.id;
          if (!docId || dedup.has(docId)) continue;
          dedup.set(docId, {
            docId,
            title: hit.title,
            url: hit.url || hit.deepLink,
            sourceSystem: 'ifinder',
            mediaType: hit.mediaType,
            language: hit.language,
            modificationDate: hit.modificationDate,
            score: hit.score,
            matchedQuery: query
          });
        }
      } catch (err) {
        this.logger.warn('corpus-search query failed', {
          component: 'CorpusSearchNodeExecutor',
          nodeId: node.id,
          query,
          error: err.message
        });
        errors.push({ query, error: err.message });
      }
    }

    const docs = Array.from(dedup.values());

    // Optionally fetch fulltext for each deduped doc. Sequential — keeps
    // this deterministic and well-behaved against iFinder throttling.
    if (fetchFulltext) {
      for (const doc of docs) {
        try {
          const content = await iFinderService.getContent({
            documentId: doc.docId,
            chatId,
            user,
            searchProfile,
            maxLength: maxFulltextChars
          });
          doc.fulltext = content?.content || '';
          doc.contentLength = content?.contentLength || 0;
        } catch (err) {
          this.logger.warn('corpus-search fulltext fetch failed', {
            component: 'CorpusSearchNodeExecutor',
            nodeId: node.id,
            docId: doc.docId,
            error: err.message
          });
          doc.fulltextError = err.message;
        }
      }
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
        queryErrors: errors
      },
      startedAt
    });

    this.logger.info('corpus-search complete', {
      component: 'CorpusSearchNodeExecutor',
      nodeId: node.id,
      queries: queries.length,
      candidates: docs.length,
      fetchedFulltext: fetchFulltext
    });

    return this.createSuccessResult(
      {
        total: docs.length,
        queriesExecuted: queries.length,
        queryErrors: errors
      },
      {
        stateUpdates: {
          [corpusVar]: docs,
          [coverageVar]: coverage
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
