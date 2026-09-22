/**
 * Web search research guidance (issue #2484).
 *
 * Chat turns allow several tool rounds, but a web search chat used to run one
 * search and answer, because nothing told the model to do more. When web search
 * is on for the turn, RequestBuilder now appends guidance telling the model to
 * research in several steps — the positive counterpart of
 * appendWebSearchDisabledNotice (covered in gemini-malformed-function-call.test.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendWebSearchResearchGuidance,
  appendWebSearchDisabledNotice,
  resolveWebSearchResearchGuidance,
  DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE
} from '../services/chat/RequestBuilder.js';

const PROMPT = 'You are a helpful assistant.';
const appWith = (websearch = {}) => ({ id: 'web-app', websearch: { enabled: true, ...websearch } });
const messages = (content = PROMPT) => [
  { role: 'system', content },
  { role: 'user', content: 'Compare X and Y on price, features and recent news.' }
];

test('guidance is appended when web search is on by default', () => {
  const msgs = messages();
  const appended = appendWebSearchResearchGuidance(
    msgs,
    appWith({ enabledByDefault: true }),
    undefined
  );

  assert.equal(appended, true);
  assert.equal(msgs[0].content, `${PROMPT}\n\n${DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE}`);
  assert.match(msgs[0].content, /several searches/);
  assert.match(msgs[0].content, /URLs/);
  assert.equal(msgs[1].content, 'Compare X and Y on price, features and recent news.');
});

test('guidance is not appended when web search is off by default', () => {
  const msgs = messages();
  assert.equal(appendWebSearchResearchGuidance(msgs, appWith(), undefined), false);
  assert.equal(msgs[0].content, PROMPT);
});

test('the user toggle overrides the app default in both directions', () => {
  const on = messages();
  assert.equal(appendWebSearchResearchGuidance(on, appWith(), true), true);
  assert.ok(on[0].content.includes(DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE));

  const off = messages();
  assert.equal(
    appendWebSearchResearchGuidance(off, appWith({ enabledByDefault: true }), false),
    false
  );
  assert.equal(off[0].content, PROMPT);
});

test('apps without web search get no guidance', () => {
  const msgs = messages();
  assert.equal(appendWebSearchResearchGuidance(msgs, { id: 'plain' }, true), false);
  assert.equal(
    appendWebSearchResearchGuidance(msgs, { id: 'x', websearch: { enabled: false } }, true),
    false
  );
  assert.equal(msgs[0].content, PROMPT);
});

test('no system message → nothing to amend', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.equal(appendWebSearchResearchGuidance(msgs, appWith(), true), false);
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }]);

  const nonString = [{ role: 'system', content: [{ type: 'text', text: PROMPT }] }];
  assert.equal(appendWebSearchResearchGuidance(nonString, appWith(), true), false);
});

test('an empty system message gets the guidance alone', () => {
  const msgs = messages('');
  assert.equal(appendWebSearchResearchGuidance(msgs, appWith(), true), true);
  assert.equal(msgs[0].content, DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE);
});

test('appending is idempotent', () => {
  const msgs = messages();
  assert.equal(appendWebSearchResearchGuidance(msgs, appWith(), true), true);
  const once = msgs[0].content;
  assert.equal(appendWebSearchResearchGuidance(msgs, appWith(), true), false);
  assert.equal(msgs[0].content, once);
});

test('researchGuidance: false turns the guidance off', () => {
  const msgs = messages();
  assert.equal(
    appendWebSearchResearchGuidance(msgs, appWith({ researchGuidance: false }), true),
    false
  );
  assert.equal(msgs[0].content, PROMPT);
});

test('a custom researchGuidance string replaces the built-in text', () => {
  const custom = 'Search at least twice and cite every source.';
  const msgs = messages();
  assert.equal(
    appendWebSearchResearchGuidance(msgs, appWith({ researchGuidance: `  ${custom}\n` }), true),
    true
  );
  assert.equal(msgs[0].content, `${PROMPT}\n\n${custom}`);
  assert.ok(!msgs[0].content.includes(DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE));
});

test('resolveWebSearchResearchGuidance falls back to the default', () => {
  assert.equal(resolveWebSearchResearchGuidance(appWith()), DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE);
  assert.equal(
    resolveWebSearchResearchGuidance(appWith({ researchGuidance: true })),
    DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE
  );
  assert.equal(
    resolveWebSearchResearchGuidance(appWith({ researchGuidance: '   ' })),
    DEFAULT_WEB_SEARCH_RESEARCH_GUIDANCE
  );
  assert.equal(resolveWebSearchResearchGuidance(appWith({ researchGuidance: false })), null);
});

test('guidance and the disabled notice never both apply', () => {
  for (const toggle of [undefined, true, false]) {
    for (const enabledByDefault of [true, false]) {
      const msgs = messages();
      const app = appWith({ enabledByDefault });
      const guidance = appendWebSearchResearchGuidance(msgs, app, toggle);
      const notice = appendWebSearchDisabledNotice(msgs, app, toggle);
      assert.notEqual(guidance, notice, `toggle=${toggle} enabledByDefault=${enabledByDefault}`);
    }
  }
});
