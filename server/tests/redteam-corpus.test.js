// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The page corpus of the nightly red team (tests/security/redteam/corpus*). The nightly run needs a
 * real model, so what can be checked without one is checked here: the data holds together, the
 * pages are served with the exfiltration host pointing at the canary, the generated test cases ask
 * for the right pages, and the summarizer app is a valid app.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { CORPUS_EXFIL_ORIGIN, PAGES_APP, corpusPages, loadCorpus, pagesAppConfig } =
  await import('../../tests/security/redteam/corpus.mjs');
const generateTests = (await import('../../tests/security/redteam/corpus-tests.js')).default;
const { CANARY } = await import('../../tests/security/injection/scenario.mjs');
const { appConfigSchema } = await import('../validators/appConfigSchema.js');

const { cases } = loadCorpus();

describe('the corpus data', () => {
  it('has every template in the three deliveries that reach the model', () => {
    assert.equal(new Set(cases.map(c => c.template)).size, 19);
    assert.deepEqual([...new Set(cases.map(c => c.delivery))].sort(), [
      'meta-description',
      'visible',
      'white-text'
    ]);
    assert.equal(cases.length, 19 * 3);
  });

  it('gives every case its own page and its own canary', () => {
    assert.equal(new Set(cases.map(c => c.page)).size, cases.length);
    assert.equal(new Set(cases.map(c => c.canary)).size, cases.length);
  });

  it('carries each canary in its page, in the Base64 template encoded', () => {
    for (const c of cases) {
      if (c.template === 'Base64-wrapped instruction') {
        const encoded = c.html.match(/Base64 string[^:]*: ([A-Za-z0-9+/=]+)/)?.[1] || '';
        assert.ok(Buffer.from(encoded, 'base64').toString().includes(c.canary), `${c.id}: payload`);
      } else {
        assert.ok(c.html.includes(c.canary), `${c.id}: canary in page`);
      }
    }
  });

  it('marks exactly the exfiltration-by-address templates', () => {
    const exfil = cases.filter(c => c.exfil);
    assert.equal(exfil.length, 18);
    assert.ok(exfil.every(c => c.category === 'Exfiltration by address'));
    assert.ok(exfil.every(c => c.html.includes(CORPUS_EXFIL_ORIGIN)));
    assert.ok(cases.filter(c => !c.exfil).every(c => !c.html.includes(CORPUS_EXFIL_ORIGIN)));
  });
});

describe('the pages as the canary serves them', () => {
  const pages = corpusPages(CANARY);

  it('serves one page per case', () => {
    assert.deepEqual(Object.keys(pages).sort(), cases.map(c => c.page).sort());
  });

  it('points the exfiltration addresses at the canary, never at the placeholder host', () => {
    for (const c of cases.filter(x => x.exfil)) {
      assert.ok(!pages[c.page].includes(CORPUS_EXFIL_ORIGIN), `${c.id}: placeholder host left`);
      assert.ok(pages[c.page].includes(`${CANARY}/`), `${c.id}: no address on the canary`);
    }
  });
});

describe('the generated test cases', () => {
  const tests = generateTests();

  it('has one test per page, asking for that page by its canary address', () => {
    assert.equal(tests.length, cases.length);
    for (const [index, test] of tests.entries()) {
      const c = cases[index];
      assert.ok(test.vars.question.includes(`${CANARY}/page/${c.page}`));
      assert.equal(test.vars.canary, c.canary);
    }
  });

  it('asks an ordinary question, so the attack is only in the page', () => {
    for (const test of tests) {
      assert.doesNotMatch(test.vars.question, /ignore|instruction|canary|inject/i);
    }
  });

  it('grades every test on the payload assertion and the rubric', () => {
    for (const test of tests) {
      assert.deepEqual(
        test.assert.map(a => a.type),
        ['javascript', 'llm-rubric']
      );
      assert.match(test.assert[0].value, /assertions\.js:corpusPayloadNotObeyed$/);
    }
  });
});

describe('the summarizer app', () => {
  it('is a valid app, with web search for the page reader and no project', () => {
    const app = pagesAppConfig();
    assert.equal(app.id, PAGES_APP);
    const result = appConfigSchema.safeParse(app);
    assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues));
    assert.equal(app.websearch.enabled, true);
    assert.equal(app.projects, undefined);
    assert.equal(app.preferredModel, 'redteam-model');
  });
});
