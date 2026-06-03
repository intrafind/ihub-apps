/**
 * Executor for `quote-validator` workflow nodes.
 *
 * Runs after a `forEach` loop has populated `state.data._evidence`. For each
 * quote in each Evidence record:
 *
 *   1. Attempts a normalized substring match against the source fulltext
 *      (fast path — no LLM cost).
 *   2. On miss, calls an LLM with a focused prompt asking whether the quote
 *      really came from the source modulo normal PDF artifacts.
 *
 * Updates each quote's `validated`, `closestMatch`, and `confidence` fields
 * in place. Escalates an evidence record's `status` from `ok` to `partial`
 * when any of its quotes fail validation — but does NOT hard-fail the run.
 * The final report flags unvalidated quotes alongside the LLM's closest-
 * match suggestion so a human reviewer can spot-check.
 *
 * Source fulltext is located by docId, looking first in a workflow-supplied
 * corpus array (default state path: `_corpus`), then falling back to a
 * `source.fulltext` field on the evidence record itself. Either source
 * shape works, so the validator is usable both with and without the
 * `corpus-search` node populating fulltexts upstream.
 *
 * @module services/workflow/executors/QuoteValidatorNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import WorkflowLLMHelper from '../WorkflowLLMHelper.js';
import configCache from '../../../configCache.js';
import { actionTracker } from '../../../actionTracker.js';
import {
  planQuoteValidation,
  buildLlmVerdictPrompt,
  parseLlmQuoteVerdict
} from '../../auditQuotes/validateQuotes.js';

export class QuoteValidatorNodeExecutor extends BaseNodeExecutor {
  constructor(options = {}) {
    super(options);
    this.llmHelper = options.llmHelper || new WorkflowLLMHelper();
  }

  async execute(node, state, context) {
    const config = node.config || {};
    const {
      evidenceVar = '_evidence',
      coverageVar = '_coverage',
      corpusVar = '_corpus',
      modelId,
      maxSourceChars = 30000
    } = config;
    const language = context?.language || 'en';

    const evidence = this.resolveVariable(`$.data.${evidenceVar}`, state);
    if (!Array.isArray(evidence) || evidence.length === 0) {
      this.logger.info('quote-validator: no evidence to validate', {
        component: 'QuoteValidatorNodeExecutor',
        nodeId: node.id,
        evidenceVar
      });
      return this.createSuccessResult({ validatedRecords: 0, llmCalls: 0 });
    }

    const corpus = this.resolveVariable(`$.data.${corpusVar}`, state);
    const corpusMap = buildCorpusLookup(corpus);
    const coverage = cloneCoverage(this.resolveVariable(`$.data.${coverageVar}`, state));

    // Resolve which model to use for the LLM fallback only if we have evidence
    // that any quotes need it — saves a config-cache lookup on clean runs.
    let model = null;
    let apiKey = null;
    let llmCalls = 0;

    const updatedEvidence = [];
    emitProgress(context, `Validating quotes across ${evidence.length} document(s)…`);

    for (const record of evidence) {
      const updatedRecord = { ...record, quotes: [...(record.quotes || [])], failures: [...(record.failures || [])] };
      const sourceText = resolveSourceText(updatedRecord, corpusMap, maxSourceChars);

      const plan = planQuoteValidation({
        quotes: updatedRecord.quotes,
        sourceText: sourceText || ''
      });

      for (const decision of plan) {
        coverage.quotesChecked = (coverage.quotesChecked || 0) + 1;
        const original = updatedRecord.quotes[decision.index] || {};
        if (decision.validated) {
          updatedRecord.quotes[decision.index] = {
            ...original,
            validated: true,
            confidence: 'high'
          };
          coverage.quotesValidated = (coverage.quotesValidated || 0) + 1;
          continue;
        }
        if (!decision.needsLlm) {
          updatedRecord.quotes[decision.index] = {
            ...original,
            validated: false,
            confidence: 'low'
          };
          continue;
        }
        if (!sourceText) {
          // No source available — record as unvalidated and move on.
          updatedRecord.quotes[decision.index] = {
            ...original,
            validated: false,
            confidence: 'low',
            closestMatch: ''
          };
          updatedRecord.failures.push({
            code: 'QUOTE_NO_SOURCE',
            message: `Quote ${decision.index} could not be validated: no source text available for docId '${updatedRecord.source?.docId}'.`
          });
          continue;
        }

        // Lazily resolve model + key on first LLM need.
        if (!model) {
          const resolved = await this.resolveModelAndKey(modelId, language);
          if (!resolved.ok) {
            // Mark remaining quotes unvalidated and stop trying further LLM calls
            // for this run — the lack of a valid model is a run-level problem.
            updatedRecord.quotes[decision.index] = {
              ...original,
              validated: false,
              confidence: 'low'
            };
            updatedRecord.failures.push({
              code: 'QUOTE_LLM_UNAVAILABLE',
              message: resolved.error
            });
            continue;
          }
          model = resolved.model;
          apiKey = resolved.apiKey;
        }

        try {
          const { system, user } = buildLlmVerdictPrompt({
            quoteText: decision.text,
            sourceWindow: sourceText
          });
          const response = await this.llmHelper.executeStreamingRequest({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ],
            apiKey,
            options: { temperature: 0.1 },
            language
          });
          llmCalls++;
          const verdict = parseLlmQuoteVerdict(response?.content || '');
          updatedRecord.quotes[decision.index] = {
            ...original,
            validated: verdict.validated,
            closestMatch: verdict.closestMatch || undefined,
            confidence: verdict.confidence
          };
          if (verdict.validated) {
            coverage.quotesValidated = (coverage.quotesValidated || 0) + 1;
          }
        } catch (err) {
          updatedRecord.quotes[decision.index] = {
            ...original,
            validated: false,
            confidence: 'low'
          };
          updatedRecord.failures.push({
            code: 'QUOTE_LLM_ERROR',
            message: `LLM verdict failed for quote ${decision.index}: ${err.message}`
          });
        }
      }

      emitProgress(
        context,
        `Validated "${updatedRecord.source?.title || updatedRecord.source?.docId}" — ${plan.filter(p => p.validated).length}/${plan.length} fast-path, ${llmCalls} LLM check(s) so far`
      );

      // If any quote ended up unvalidated, escalate status to 'partial'
      // (unless it was already 'failed' from an upstream extraction error).
      const anyUnvalidated = updatedRecord.quotes.some(q => q.validated === false);
      if (anyUnvalidated && updatedRecord.status === 'ok') {
        updatedRecord.status = 'partial';
      }

      updatedEvidence.push(updatedRecord);
    }

    coverage.completedAt = coverage.completedAt || new Date().toISOString();

    this.logger.info('quote-validator complete', {
      component: 'QuoteValidatorNodeExecutor',
      nodeId: node.id,
      evidenceCount: updatedEvidence.length,
      llmCalls,
      quotesChecked: coverage.quotesChecked,
      quotesValidated: coverage.quotesValidated
    });

    return this.createSuccessResult(
      {
        validatedRecords: updatedEvidence.length,
        llmCalls,
        quotesChecked: coverage.quotesChecked,
        quotesValidated: coverage.quotesValidated
      },
      {
        stateUpdates: {
          [evidenceVar]: updatedEvidence,
          [coverageVar]: coverage
        }
      }
    );
  }

  async resolveModelAndKey(modelId, language) {
    const { data: models } = configCache.getModels();
    const model =
      models?.find(m => m.id === modelId) || models?.find(m => m.default) || models?.[0];
    if (!model) {
      return { ok: false, error: 'No model available for quote validation' };
    }
    const apiKeyResult = await this.llmHelper.verifyApiKey(model, language);
    if (!apiKeyResult.success) {
      return {
        ok: false,
        error: apiKeyResult.error?.message || 'API key verification failed for quote validator'
      };
    }
    return { ok: true, model, apiKey: apiKeyResult.apiKey };
  }
}

function buildCorpusLookup(corpus) {
  const map = new Map();
  if (!Array.isArray(corpus)) return map;
  for (const doc of corpus) {
    const docId = doc?.docId || doc?.id || doc?.documentId;
    if (!docId) continue;
    const fulltext = doc?.fulltext || doc?.content || doc?.text;
    if (typeof fulltext === 'string' && fulltext.length > 0) {
      map.set(String(docId), fulltext);
    }
  }
  return map;
}

function resolveSourceText(record, corpusMap, maxChars) {
  const docId = record?.source?.docId;
  let text = (docId && corpusMap.get(String(docId))) || record?.source?.fulltext || '';
  if (typeof text !== 'string') text = String(text || '');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return text;
}

function cloneCoverage(c) {
  if (!c || typeof c !== 'object') {
    return {
      candidates: { total: 0 },
      processed: 0,
      skipped: [],
      failed: [],
      quotesChecked: 0,
      quotesValidated: 0
    };
  }
  return {
    candidates: c.candidates || { total: 0 },
    processed: c.processed || 0,
    skipped: Array.isArray(c.skipped) ? [...c.skipped] : [],
    failed: Array.isArray(c.failed) ? [...c.failed] : [],
    quotesChecked: c.quotesChecked || 0,
    quotesValidated: c.quotesValidated || 0,
    startedAt: c.startedAt,
    completedAt: c.completedAt
  };
}

function emitProgress(context, message) {
  // Emit workflow.node.progress keyed by executionId; the workflowRunner
  // bridge re-emits on the chat's real chatId. This pattern is shared with
  // StructuredRecordNodeExecutor / TemplateRenderNodeExecutor.
  const executionId =
    context?.executionId || context?.runId || context?.chatId;
  if (!executionId) return;
  try {
    // chatId must equal executionId — the workflowRunner bridge filters on
    // `event.chatId === executionId`.
    actionTracker.emit('fire-sse', {
      event: 'workflow.node.progress',
      chatId: executionId,
      executionId,
      message
    });
  } catch {
    /* best-effort */
  }
}

export default QuoteValidatorNodeExecutor;
