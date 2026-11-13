// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Word, PowerPoint and OpenDocument extraction parse their XML parts with @xmldom/xmldom (through
 * a strict wrapper), not jsdom. The output must not change: `fixtures/xml-expected.json` holds
 * what the jsdom-based path produced for the same generated files (captured before the switch).
 *
 * Two entries differ from the jsdom era on purpose: a DOCTYPE that declares an internal entity
 * (jsdom expanded it one level, or left a nested reference as literal text) is now refused with
 * the same error as any other malformed part. Office files never declare entities, so this only
 * affects hostile files, and the safer outcome is a refusal.
 *
 * Run: node --test server/tests/document-extraction-xml-parser.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractDocxDocument,
  extractOdfDocument,
  extractPptxDocument,
  strictXmlDom
} from '../services/documentExtraction.js';
import { buildXmlFixtures } from './helpers/xmlExtractionFixtures.js';
import * as xmldom from '@xmldom/xmldom';

const here = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'xml-expected.json'), 'utf8')
);
const extractors = {
  pptx: extractPptxDocument,
  docx: extractDocxDocument,
  odt: extractOdfDocument,
  ods: extractOdfDocument,
  odp: extractOdfDocument
};
const options = ext =>
  ext === 'docx' ? { trackedChanges: 'include', comments: 'include' } : { speakerNotes: 'include' };

describe('XML parts of Word, PowerPoint and OpenDocument (xmldom)', async () => {
  const fixtures = await buildXmlFixtures();

  for (const name of Object.keys(expected)) {
    it(`${name}: same text, or same refusal, as the jsdom-era output`, async () => {
      const ext = name.split('.').pop();
      const outcome = await extractors[ext](fixtures[name], options(ext)).then(
        text => ({ text }),
        error => ({ error: `${error.name}: ${error.message}` })
      );
      assert.deepEqual(outcome, expected[name]);
    });
  }

  it('covers every generated fixture', () => {
    assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(expected).sort());
  });

  it('never requests the DTD an XML part points at, nor an external entity', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      res.end('<!ENTITY x "fetched">');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const { buildPptx, shape } = await import('./helpers/pptxFile.js');
      const slide = doctype =>
        '<?xml version="1.0"?>' +
        doctype +
        '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>' +
        shape(['t'], 'title').replace(
          '<p:sp>',
          '<p:sp xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        ) +
        '</p:spTree></p:cSld></p:sld>';
      const dtd = `<!DOCTYPE p:sld SYSTEM "http://127.0.0.1:${port}/x.dtd">`;
      const entity = `<!DOCTYPE p:sld [<!ENTITY x SYSTEM "http://127.0.0.1:${port}/e">]>`;
      await extractPptxDocument(await buildPptx([slide(dtd)], [0])).catch(() => {});
      await extractPptxDocument(
        await buildPptx([slide(entity).replace('>t<', '>&x;<')], [0])
      ).catch(() => {});
      assert.equal(requests, 0);
    } finally {
      server.close();
    }
  });

  it('refuses a deeply nested part with the same error as before', async () => {
    assert.equal(expected['bad-odt-deep.odt'].error.includes('not a readable OpenDocument'), true);
  });

  it('does not import jsdom on the document path', () => {
    const source = fs.readFileSync(
      path.join(here, '..', 'services', 'documentExtraction.js'),
      'utf8'
    );
    assert.doesNotMatch(source, /from 'jsdom'|import\('jsdom'\)/);
  });
});

describe('strictXmlDom', () => {
  const { DOMParser } = strictXmlDom(xmldom);
  const parse = text => new DOMParser().parseFromString(text, 'application/xml');

  it('parses with namespaces and entities', () => {
    const doc = parse('<a xmlns="urn:x" xmlns:b="urn:y"><b:c v="1&amp;2">&lt;t&gt;&#65;</b:c></a>');
    const c = doc.getElementsByTagNameNS('urn:y', 'c')[0];
    assert.equal(c.textContent, '<t>A');
    assert.equal(c.getAttribute('v'), '1&2');
    assert.equal(c.localName, 'c');
  });

  it('skips a byte order mark and normalises CRLF', () => {
    assert.equal(parse('﻿<a>x\r\ny</a>').documentElement.textContent, 'x\ny');
  });

  it('refuses what a strict XML parser refuses, with one error message', () => {
    for (const bad of [
      '',
      'not xml',
      '<a><b></a></b>',
      '<a/><b/>',
      '<a/>trailing',
      '<a>&nbsp;</a>',
      '<a x="1" x="2"/>',
      '<p:a/>',
      '<a>\u0001</a>',
      '<!DOCTYPE a [<!ENTITY e "v">]><a>&e;</a>'
    ]) {
      assert.throws(() => parse(bad), { message: 'Malformed XML part' }, JSON.stringify(bad));
    }
  });

  it('does not print to the console for a malformed part', () => {
    const original = console.error;
    const seen = [];
    console.error = (...args) => seen.push(args);
    try {
      assert.throws(() => parse('<a>&nbsp;</a>'));
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, []);
  });
});
