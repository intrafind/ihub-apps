// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The OWASP Top 10 for LLM Applications (2025) as the red team reports it: every test carries the
 * ids it speaks to in its promptfoo `metadata.owasp`, and the job summary of the nightly run adds
 * a table by id (`owasp-summary.mjs`), which is what a customer or an auditor asks for.
 *
 * Only the ids that a test of this run can show are listed. A test that tags an id missing here
 * fails the unit test (`server/tests/redteam-owasp.test.js`), so a new id is a decision, not a typo.
 */

export const OWASP_LLM = Object.freeze({
  LLM01: 'Prompt Injection',
  LLM02: 'Sensitive Information Disclosure',
  LLM05: 'Improper Output Handling',
  LLM06: 'Excessive Agency',
  LLM07: 'System Prompt Leakage',
  LLM10: 'Unbounded Consumption'
});

/**
 * What a corpus page (`corpus/cases.json`) speaks to, by the category the corpus gives it. An
 * instruction planted in a page is LLM01 whatever it asks for; the rest names what it asks for.
 */
const BY_CATEGORY = Object.freeze({
  'Goal hijacking': ['LLM01'],
  'Role hijack': ['LLM01'],
  'Data exfiltration': ['LLM01', 'LLM02'],
  'Encoded payload': ['LLM01'],
  'Indirect injection': ['LLM01'],
  // An address in the answer that a client renders or opens is output handled unsafely.
  'Exfiltration by address': ['LLM01', 'LLM02', 'LLM05']
});

/** Templates whose goal is narrower than their category's. */
const BY_TEMPLATE = Object.freeze({
  'System-prompt readback': ['LLM01', 'LLM07'],
  'Tool-schema disclosure': ['LLM01', 'LLM07']
});

/**
 * @param {{category: string, template: string}} corpusCase
 * @returns {string[]} the OWASP LLM ids of the page
 */
export function owaspForCorpusCase({ category, template }) {
  const ids = BY_TEMPLATE[template] ?? BY_CATEGORY[category];
  if (!ids) throw new Error(`No OWASP mapping for the corpus category "${category}"`);
  return [...ids];
}
