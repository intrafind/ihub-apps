#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A list of sources the model wrote at the end of its answer (issue #3522):
 * the chat lists the cited sources under the answer, so a "Quellen:" /
 * "Sources:" list the model adds shows them twice. `findTrailingSourceList`
 * finds such a list — and nothing else: a summary with citations, links to
 * pages the turn did not find, a table or a list in the middle of the answer
 * stay part of the answer.
 *
 * Run: node --test server/tests/trailing-source-list.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findTrailingSourceList,
  resolveCitations,
  withoutTrailingSourceList
} from '../../shared/sources/index.js';

const page = (url, title, extra = {}) => ({
  id: `url:${url}`,
  provider: 'web',
  kind: 'page',
  url,
  title,
  private: false,
  ...extra
});

const medium = page('https://medium.com/@manzke', 'Daniel Manzke – Medium');
const podcast = page(
  'https://digitalwerk.podbean.com/e/168',
  'Zwischen Hype und echter Anwendung: KI Experte & Investor Daniel Manzke (DW #168)'
);
const fair = page(
  'https://techjobsfair.com/speakers/daniel-manzke',
  'Daniel Manzke Keynote Speaker | Tech Jobs Fair Berlin'
);
const github = page('https://github.com/manzke', 'manzke (Daniel Manzke) · GitHub');
const linkedin = page(
  'https://www.linkedin.com/in/manzke',
  'Daniel Manzke - IntraFind Software AG | LinkedIn'
);
const report = page('https://example.com/q3', 'Q3 2026: revenue grew 10 % year over year');
const contract = {
  id: 'ifinder:sp-1',
  provider: 'ifinder',
  kind: 'document',
  title: 'Supplier contract ACME',
  site: 'SharePoint',
  markers: ['r:1'],
  private: true
};

const set = { queries: ['Daniel Manzke'], items: [medium, podcast, fair, github, linkedin] };

const body =
  'Daniel Manzke ist Head of Engineering [1](https://medium.com/@manzke). ' +
  'Er spricht über KI [2](https://digitalwerk.podbean.com/e/168) und tritt als Keynote ' +
  'Speaker auf [3](https://techjobsfair.com/speakers/daniel-manzke).';

const find = (markdown, sources = set) =>
  findTrailingSourceList(markdown, resolveCitations(markdown, sources));

describe('finds a list of sources at the end of the answer', () => {
  it('the "Quellen:" list from the issue, after a rule', () => {
    const list =
      '\n\n---\n\n**Quellen:**\n' +
      '[1](https://medium.com/@manzke) – Daniel Manzke auf Medium\n' +
      '[2](https://digitalwerk.podbean.com/e/168) – DIGITALWERK Podcast #168\n' +
      '[3](https://techjobsfair.com/speakers/daniel-manzke) – Tech Jobs Fair Berlin\n' +
      '[4](https://github.com/manzke) – GitHub-Profil\n' +
      '[5](https://www.linkedin.com/in/manzke) – LinkedIn-Profil\n';
    const answer = body + list;
    const found = find(answer);
    assert.deepEqual(found, { start: body.length + 2, entries: 5 });
    assert.equal(withoutTrailingSourceList(answer, resolveCitations(answer, set)), body);
  });

  it('"Sources:", "## References" and a bold lead-in, with list markers', () => {
    const entries =
      '- [1](https://medium.com/@manzke) Daniel Manzke – Medium\n' +
      '- [Daniel Manzke Keynote Speaker](https://techjobsfair.com/speakers/daniel-manzke)\n';
    for (const leadIn of ['Sources:', '## References', '**Quellen**', '### Quellenangaben']) {
      const answer = `${body}\n\n${leadIn}\n${entries}`;
      assert.equal(find(answer)?.entries, 2, leadIn);
      assert.equal(find(answer)?.start, body.length + 2, leadIn);
    }
  });

  it('a numbered list of bare URLs with the site name', () => {
    const answer =
      `${body}\n\nReferenzen:\n\n` +
      '1. Medium: https://medium.com/@manzke\n\n' +
      '2. GitHub https://github.com/manzke\n';
    assert.equal(find(answer)?.entries, 2);
  });

  it('a rule alone introduces the list', () => {
    const answer = `${body}\n\n***\n[1](https://medium.com/@manzke) Medium\n`;
    assert.equal(find(answer)?.start, body.length + 2);
  });

  it('iAssistant markers count like links', () => {
    const sources = { items: [contract] };
    const answer =
      'The notice period is three months <cite type="r">1</cite>.\n\n' +
      'Quellen:\n- <cite type="r">1</cite> Supplier contract ACME (SharePoint)';
    assert.equal(find(answer, sources)?.entries, 1);
  });

  it('a source only the list names is still among the cited ones', () => {
    const answer = `${body}\n\nQuellen:\n- [4](https://github.com/manzke) GitHub\n`;
    const citations = resolveCitations(answer, set);
    assert.ok(find(answer));
    assert.ok(citations.cited.some(source => source.url === github.url));
  });
});

describe('leaves everything else in the answer', () => {
  it('a summary whose items are claims with citations', () => {
    const sources = { items: [medium, report] };
    const answer =
      'The company grew [1](https://example.com/q3).\n\n**Summary:**\n' +
      '- Revenue in the third quarter grew by ten percent compared with last year, ' +
      'driven by new customers [1](https://example.com/q3)\n';
    assert.equal(find(answer, sources), null);
  });

  it('a short claim that restates a title, its citation at the end', () => {
    const sources = { items: [medium, report] };
    const answer =
      'Results are in [1](https://example.com/q3).\n\n**Summary:**\n' +
      '- Revenue grew 10 % year over year [1](https://example.com/q3)\n';
    assert.equal(find(answer, sources), null);
  });

  it('links to pages the turn did not find', () => {
    const answer = `${body}\n\nSee also:\n- [Wikipedia](https://de.wikipedia.org/wiki/KI)\n`;
    assert.equal(find(answer), null);
  });

  it('a list without a lead-in or a rule', () => {
    const answer = `${body}\n\n- [1](https://medium.com/@manzke) Medium\n`;
    assert.equal(find(answer), null);
  });

  it('a lead-in that is a sentence', () => {
    const answer = `${body}\n\nHere are the pages I used to answer your question:\n- [1](https://medium.com/@manzke) Medium\n`;
    assert.equal(find(answer), null);
  });

  it('an answer that is only a list of links (nothing cited before it)', () => {
    const answer =
      'Links:\n- [Daniel Manzke – Medium](https://medium.com/@manzke)\n' +
      '- [GitHub](https://github.com/manzke)\n';
    assert.equal(find(answer), null);
  });

  it('a list in the middle of the answer', () => {
    const answer = `${body}\n\nQuellen:\n- [1](https://medium.com/@manzke) Medium\n\nMehr dazu später.`;
    assert.equal(find(answer), null);
  });

  it('a table of sources', () => {
    const answer =
      `${body}\n\nQuellen:\n| # | Quelle |\n|---|---|\n` +
      '| [1](https://medium.com/@manzke) | Medium |\n';
    assert.equal(find(answer), null);
  });

  it('a list inside a code block', () => {
    const answer = `${body}\n\n\`\`\`md\nQuellen:\n[1](https://medium.com/@manzke) Medium\n\`\`\``;
    assert.equal(find(answer), null);
  });

  it('one entry that is not a source entry keeps the whole list', () => {
    const answer =
      `${body}\n\nQuellen:\n` +
      '- [1](https://medium.com/@manzke) Medium\n' +
      '- [2](https://digitalwerk.podbean.com/e/168) Ein sehr hörenswertes Gespräch über ' +
      'Unternehmen, Investitionen und die Zukunft der Arbeit mit Sprachmodellen in Europa\n';
    assert.equal(find(answer), null);
  });

  it('brackets and parentheses that never close take linear time, not forever', () => {
    // The kind of input a backtracking link pattern blows up on (ReDoS).
    const answer = tail => `${body}\n\nQuellen:\n${tail}\n`;
    const started = Date.now();
    assert.equal(find(answer(`[${'[a]('.repeat(400)}`)), null);
    assert.equal(find(answer('x'.repeat(50000))), null);
    // A source link and nothing but punctuation is still an entry.
    const stray = `[1](https://medium.com/@manzke) ${'['.repeat(1500)}${'('.repeat(400)}`;
    assert.equal(find(answer(stray))?.entries, 1);
    assert.ok(Date.now() - started < 1000);
  });

  it('an answer without cited sources', () => {
    assert.equal(findTrailingSourceList('Quellen:\n- Medium', resolveCitations('', set)), null);
    assert.equal(findTrailingSourceList('', null), null);
    assert.equal(withoutTrailingSourceList(body, resolveCitations(body, set)), body);
  });
});
