// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Effective install values: a `url` field loses its trailing slash (the
 * value is joined with paths in templates) unless the field opts out with
 * `keepTrailingSlash`, for an endpoint that is used verbatim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveValues,
  normalizeValue
} from '../../services/integrations/definitions/installedValues.js';
import { configFieldSchema } from '../../validators/integrationDefinitionSchema.js';

const definition = {
  install: [
    { key: 'baseUrl', type: 'url', scope: 'admin', default: 'https://default.example/api/' },
    { key: 'endpoint', type: 'url', scope: 'admin', keepTrailingSlash: true },
    { key: 'note', type: 'string', scope: 'admin' }
  ]
};

describe('installedValues: trailing slashes of url fields', () => {
  it('strips the trailing slash of a url field by default, defaults included', () => {
    const values = effectiveValues(definition, {
      values: { baseUrl: 'https://portal.example/api//', note: 'x/' }
    });
    assert.equal(values.baseUrl, 'https://portal.example/api');
    assert.equal(values.note, 'x/');
    assert.equal(effectiveValues(definition, {}).baseUrl, 'https://default.example/api');
  });

  it('keeps the slash when the field opts out', () => {
    const values = effectiveValues(definition, {
      values: { endpoint: 'https://mcp.example/mcp/' }
    });
    assert.equal(values.endpoint, 'https://mcp.example/mcp/');
    assert.equal(
      normalizeValue({ type: 'url', keepTrailingSlash: true }, 'https://a.example/'),
      'https://a.example/'
    );
    assert.equal(normalizeValue({ type: 'url' }, 'https://a.example/'), 'https://a.example');
  });

  it('is declared on url fields only', () => {
    const url = configFieldSchema.safeParse({
      key: 'endpoint',
      type: 'url',
      title: { en: 'Endpoint' },
      keepTrailingSlash: true
    });
    assert.equal(url.success, true);
    const text = configFieldSchema.safeParse({
      key: 'note',
      type: 'string',
      title: { en: 'Note' },
      keepTrailingSlash: true
    });
    assert.equal(text.success, false);
  });
});
