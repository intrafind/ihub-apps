// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iFinder OCR service as an OCR engine (`com.intrafind/ifinder-ocr`): the
 * request it sends (`POST {serviceUrl}/v1/text`, raw bytes, `contenttype`),
 * how it reads the answers, the installation test, the SSRF check and the TLS
 * whitelist against a live local service.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import configCache from '../configCache.js';
import {
  checkIfinderOcrTarget,
  createIfinderOcrConnector,
  normalizeServiceUrl
} from '../services/integrations/protocols/native/connectors/ifinderOcr/index.js';
import { validateIntegrationDefinition } from '../validators/integrationDefinitionSchema.js';
import { createSelfSignedCertificate, opensslAvailable } from './helpers/selfSignedCertificate.js';

const DEFINITION = new URL(
  '../defaults/integration-definitions/com.intrafind__ifinder-ocr/integration.json',
  import.meta.url
);

/** A fetch stub that records the request and answers with `respond(url, options)`. */
function stubFetch(respond) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const { status = 200, body = '', headers = {} } = respond(url, options) || {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: name => headers[name.toLowerCase()] ?? null },
      text: async () => body
    };
  };
  return { fetchImpl, requests };
}

const settings = (extra = {}) => ({
  baseUrl: 'http://if-ocr:9618/ocr-api',
  authorization: undefined,
  ref: null,
  refMissing: false,
  timeoutMs: 5000,
  ...extra
});

function connectorWith(respond, settingsOverride = {}) {
  const stub = stubFetch(respond);
  const connector = createIfinderOcrConnector({
    fetchImpl: stub.fetchImpl,
    targetGuard: async () => ({}),
    settingsResolver: () => settings(settingsOverride)
  });
  return { connector, requests: stub.requests };
}

describe('iFinder OCR definition', () => {
  it('is a valid built-in OCR engine with the recognize action', () => {
    const definition = JSON.parse(fs.readFileSync(DEFINITION, 'utf8'));
    const result = validateIntegrationDefinition(definition);
    assert.equal(result.success, true, JSON.stringify(result.errors || result.error));
    assert.equal(result.data.type, 'ocr');
    assert.equal(result.data.protocol.module, 'ifinderOcr');
    assert.ok(result.data.actions.some(action => action.name === 'recognize'));
  });
});

describe('iFinder OCR service URL', () => {
  it('adds the API path, drops /v1/text and trailing slashes, refuses the rest', () => {
    assert.equal(normalizeServiceUrl('http://if-ocr:9618'), 'http://if-ocr:9618/ocr-api');
    assert.equal(normalizeServiceUrl('http://if-ocr:9618/'), 'http://if-ocr:9618/ocr-api');
    assert.equal(
      normalizeServiceUrl('https://ocr.example.org/ocr-api/v1/text/'),
      'https://ocr.example.org/ocr-api'
    );
    assert.equal(normalizeServiceUrl('http://h:1/custom/'), 'http://h:1/custom');
    assert.equal(normalizeServiceUrl('ftp://h/ocr-api'), null);
    assert.equal(normalizeServiceUrl('http://user:pw@h/ocr-api'), null);
    assert.equal(normalizeServiceUrl('not a url'), null);
    assert.equal(normalizeServiceUrl(''), null);
  });
});

describe('iFinder OCR recognize', () => {
  it('posts the raw image with its type and returns the text', async () => {
    const { connector, requests } = connectorWith(() => ({ body: '  Hello OCR \n' }));
    const image = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const result = await connector.actions.recognize.run(
      { content: image.toString('base64'), mimeType: 'image/PNG; charset=binary' },
      { values: {} }
    );
    assert.deepEqual(result, { text: 'Hello OCR' });
    const [{ url, options }] = requests;
    assert.equal(url, 'http://if-ocr:9618/ocr-api/v1/text?contenttype=image%2Fpng');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/octet-stream');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.body, image);
    assert.ok(options.signal, 'a timeout is set');
  });

  it('sends the credential as the Authorization header', async () => {
    const { connector, requests } = connectorWith(() => ({ body: 'x' }), {
      authorization: 'Bearer jwt'
    });
    await connector.actions.recognize.run({ content: 'AA==', mimeType: 'image/jpeg' }, {});
    assert.equal(requests[0].options.headers.Authorization, 'Bearer jwt');
  });

  it('refuses a type the service does not read, without calling it', async () => {
    const { connector, requests } = connectorWith(() => ({ body: 'x' }));
    await assert.rejects(
      connector.actions.recognize.run({ content: 'AA==', mimeType: 'image/webp' }, {}),
      error => error.status === 415 && /image\/webp/.test(error.message)
    );
    assert.equal(requests.length, 0);
  });

  it('reports the service error with its status and problem detail', async () => {
    const { connector } = connectorWith(() => ({
      status: 500,
      body: JSON.stringify({ title: 'Internal Server Error', detail: 'OCR processing failed' })
    }));
    await assert.rejects(
      connector.actions.recognize.run({ content: 'AA==', mimeType: 'image/png' }, {}),
      error => error.status === 500 && /HTTP 500: OCR processing failed/.test(error.message)
    );
  });

  it('does not follow a redirect', async () => {
    const { connector } = connectorWith(() => ({
      status: 302,
      headers: { location: 'https://login.example.org' }
    }));
    await assert.rejects(
      connector.actions.recognize.run({ content: 'AA==', mimeType: 'image/png' }, {}),
      /redirect \(HTTP 302 to https:\/\/login\.example\.org\)/
    );
  });

  it('refuses a call without an image or without a service URL', async () => {
    const { connector } = connectorWith(() => ({ body: 'x' }));
    await assert.rejects(connector.actions.recognize.run({ mimeType: 'image/png' }, {}), {
      status: 400
    });
    const { connector: unset } = connectorWith(() => ({ body: 'x' }), { baseUrl: null });
    await assert.rejects(
      unset.actions.recognize.run({ content: 'AA==', mimeType: 'image/png' }, {}),
      /no valid service URL/
    );
  });
});

describe('iFinder OCR installation test', () => {
  it('passes with a service that answers a blank image', async () => {
    const { connector, requests } = connectorWith(() => ({ body: '' }));
    const steps = await connector.test({ values: {} });
    assert.deepEqual(
      steps.map(step => [step.id, step.status]),
      [
        ['service', 'ok'],
        ['recognize', 'ok']
      ]
    );
    assert.match(requests[0].url, /contenttype=image%2Fpng$/);
  });

  it('names the API path when the service answers 404', async () => {
    const { connector } = connectorWith(() => ({ status: 404, body: 'Not Found' }));
    const [, step] = await connector.test({ values: {} });
    assert.equal(step.status, 'fail');
    assert.match(step.hints.join(' '), /\/ocr-api/);
  });

  it('stops at a missing URL and warns about a credential over plain http', async () => {
    const { connector: unset } = connectorWith(() => ({}), { baseUrl: null });
    const steps = await unset.test({ values: {} });
    assert.deepEqual(
      steps.map(step => step.status),
      ['fail']
    );
    const { connector: clear } = connectorWith(() => ({ body: '' }), {
      authorization: 'Bearer t',
      ref: 'ocr-token'
    });
    assert.equal((await clear.test({ values: {} }))[0].status, 'warn');
  });
});

describe('iFinder OCR address checks (SSRF and TLS whitelist)', () => {
  const setPlatform = platform => configCache.setCacheEntry('config/platform.json', platform);

  after(() => setPlatform({}));

  it('lets a company-internal address through, pinned', async () => {
    setPlatform({});
    const { lookup } = await checkIfinderOcrTarget('http://10.1.2.3:9618/ocr-api');
    assert.equal(typeof lookup, 'function');
  });

  it('refuses loopback unless the host is allowed or whitelisted', async () => {
    setPlatform({});
    await assert.rejects(checkIfinderOcrTarget('http://127.0.0.1:9618/ocr-api'), {
      code: 'IFINDER_OCR_TARGET_BLOCKED'
    });
    setPlatform({ ssrf: { allowedHosts: ['127.0.0.1'] } });
    assert.deepEqual(await checkIfinderOcrTarget('http://127.0.0.1:9618/ocr-api'), {});
    setPlatform({ ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] } });
    assert.deepEqual(await checkIfinderOcrTarget('http://localhost:9618/ocr-api'), {});
  });

  describe('against a live local service', () => {
    let plain;
    let plainPort;
    let secure;
    let securePort;
    let certificate;
    const received = [];

    const serve = (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          url: req.url,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks)
        });
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=UTF-8' });
        res.end('Recognized by the service');
      });
    };

    before(async () => {
      plain = http.createServer(serve);
      await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
      plainPort = plain.address().port;
      if (!opensslAvailable) return;
      certificate = createSelfSignedCertificate();
      secure = https.createServer({ key: certificate.key, cert: certificate.cert }, serve);
      await new Promise(resolve => secure.listen(0, '127.0.0.1', resolve));
      securePort = secure.address().port;
    });

    after(async () => {
      await new Promise(resolve => plain.close(resolve));
      if (secure) await new Promise(resolve => secure.close(resolve));
      certificate?.remove();
    });

    beforeEach(() => {
      received.length = 0;
    });

    const live = baseUrl =>
      createIfinderOcrConnector({ settingsResolver: () => settings({ baseUrl }) });
    const recognize = baseUrl =>
      live(baseUrl).actions.recognize.run(
        { content: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' },
        {}
      );

    it('refuses a loopback service the admin did not allow', async () => {
      setPlatform({});
      await assert.rejects(recognize(`http://127.0.0.1:${plainPort}/ocr-api`), {
        code: 'IFINDER_OCR_TARGET_BLOCKED'
      });
      assert.equal(received.length, 0);
    });

    it('sends the bytes over plain http to an allowed host', async () => {
      setPlatform({ ssrf: { allowedHosts: ['127.0.0.1'] } });
      const result = await recognize(`http://127.0.0.1:${plainPort}/ocr-api`);
      assert.deepEqual(result, { text: 'Recognized by the service' });
      assert.equal(received[0].url, '/ocr-api/v1/text?contenttype=image%2Fpng');
      assert.equal(received[0].contentType, 'application/octet-stream');
      assert.equal(received[0].body.toString(), 'fake-png');
    });

    it(
      'reaches a self-signed service only when its host is on the TLS whitelist',
      { skip: !opensslAvailable },
      async () => {
        const baseUrl = `https://127.0.0.1:${securePort}/ocr-api`;
        const withSsl = ssl => setPlatform({ ssl, ssrf: { allowedHosts: ['127.0.0.1'] } });

        withSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['127.0.0.1'] });
        assert.deepEqual(await recognize(baseUrl), { text: 'Recognized by the service' });

        withSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['other.example'] });
        await assert.rejects(recognize(baseUrl));

        withSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['127.0.0.1'] });
        await assert.rejects(recognize(baseUrl));
      }
    );
  });
});
