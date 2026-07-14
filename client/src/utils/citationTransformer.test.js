#!/usr/bin/env node

/**
 * Tests for transformCitations()'s hover-preview/a11y attributes.
 *
 * Assistant messages contain <cite type="s">N</cite> / <cite type="r">N</cite>
 * tags emitted by the LLM. transformCitations() turns those into interactive
 * badges; this covers the excerpt lookup (from citations.references /
 * citations.resultItems), truncation, HTML-attribute escaping, and the
 * no-citations-data fallback.
 *
 * Run directly: `node client/src/utils/citationTransformer.test.js`.
 */

import { transformCitations } from './citationTransformer.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 transformCitations\n');

// --- Source passage citations (type="s") ---

const withSourcePreview = transformCitations('<p>Answer <cite type="s">1</cite>.</p>', {
  references: [{ index: 1, content: 'The sky is blue because of Rayleigh scattering.' }]
});

check(
  'source badge embeds a data-citation-preview excerpt',
  withSourcePreview.includes(
    'data-citation-preview="The sky is blue because of Rayleigh scattering."'
  ),
  withSourcePreview
);

check(
  'source badge aria-label includes the excerpt',
  withSourcePreview.includes(
    'aria-label="Source 1: The sky is blue because of Rayleigh scattering."'
  ),
  withSourcePreview
);

check(
  'source badge keeps type/num data attributes and a11y role/tabindex',
  withSourcePreview.includes('data-citation-type="s"') &&
    withSourcePreview.includes('data-citation-num="1"') &&
    withSourcePreview.includes('role="button"') &&
    withSourcePreview.includes('tabindex="0"'),
  withSourcePreview
);

// --- Result/document citations (type="r"), 1-based position in resultItems ---

const withResultPreview = transformCitations('<p>See <cite type="r">2</cite>.</p>', {
  resultItems: [{ title: 'First Doc' }, { title: 'Annual Report 2025' }]
});

check(
  "result badge (2nd resultItem) uses that item's title as the excerpt",
  withResultPreview.includes('data-citation-preview="Annual Report 2025"') &&
    withResultPreview.includes('aria-label="Document 2: Annual Report 2025"'),
  withResultPreview
);

// --- No citations data supplied: falls back to a plain numbered label ---

const withoutCitations = transformCitations('<cite type="s">3</cite>');
check(
  'falls back to "Source N" aria-label with no data-citation-preview when citations are absent',
  withoutCitations.includes('aria-label="Source 3"') &&
    !withoutCitations.includes('data-citation-preview'),
  withoutCitations
);

// --- Long excerpts are truncated ---

const longContent = 'x'.repeat(300);
const withLongPreview = transformCitations('<cite type="s">1</cite>', {
  references: [{ index: 1, content: longContent }]
});
check(
  'excerpts longer than 160 chars are truncated with an ellipsis',
  withLongPreview.includes(`${'x'.repeat(160)}…`) && !withLongPreview.includes('x'.repeat(161)),
  withLongPreview
);

// --- Excerpt text is escaped for safe attribute embedding ---

const withUnsafeContent = transformCitations('<cite type="s">1</cite>', {
  references: [{ index: 1, content: 'Says "hello" <b>&amp;</b> goodbye' }]
});
check(
  'excerpt text is HTML-attribute-escaped',
  withUnsafeContent.includes(
    'data-citation-preview="Says &quot;hello&quot; &lt;b&gt;&amp;amp;&lt;/b&gt; goodbye"'
  ),
  withUnsafeContent
);

// --- Non-string / empty input passes through untouched ---

check('null input passes through unchanged', transformCitations(null) === null);
check('empty string passes through unchanged', transformCitations('') === '');

console.log(`\n${failures === 0 ? '✅ All tests passed' : `❌ ${failures} test(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
