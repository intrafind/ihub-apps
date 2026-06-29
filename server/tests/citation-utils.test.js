// Plain-node test (node server/tests/citation-utils.test.js).
//
// Citations were stored with multiplicative duplication (run wf-exec-78d4c018:
// 23,796 raw entries for 621 unique URLs — clean powers of 2, i.e. doubled once
// per review round). Root cause: childInitial copies the parent _citations into
// each round's child, and bubble-up CONCATENATES the child's citations (= that
// copy + new) back onto the parent — so everything is duplicated every round.
// dedupeCitations + normalizeCitationUrl collapse this (and true URL variants).
import { normalizeCitationUrl, dedupeCitations } from '../services/workflow/citationUtils.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

// ---- normalizeCitationUrl: collapses true variants of the SAME resource ----
const n = normalizeCitationUrl;
check('trailing slash', n('https://x.com/a/') === n('https://x.com/a'));
check('www prefix', n('https://www.x.com/a') === n('https://x.com/a'));
check('http vs https', n('http://x.com/a') === n('https://x.com/a'));
check('#fragment stripped', n('https://x.com/a#sec') === n('https://x.com/a'));
check('host case-insensitive', n('https://X.COM/a') === n('https://x.com/a'));
check('utm tracking param stripped', n('https://x.com/a?utm_source=g&utm_medium=cpc') === n('https://x.com/a'));
check('REAL query param preserved', n('https://x.com/p?id=42') !== n('https://x.com/p?id=99'));
check('different paths NOT merged', n('https://gartner.com/analyst/aaa') !== n('https://gartner.com/analyst/bbb'));
check('non-string → empty', n(null) === '' && n(42) === '');

// ---- dedupeCitations: keep first occurrence, preserve order ----
{
  const list = [
    { url: 'https://x.com/a', title: 'A' },
    { url: 'https://www.x.com/a/', title: 'A-variant' }, // dup of #1 after normalize
    { url: 'https://y.com/b', title: 'B' },
    { url: 'https://x.com/a#top', title: 'A-frag' }, // dup of #1
    { title: 'no url' }, // dropped
    { url: 'https://z.com/c', title: 'C' }
  ];
  const out = dedupeCitations(list);
  check('collapses variants to unique resources', out.length === 3, `got ${out.length}`);
  check('keeps FIRST occurrence', out[0].title === 'A');
  check('preserves first-seen order', out.map(c => c.title).join(',') === 'A,B,C');
}

check('non-array → []', Array.isArray(dedupeCitations(null)) && dedupeCitations(null).length === 0);

// ---- The doubling scenario: parent + child(=copy of parent + new) concat ----
{
  const parent = [{ url: 'https://a.com' }, { url: 'https://b.com' }];
  const childCopyPlusNew = [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }];
  const concatenated = [...parent, ...childCopyPlusNew]; // what bubble-up produces today
  check('concat has the duplication', concatenated.length === 5);
  const deduped = dedupeCitations(concatenated);
  check('dedupe collapses to the true unique set', deduped.length === 3, `got ${deduped.length}`);
  check('dedupe is idempotent', dedupeCitations(deduped).length === 3);
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
