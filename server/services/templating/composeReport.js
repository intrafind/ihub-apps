/**
 * Render a Markdown report from a workflow-author-supplied template and a
 * conventional context shape (`{records, coverage, synthesis, ...extra}`).
 *
 * Pure function so the caller can persist the result however it likes
 * (artifact store, response body, test fixture). The context keys
 * (`records`, `coverage`, `synthesis`) are an aggregation convention used by
 * map-reduce workflows — a caller that doesn't follow the convention can
 * pass empty defaults and put its own keys under `extra`.
 *
 * No default template is provided: omitting `template` is treated as a
 * configuration error so misconfigured workflows fail loudly.
 *
 * @module services/templating/composeReport
 */

import { renderTemplate } from './renderTemplate.js';

/**
 * @param {Object} args
 * @param {string} args.template       author-supplied template (required)
 * @param {Array}  [args.records]      list of records (state.data._records by convention)
 * @param {Object} [args.coverage]     coverage state (state.data._coverage by convention)
 * @param {string} [args.synthesis]    optional pre-computed cross-document text
 * @param {Object} [args.extra]        additional template context (run id, workflow id, etc.)
 * @returns {{ markdown: string, bytes: number }}
 */
export function composeReport(args) {
  const { records = [], coverage, synthesis = '', template, extra = {} } = args || {};

  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('composeReport: `template` is required');
  }

  const context = {
    records: Array.isArray(records) ? records : [],
    coverage: hydrateCoverage(coverage),
    synthesis: synthesis || '',
    ...extra
  };

  const markdown = renderTemplate(template, context);
  return {
    markdown,
    bytes: Buffer.byteLength(markdown)
  };
}

function hydrateCoverage(c) {
  return {
    candidates: c?.candidates || { total: 0 },
    processed: c?.processed ?? 0,
    skipped: Array.isArray(c?.skipped) ? c.skipped : [],
    failed: Array.isArray(c?.failed) ? c.failed : [],
    quotesChecked: c?.quotesChecked ?? 0,
    quotesValidated: c?.quotesValidated ?? 0,
    startedAt: c?.startedAt,
    completedAt: c?.completedAt
  };
}

export default composeReport;
