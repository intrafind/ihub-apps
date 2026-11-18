// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The examples the `web-artifacts` and `dashboard` skills give the model are
 * copied, so they must be right: every web artifact passes the checks of
 * `create_web_artifact` without a problem or a note, the edit example applies
 * to the artifact it changes, and every dashboard spec renders.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ARTIFACT_SCRIPT_HOSTS } from '../../shared/artifactPreview.js';
import { requestedArtifactLibraries } from '../../shared/artifactLibraries.js';
import { applyTextEdits } from '../services/documents/editableSource.js';
import { inspectWebArtifactFindings } from '../services/documents/webArtifacts/webArtifactTools.js';
import { renderDashboard } from '../services/documents/webArtifacts/dashboardPreset.js';

const skills = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'systemSkills');
const read = file => readFileSync(path.join(skills, file), 'utf8');

/** The bodies of the fenced blocks of one language, in order. */
function blocksOf(markdown, language) {
  return [...markdown.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map(
    match => match[1]
  );
}

describe('web-artifacts examples', () => {
  const markdown = read('web-artifacts/references/examples.md');
  const pages = blocksOf(markdown, 'html');

  it('has the four examples the table lists', () => {
    assert.equal(pages.length, 4);
  });

  pages.forEach((page, index) => {
    it(`example ${index + 1} passes every check, with no note either`, () => {
      assert.deepEqual(
        inspectWebArtifactFindings(page, 'html', {
          scriptHosts: [...DEFAULT_ARTIFACT_SCRIPT_HOSTS]
        }),
        []
      );
      // Light and dark, as the skill asks.
      assert.match(page, /:root\[data-theme="dark"\]/);
      assert.match(page, /prefers-color-scheme: dark/);
      // Follow-up questions only where the chat can answer them.
      if (page.includes('sendPrompt(')) assert.match(page, /sendPrompt\.available/);
      // Libraries come from the kit, never from a CDN (#3822).
      assert.doesNotMatch(page, /<script\b[^>]*\bsrc\s*=/i);
    });
  });

  it('loads Chart.js, Alpine.js and D3 from the library kit', () => {
    const libraries = pages.map(page => requestedArtifactLibraries(page));
    assert.deepEqual(libraries, [['chart.js'], ['alpinejs'], [], ['d3']]);
  });

  it('the edit example applies to example 1, and the result still passes', () => {
    const [call] = blocksOf(markdown, 'json').map(text => JSON.parse(text));
    const edited = applyTextEdits(pages[0], call.edits);
    assert.match(edited, /backgroundColor: '#047857'/);
    assert.match(edited, /data-ihub-lib="chart\.js"/);
    assert.match(edited, /name: 'Central'/);
    assert.deepEqual(inspectWebArtifactFindings(edited, 'html'), []);
  });
});

describe('dashboard examples', () => {
  const specs = [
    ...blocksOf(read('dashboard/SKILL.md'), 'json'),
    ...blocksOf(read('dashboard/references/spec.md'), 'json')
  ];

  it('are there: the skill’s and the reference’s', () => {
    assert.ok(specs.length >= 2, `found ${specs.length}`);
  });

  specs.forEach((spec, index) => {
    it(`spec ${index + 1} renders a page that passes the checks`, () => {
      const html = renderDashboard(spec);
      assert.match(html, /<!DOCTYPE html>/i);
      assert.deepEqual(
        inspectWebArtifactFindings(html, 'html').filter(finding => finding.blocking),
        []
      );
    });
  });
});
