// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The library kit for HTML artifacts (#3822): the vendored files match the
 * manifest, a marker expands only for exact kit names and each library once,
 * the checks of `create_web_artifact` explain every way a marker can go wrong,
 * and the public routes hand out the verified source.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import configCache from '../configCache.js';
import errorHandler from '../middleware/errorHandler.js';
import registerArtifactLibraryRoutes from '../routes/artifactLibraries.js';
import {
  ARTIFACT_LIBRARIES,
  MAX_INLINED_LIBRARY_BYTES,
  artifactLibraryMarkers,
  inlineArtifactLibraries,
  inlineScriptSource,
  requestedArtifactLibraries,
  resolveArtifactLibrary
} from '../../shared/artifactLibraries.js';
import {
  artifactLibraryDir,
  artifactLibrarySource,
  inlineKitLibraries,
  withKitLibraries
} from '../services/artifacts/artifactLibraryKit.js';
import { artifactSettings } from '../services/artifacts/artifactPolicy.js';
import { inspectWebArtifactFindings } from '../services/documents/webArtifacts/webArtifactTools.js';
import { CREATE_WEB_ARTIFACT_TOOL } from '../services/documents/webArtifacts/webArtifactToolDefinitions.js';

const vendorDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'artifactLibraries'
);

function setPlatform(platform) {
  configCache.setCacheEntry('config/platform.json', platform);
}

afterEach(() => setPlatform({}));

describe('the vendored files', () => {
  for (const library of ARTIFACT_LIBRARIES) {
    it(`${library.id} matches its recorded size and SHA-256`, () => {
      const data = readFileSync(path.join(vendorDir, library.file));
      assert.equal(data.length, library.bytes);
      assert.equal(createHash('sha256').update(data).digest('hex'), library.sha256);
      assert.equal(artifactLibrarySource(library.id), data.toString('utf8'));
    });

    it(`${library.id} cannot end or comment out the inline <script> it is put in`, () => {
      const text = readFileSync(path.join(vendorDir, library.file), 'utf8');
      assert.equal(/<\/script/i.test(inlineScriptSource(text)), false);
      assert.equal(text.includes('<!--'), false);
    });
  }

  it('are read from the server directory, by manifest name only', () => {
    assert.equal(artifactLibraryDir().endsWith(path.join('server', 'artifactLibraries')), true);
    assert.equal(artifactLibrarySource('../package.json'), null);
    assert.equal(artifactLibrarySource('chart.umd.min.js'), null);
    assert.equal(artifactLibrarySource('constructor'), null);
  });
});

describe('library markers', () => {
  it('resolve exact kit names only, with the kit version or none', () => {
    assert.equal(resolveArtifactLibrary('chart.js').library.id, 'chart.js');
    assert.equal(resolveArtifactLibrary(' Chart.JS ').library.id, 'chart.js');
    assert.equal(resolveArtifactLibrary('d3@7.9.0').library.id, 'd3');
    assert.deepEqual(resolveArtifactLibrary('d3@7.8.5'), {
      error: 'version',
      id: 'd3',
      version: '7.8.5'
    });
    assert.equal(resolveArtifactLibrary('chartjs').error, 'unknown');
    assert.equal(resolveArtifactLibrary('../../etc/passwd').error, 'unknown');
    assert.equal(resolveArtifactLibrary('__proto__').error, 'unknown');
    assert.equal(resolveArtifactLibrary('').error, 'unknown');
  });

  it('are found with either quote or none, and tell their body and attributes', () => {
    const markers = artifactLibraryMarkers(
      `<script data-ihub-lib="chart.js"></script><script defer data-ihub-lib='d3'>x()</script><script data-ihub-lib=alpinejs ></script>`
    );
    assert.deepEqual(
      markers.map(m => [m.ref, m.body, m.resolved.library?.id]),
      [
        ['chart.js', '', 'chart.js'],
        ['d3', 'x()', 'd3'],
        ['alpinejs', '', 'alpinejs']
      ]
    );
    assert.match(markers[1].attributes, /defer/);
  });

  it('ignore lookalike elements and unclosed scripts, and stay linear on hostile input', () => {
    assert.deepEqual(
      artifactLibraryMarkers(
        '<scripts data-ihub-lib="d3"></scripts><script-x data-ihub-lib="d3"></script-x><script data-ihub-lib="d3">'
      ),
      []
    );
    const hostile = '<script ' + ' '.repeat(200000) + 'x'.repeat(200000);
    const started = Date.now();
    assert.deepEqual(artifactLibraryMarkers(hostile.repeat(5)), []);
    assert.ok(Date.now() - started < 1000, 'a long unclosed tag is scanned once');
  });

  it('inline each library once and drop unknown names, duplicates and the unavailable', () => {
    const html =
      '<head><script data-ihub-lib="chart.js"></script><script data-ihub-lib="nope"></script></head>' +
      '<body><script data-ihub-lib="chart.js@4.5.1"></script><script data-ihub-lib="d3"></script></body>';
    assert.deepEqual(requestedArtifactLibraries(html), ['chart.js', 'd3']);
    const {
      html: out,
      inlined,
      missing
    } = inlineArtifactLibraries(html, id =>
      id === 'chart.js' ? 'var Chart = 1; "</script>"' : null
    );
    assert.deepEqual(inlined, ['chart.js']);
    assert.deepEqual(missing, ['d3']);
    assert.equal(
      out,
      '<head><script data-ihub-lib-inlined="chart.js@4.5.1">var Chart = 1; "<\\/script>"\n</script></head><body></body>'
    );
  });

  it('stop inlining at the size cap', () => {
    const html = '<script data-ihub-lib="chart.js"></script><script data-ihub-lib="d3"></script>';
    const big = 'x'.repeat(MAX_INLINED_LIBRARY_BYTES - 10);
    const { inlined, missing } = inlineArtifactLibraries(html, () => big);
    assert.deepEqual(inlined, ['chart.js']);
    assert.deepEqual(missing, ['d3']);
  });

  it('leave text without a marker as it is', () => {
    const text = '<p>no library here</p>';
    assert.equal(inlineArtifactLibraries(text, () => 'x').html, text);
  });
});

describe('the server side of the kit', () => {
  const page = '<html><head><script data-ihub-lib="alpinejs"></script></head></html>';

  it('is on by default and can be switched off', () => {
    assert.deepEqual(artifactSettings({}).libraryKit, { enabled: true });
    assert.deepEqual(
      artifactSettings({ artifacts: { libraryKit: { enabled: false } } }).libraryKit,
      {
        enabled: false
      }
    );
  });

  it('inlines while on and leaves the marker while off', () => {
    assert.match(inlineKitLibraries(page, { enabled: true }), /data-ihub-lib-inlined="alpinejs@/);
    assert.equal(inlineKitLibraries(page, { enabled: false }), page);
  });

  it('changes the bytes of an .html file only', () => {
    const data = Buffer.from(page);
    assert.match(
      withKitLibraries(data, 'page.html', { enabled: true }).toString(),
      /data-ihub-lib-inlined/
    );
    assert.equal(withKitLibraries(data, 'page.md', { enabled: true }), data);
    assert.equal(withKitLibraries(data, 'page.html', { enabled: false }), data);
    const plain = Buffer.from('<p>hi</p>');
    assert.equal(withKitLibraries(plain, 'page.html', { enabled: true }), plain);
  });
});

describe('create_web_artifact and the kit', () => {
  const doc = (head, body = '') =>
    `<!DOCTYPE html><html><head>${head}</head><body>${body}<p>x</p></body></html>`;
  const texts = (html, options) =>
    inspectWebArtifactFindings(html, 'html', options).map(
      f => `${f.blocking ? 'P' : 'N'} ${f.text}`
    );

  it('accepts the kit markers without a finding', () => {
    assert.deepEqual(
      texts(
        doc(
          '<script data-ihub-lib="chart.js"></script><script data-ihub-lib="d3"></script>',
          '<script data-ihub-lib="alpinejs"></script>'
        ),
        { scriptHosts: [] }
      ),
      []
    );
  });

  it('names the kit when a marker names something else', () => {
    const [finding] = texts(doc('<script data-ihub-lib="chartjs"></script>'));
    assert.match(finding, /^P .*"chartjs".*Chart\.js 4\.5\.1.*data-ihub-lib="d3"/);
  });

  it('refuses a version the kit does not ship', () => {
    const [finding] = texts(doc('<script data-ihub-lib="chart.js@4.4.1"></script>'));
    assert.match(finding, /^P The kit ships one version of each library, not "chart\.js@4\.4\.1"/);
  });

  it('reports a marker with code or a src of its own', () => {
    const [withCode] = texts(doc('<script data-ihub-lib="d3">d3.select("p")</script>'));
    assert.match(withCode, /^P .*own code or src is dropped/);
    const [withSrc] = texts(doc('<script data-ihub-lib="d3" src="x.js"></script>'));
    assert.ok(withSrc.startsWith('P '));
  });

  it('asks for the Alpine.js marker at the end of <body>', () => {
    const [finding] = texts(doc('<script data-ihub-lib="alpinejs"></script>'));
    assert.match(finding, /^P Alpine\.js .*end of <body>/);
  });

  it('says so when the kit is switched off', () => {
    const [finding] = texts(doc('<script data-ihub-lib="chart.js"></script>'), {
      libraryKit: { enabled: false }
    });
    assert.match(finding, /^P The library kit is switched off/);
  });

  it('points a CDN copy of a kit library to the kit', () => {
    const cdn =
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>';
    const [allowed] = texts(doc(cdn), { scriptHosts: ['cdn.jsdelivr.net'] });
    assert.match(allowed, /^N Chart\.js comes from a public CDN.*data-ihub-lib="chart\.js"/);
    const [blocked] = texts(doc(cdn), { scriptHosts: [] });
    assert.match(blocked, /^P The sandboxed preview will not load .*library kit instead/);
    // An off kit is not offered.
    const off = texts(doc(cdn), {
      scriptHosts: ['cdn.jsdelivr.net'],
      libraryKit: { enabled: false }
    });
    assert.deepEqual(off, []);
  });

  it('is described to the model with every library', () => {
    for (const library of ARTIFACT_LIBRARIES) {
      assert.ok(CREATE_WEB_ARTIFACT_TOOL.description.en.includes(`"${library.id}"`), library.id);
      assert.ok(CREATE_WEB_ARTIFACT_TOOL.description.de.includes(`"${library.id}"`), library.id);
    }
    assert.match(CREATE_WEB_ARTIFACT_TOOL.description.en, /only when the user explicitly asks/);
  });
});

describe('GET /api/artifact-libraries', () => {
  const app = express();
  registerArtifactLibraryRoutes(app);
  app.use(errorHandler);

  it('lists the kit, readable without signing in', async () => {
    const res = await request(app).get('/api/artifact-libraries').expect(200);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(
      res.body.items.map(item => [item.id, item.version, item.available]),
      ARTIFACT_LIBRARIES.map(library => [library.id, library.version, true])
    );
  });

  it('serves a library as text, with an ETag', async () => {
    const res = await request(app).get('/api/artifact-libraries/chart.js/source').expect(200);
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.text, /Chart\.js v4\.5\.1/);
    const etag = res.headers.etag;
    await request(app)
      .get('/api/artifact-libraries/chart.js/source')
      .set('If-None-Match', etag)
      .expect(304);
  });

  it('answers 404 for a name outside the kit, and for every name while the kit is off', async () => {
    const unknown = await request(app).get('/api/artifact-libraries/..%2Fpackage.json/source');
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers['content-type'], /application\/problem\+json/);
    assert.equal(unknown.body.code, 'NOT_FOUND');

    setPlatform({ artifacts: { libraryKit: { enabled: false } } });
    await request(app).get('/api/artifact-libraries/d3/source').expect(404);
    const list = await request(app).get('/api/artifact-libraries').expect(200);
    assert.equal(list.body.enabled, false);
  });
});
