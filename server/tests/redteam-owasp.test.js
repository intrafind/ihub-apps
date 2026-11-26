// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The OWASP tagging of the red team (`tests/security/redteam/owasp.mjs`) and the summary by id
 * (`owasp-summary.mjs`) that the nightly job prints.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const redteam = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/security/redteam'
);
const { OWASP_LLM, owaspForCorpusCase } = await import(path.join(redteam, 'owasp.mjs'));
const { groupByOwasp, owaspSummary } = await import(path.join(redteam, 'owasp-summary.mjs'));
const { loadCorpus } = await import(path.join(redteam, 'corpus.mjs'));
const { default: corpusTests } = await import(path.join(redteam, 'corpus-tests.js'));

describe('OWASP tagging', () => {
  it('maps every corpus page to ids the report knows', () => {
    for (const c of loadCorpus().cases) {
      const ids = owaspForCorpusCase(c);
      assert.ok(ids.length > 0, c.id);
      for (const id of ids) assert.ok(id in OWASP_LLM, `${c.id}: ${id}`);
    }
  });

  it('refuses a corpus category it has no mapping for', () => {
    assert.throws(
      () => owaspForCorpusCase({ category: 'Something new', template: 'x' }),
      /No OWASP mapping/
    );
  });

  it('tags the system-prompt readback pages with LLM07 and the address pages with LLM05', () => {
    const find = template => loadCorpus().cases.find(c => c.template === template);
    assert.ok(owaspForCorpusCase(find('System-prompt readback')).includes('LLM07'));
    assert.ok(
      owaspForCorpusCase(find('Markdown image with data in the address')).includes('LLM05')
    );
  });

  it('puts the ids on every test of the corpus run', () => {
    for (const test of corpusTests()) {
      assert.ok(Array.isArray(test.metadata.owasp) && test.metadata.owasp.length > 0);
    }
  });

  it('tags every hand-written test of the question run with ids the report knows', () => {
    const config = fs.readFileSync(path.join(redteam, 'promptfooconfig.yaml'), 'utf8');
    const descriptions = [...config.matchAll(/^ {2}- description: (.+)$/gm)].map(m => m[1]);
    const tagged = [...config.matchAll(/^ {6}owasp: \[(.+)\]$/gm)].map(m =>
      m[1].split(',').map(id => id.trim().replaceAll("'", ''))
    );
    assert.ok(descriptions.length > 0);
    assert.equal(tagged.length, descriptions.length, 'every test has an owasp tag');
    for (const id of tagged.flat()) assert.ok(id in OWASP_LLM, id);
  });
});

describe('summary by OWASP id', () => {
  const row = (description, owasp, success) => ({
    testCase: { description, metadata: { owasp } },
    success
  });
  const file = {
    results: {
      results: [
        row('Goal hijack', ['LLM01'], true),
        row('Goal hijack', ['LLM01'], false),
        row('Readback', ['LLM01', 'LLM07'], true),
        { testCase: { description: 'No tags' }, success: true }
      ]
    }
  };

  it('counts a run for every id its test carries, and lists the untagged', () => {
    const groups = groupByOwasp([file]);
    assert.deepEqual(
      [...groups.entries()].map(([id, g]) => [id, g.tests.size, g.passed, g.runs]),
      [
        ['LLM01', 2, 2, 3],
        ['LLM07', 1, 1, 1],
        ['untagged', 1, 1, 1]
      ]
    );
  });

  it('prints a table in the order of the ids, with the failing tests', () => {
    const text = owaspSummary([file]);
    const lines = text.split('\n');
    assert.match(text, /^## Red team by OWASP LLM Top 10 \(2025\)/);
    assert.match(
      lines.find(l => l.startsWith('| LLM01')),
      /Prompt Injection \| 2 \| 2\/3 \| Goal hijack \|$/
    );
    assert.ok(
      lines.findIndex(l => l.startsWith('| LLM07')) > lines.findIndex(l => l.startsWith('| LLM01'))
    );
    assert.ok(lines.some(l => l.startsWith('| untagged')));
  });

  it('says so when there are no results', () => {
    assert.match(owaspSummary([{}]), /No results\./);
  });

  it('reads the result files of the CLI and skips a missing or empty one', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'owasp-'));
    const good = path.join(dir, 'results.json');
    fs.writeFileSync(good, JSON.stringify(file));
    fs.writeFileSync(path.join(dir, 'empty.json'), '');
    const out = execFileSync(
      process.execPath,
      [
        path.join(redteam, 'owasp-summary.mjs'),
        good,
        path.join(dir, 'empty.json'),
        path.join(dir, 'missing.json')
      ],
      { encoding: 'utf8' }
    );
    assert.match(out, /\| LLM01 \| Prompt Injection \| 2 \| 2\/3 \|/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('failing pages run again', () => {
  const row = (description, success, reason) => ({
    testCase: { description },
    success,
    ...(reason && { gradingResult: { reason } })
  });
  const first = {
    results: {
      results: [row('A', false), row('B', true), row('C', false), row('D', false)]
    }
  };
  const rerun = {
    results: {
      results: [
        row('A', false, 'Page obeyed: the answer starts with the canary'),
        row('A', false, 'Page obeyed: the answer starts with the canary'),
        row('C', true),
        row('C', false, 'The model called the attacker'),
        row('B', false, 'not in the first failures')
      ]
    }
  };

  it('puts the runs of every page that failed first side by side', async () => {
    const { rerunRows } = await import(path.join(redteam, 'rerun-summary.mjs'));
    assert.deepEqual(
      rerunRows(first, rerun).map(r => [r.description, r.failed, r.runs]),
      [
        ['A', 3, 3],
        ['C', 2, 3],
        ['D', 1, 1]
      ]
    );
  });

  it('reads the table: every time, sometimes, not run again, and a first run without failures', async () => {
    const { rerunSummary } = await import(path.join(redteam, 'rerun-summary.mjs'));
    const text = rerunSummary(first, rerun);
    assert.match(text, /\| A \| 3 of 3 \| every time \|/);
    assert.match(text, /\| C \| 2 of 3 \| sometimes \|/);
    assert.match(text, /\| D \| 1 of 1 \| not run again \|/);
    assert.doesNotMatch(text, /\| B \|/);
    assert.match(rerunSummary({ results: { results: [row('A', true)] } }, {}), /No page failed/);
  });

  it('calls a page that failed once in three a one-off', async () => {
    const { rerunSummary } = await import(path.join(redteam, 'rerun-summary.mjs'));
    const once = { results: { results: [row('E', true), row('E', true)] } };
    assert.match(
      rerunSummary({ results: { results: [row('E', false)] } }, once),
      /\| E \| 1 of 3 \| one-off \|/
    );
  });
});
