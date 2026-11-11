// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The HTML artifact preview: its CSP with the admin's CDN hosts, the theme it
 * is told, and the checks `create_web_artifact` runs before the user sees it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIFACT_SCRIPT_HOSTS,
  artifactPreviewCsp,
  isAllowedScriptUrl,
  normalizeScriptHosts,
  prepareHtmlPreview
} from '../../shared/artifactPreview.js';
import { artifactSettings } from '../services/artifacts/artifactPolicy.js';
import { inspectWebArtifact } from '../services/documents/webArtifacts/webArtifactTools.js';
import { embedPageCsp } from '../routes/shareEmbedPage.js';

describe('artifact script hosts', () => {
  it('uses the defaults when nothing is configured and none for an empty list', () => {
    assert.deepEqual(normalizeScriptHosts(undefined), [...DEFAULT_ARTIFACT_SCRIPT_HOSTS]);
    assert.deepEqual(normalizeScriptHosts([]), []);
    assert.deepEqual(artifactSettings({}).scriptHosts, [...DEFAULT_ARTIFACT_SCRIPT_HOSTS]);
    assert.deepEqual(artifactSettings({ artifacts: { scriptHosts: [] } }).scriptHosts, []);
  });

  it('keeps plain https hosts and drops anything that could widen the CSP', () => {
    assert.deepEqual(
      normalizeScriptHosts([
        'CDN.Example.com',
        'https://mirror.intra.example/',
        'cdn.example.com',
        '*',
        '*.example.com',
        'http://plain.example.com',
        'cdn.example.com:8443',
        'cdn.example.com/npm',
        "x.com; script-src 'unsafe-eval'",
        'localhost',
        42
      ]),
      ['cdn.example.com', 'mirror.intra.example']
    );
  });

  it('matches a URL against the hosts over https only', () => {
    const hosts = ['cdn.jsdelivr.net'];
    assert.equal(isAllowedScriptUrl('https://cdn.jsdelivr.net/npm/chart.js@4.4.1', hosts), true);
    assert.equal(isAllowedScriptUrl('//cdn.jsdelivr.net/npm/x', hosts), true);
    assert.equal(isAllowedScriptUrl('http://cdn.jsdelivr.net/npm/x', hosts), false);
    assert.equal(isAllowedScriptUrl('https://cdn.jsdelivr.net.evil.test/x', hosts), false);
    assert.equal(isAllowedScriptUrl('https://evil.test/?cdn.jsdelivr.net', hosts), false);
  });
});

describe('the preview CSP', () => {
  it('stays offline without hosts and opens scripts and styles to the listed ones', () => {
    const offline = artifactPreviewCsp([]);
    assert.match(offline, /default-src 'none'/);
    assert.match(offline, /script-src 'unsafe-inline' 'unsafe-eval';/);
    assert.doesNotMatch(offline, /https:/);

    const csp = artifactPreviewCsp(['cdn.jsdelivr.net', 'unpkg.com']);
    assert.match(
      csp,
      /script-src 'unsafe-inline' 'unsafe-eval' https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com;/
    );
    assert.match(
      csp,
      /style-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com;/
    );
    // Nothing else goes out.
    assert.match(csp, /img-src data: blob:;/);
    assert.match(csp, /font-src data:;/);
    assert.doesNotMatch(csp, /connect-src/);
  });

  it('gives the embed page the same directives plus its own images', () => {
    const csp = embedPageCsp(['unpkg.com']);
    assert.match(csp, /script-src 'unsafe-inline' 'unsafe-eval' https:\/\/unpkg\.com;/);
    assert.match(csp, /img-src 'self' data: blob:;/);
  });

  it('puts the CSP and the theme after the doctype and before the markup', () => {
    const html = prepareHtmlPreview('<!DOCTYPE html><html><body>Hi</body></html>', {
      scriptHosts: ['unpkg.com'],
      theme: 'dark'
    });
    assert.match(
      html,
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="[^"]*https:\/\/unpkg\.com[^"]*"><script>document\.documentElement\.setAttribute\('data-theme','dark'\)<\/script><html>/
    );
    assert.doesNotMatch(prepareHtmlPreview('<p>x</p>', { theme: 'evil' }), /data-theme/);
    assert.doesNotMatch(prepareHtmlPreview('<p>x</p>'), /data-theme/);
  });
});

describe('create_web_artifact checks', () => {
  const hosts = ['cdn.jsdelivr.net'];

  it('accepts scripts and stylesheets from an allowed host', () => {
    const html =
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>';
    assert.deepEqual(inspectWebArtifact(html, 'html', { scriptHosts: hosts }), []);
  });

  it('warns about hosts that are not allowed, remote images and CSS imports', () => {
    const html =
      '<script src="https://evil.test/x.js"></script>' +
      '<img src="https://cdn.jsdelivr.net/logo.png">' +
      '<style>@import url("https://fonts.googleapis.com/css2?family=Inter");</style>';
    const warnings = inspectWebArtifact(html, 'html', { scriptHosts: hosts });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /evil\.test/);
    assert.match(warnings[0], /logo\.png/);
    assert.match(warnings[0], /fonts\.googleapis\.com/);
    assert.match(warnings[0], /only over https from cdn\.jsdelivr\.net/);
  });

  it('warns about every external script when the installation allows none', () => {
    const warnings = inspectWebArtifact(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>',
      'html'
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /allows no external scripts/);
  });

  it('reports inline JavaScript that does not parse, with its position', () => {
    const warnings = inspectWebArtifact(
      '<html><body><script>const ok = 1;</script><script>\nconst a = {;\n</script></body></html>',
      'html'
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /does not parse/);
    assert.match(warnings[0], /<script> #2, line 2: SyntaxError/);
  });

  it('never runs the script it checks', () => {
    globalThis.__artifactCheckRan = false;
    inspectWebArtifact('<script>globalThis.__artifactCheckRan = true;</script>', 'html');
    assert.equal(globalThis.__artifactCheckRan, false);
    delete globalThis.__artifactCheckRan;
  });

  it('leaves modules, JSON data and other script types alone', () => {
    const html =
      '<script type="module">import x from "y"; export default x;</script>' +
      '<script type="application/json">{"a": </script>' +
      '<script type="text/babel">const App = () => <div />;</script>' +
      '<script type="text/javascript">run();</script>';
    assert.deepEqual(inspectWebArtifact(html, 'html'), []);
  });

  it('recognizes a file that was cut off', () => {
    for (const cut of [
      '<!DOCTYPE html><html><head></head><body><script>let rows = [1, 2,',
      '<html><head><style>body { color: red;',
      '<!DOCTYPE html><html><body><main><h1>Report</h1>'
    ]) {
      const warnings = inspectWebArtifact(cut, 'html');
      assert.equal(warnings.length, 1, cut);
      assert.match(warnings[0], /looks cut off/);
    }
    assert.match(inspectWebArtifact('<svg viewBox="0 0 10 10"><rect', 'svg')[0], /cut off/);
    assert.deepEqual(inspectWebArtifact('<svg viewBox="0 0 10 10"><rect/></svg>', 'svg'), []);
    // A fragment without <html> is not a cut-off document.
    assert.deepEqual(inspectWebArtifact('<h1>Hello</h1>', 'html'), []);
  });
});
