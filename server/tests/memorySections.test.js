#!/usr/bin/env node

/**
 * Unit tests for the tripartite memory section logic (memorySections.js).
 *
 * Run directly: `node server/tests/memorySections.test.js`.
 */

import {
  applyDeltaToBody,
  normalizeDelta,
  mergeSectionBody,
  parseEntriesFromText,
  stripSourceMarkers,
  splitBody,
  AGENT_MARKER
} from '../agents/memory/memorySections.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// ── parseEntriesFromText ───────────────────────────────────────────────────
{
  check(
    'bullet list → one entry per bullet',
    JSON.stringify(parseEntriesFromText('- a\n- b\n- c')) === JSON.stringify(['a', 'b', 'c'])
  );
  check(
    'plain paragraph → single entry',
    JSON.stringify(parseEntriesFromText('hello world')) === JSON.stringify(['hello world'])
  );
  check('empty → []', JSON.stringify(parseEntriesFromText('   ')) === JSON.stringify([]));
  check(
    'wrapped continuation folds into entry',
    JSON.stringify(parseEntriesFromText('- first line\n  continued\n- second')) ===
      JSON.stringify(['first line continued', 'second'])
  );
}

// ── normalizeDelta ─────────────────────────────────────────────────────────
{
  const n1 = normalizeDelta({ mode: 'append', sections: { Semantic: '- x\n- y' } });
  check('canonical key parsed', n1.sections.Semantic && n1.sections.Semantic.length === 2);

  const n2 = normalizeDelta({ semantic: 'fact', episodic: '- ev1' });
  check('lowercase keys parsed (flat)', !!n2.sections.Semantic && !!n2.sections.Episodic);

  const n3 = normalizeDelta({ content: 'legacy fact' });
  check(
    'legacy content → Semantic',
    JSON.stringify(n3.sections.Semantic) === JSON.stringify(['legacy fact'])
  );

  const n4 = normalizeDelta({ mode: 'replace', sections: { Semantic: '   ' } });
  check('whitespace-only section dropped', Object.keys(n4.sections).length === 0);

  check('mode defaults to append', normalizeDelta({}).mode === 'append');
  check('replace mode preserved', normalizeDelta({ mode: 'replace' }).mode === 'replace');
}

// ── mergeSectionBody: append vs replace + immutability ─────────────────────
{
  const existing = `- human fact\n- agent old ${AGENT_MARKER}`;

  const appended = mergeSectionBody(existing, ['agent new'], 'append');
  check('append keeps human entry', appended.includes('- human fact'));
  check('append keeps prior agent entry', appended.includes('agent old'));
  check(
    'append adds new agent entry with marker',
    appended.includes(`- agent new ${AGENT_MARKER}`)
  );

  const replaced = mergeSectionBody(existing, ['agent fresh'], 'replace');
  check('replace KEEPS human entry (immutable)', replaced.includes('- human fact'));
  check('replace DROPS prior agent entry', !replaced.includes('agent old'));
  check('replace adds new agent entry', replaced.includes(`- agent fresh ${AGENT_MARKER}`));

  // Unmarked bullets are treated as human and protected.
  const unmarked = mergeSectionBody('- plain note', ['agent x'], 'replace');
  check('unmarked bullet protected on replace', unmarked.includes('- plain note'));
}

// ── applyDeltaToBody: preamble + operator sections preserved ───────────────
{
  const body = [
    'Some preamble line.',
    '',
    '## Corpus Map',
    '',
    '- operator built this',
    '',
    '## Semantic',
    '',
    `- existing agent fact ${AGENT_MARKER}`
  ].join('\n');

  const next = applyDeltaToBody(body, {
    mode: 'append',
    sections: { Semantic: ['new fact'], Episodic: ['2026-06-16: did a thing'] }
  });

  check('preamble preserved', next.includes('Some preamble line.'));
  check(
    'operator section preserved',
    next.includes('## Corpus Map') && next.includes('- operator built this')
  );
  check('existing agent fact preserved on append', next.includes('existing agent fact'));
  check('new semantic fact added', next.includes(`- new fact ${AGENT_MARKER}`));
  check(
    'episodic section created',
    next.includes('## Episodic') && next.includes('2026-06-16: did a thing')
  );

  // Replace must not touch the operator section even though it isn't tripartite.
  const replaced = applyDeltaToBody(body, {
    mode: 'replace',
    sections: { Semantic: ['only this'] }
  });
  check('replace leaves operator section intact', replaced.includes('- operator built this'));
  check('replace drops old agent fact', !replaced.includes('existing agent fact'));
  check('replace keeps new agent fact', replaced.includes('only this'));
}

// ── splitBody / stripSourceMarkers ─────────────────────────────────────────
{
  const { preamble, sections } = splitBody('intro\n## A\n- x\n## B\n- y');
  check('splitBody preamble', preamble.trim() === 'intro');
  check('splitBody two sections', sections.length === 2 && sections[0].heading === 'A');

  check(
    'stripSourceMarkers removes markers',
    stripSourceMarkers(`- a ${AGENT_MARKER}\n- b <!-- src:human -->`) === '- a\n- b'
  );
}

console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
process.exit(failures === 0 ? 0 : 1);
