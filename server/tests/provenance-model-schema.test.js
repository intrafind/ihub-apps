// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `contentMarking` on a model (#3327) and the HTTP helpers that put the
 * provenance object on a response.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelConfigSchema } from '../validators/modelConfigSchema.js';
import {
  applyProvenanceHeaders,
  a2aMetadata,
  mcpMeta,
  withProvenance
} from '../services/provenance/httpProvenance.js';

const base = {
  id: 'm',
  modelId: 'm',
  name: { en: 'M' },
  description: { en: 'M' },
  url: 'http://localhost/v1',
  provider: 'openai',
  contextWindow: 1000,
  maxOutputTokens: 100
};

describe('model contentMarking', () => {
  it('accepts none and provider', () => {
    assert.equal(modelConfigSchema.safeParse({ ...base }).success, true);
    assert.equal(
      modelConfigSchema.safeParse({ ...base, contentMarking: { text: { by: 'none' } } }).success,
      true
    );
    assert.equal(
      modelConfigSchema.safeParse({
        ...base,
        contentMarking: {
          text: { by: 'provider', scheme: 'synthid', statementRef: 'DPA-annex-3' }
        }
      }).success,
      true
    );
  });

  it('requires a scheme for ihub', () => {
    const bad = modelConfigSchema.safeParse({ ...base, contentMarking: { text: { by: 'ihub' } } });
    assert.equal(bad.success, false);
    const ok = modelConfigSchema.safeParse({
      ...base,
      contentMarking: { text: { by: 'ihub', scheme: 'vllm-gumbel' } }
    });
    assert.equal(ok.success, true);
  });

  it('rejects unknown members and values', () => {
    assert.equal(
      modelConfigSchema.safeParse({ ...base, contentMarking: { text: { by: 'magic' } } }).success,
      false
    );
    assert.equal(
      modelConfigSchema.safeParse({ ...base, contentMarking: { text: { by: 'none', extra: 1 } } })
        .success,
      false
    );
    assert.equal(
      modelConfigSchema.safeParse({ ...base, contentMarking: { video: { by: 'none' } } }).success,
      false
    );
  });
});

describe('http provenance helpers', () => {
  const p = { output_id: 'ID1', ai_generated: true };

  it('sets both headers once, before the headers are sent', () => {
    const headers = {};
    const res = { headersSent: false, setHeader: (k, v) => (headers[k] = v) };
    applyProvenanceHeaders(res, 'ID1');
    assert.deepEqual(headers, { 'X-AI-Generated': 'true', 'X-AI-Content-Id': 'ID1' });
    const late = {};
    applyProvenanceHeaders({ headersSent: true, setHeader: (k, v) => (late[k] = v) }, 'ID2');
    assert.deepEqual(late, {});
  });

  it('adds the object to a body, MCP _meta and A2A metadata without losing what is there', () => {
    assert.deepEqual(withProvenance({ a: 1 }, p), { a: 1, provenance: p });
    assert.deepEqual(withProvenance({ a: 1 }, null), { a: 1 });
    assert.deepEqual(mcpMeta(p, { other: 1 }), { other: 1, provenance: p });
    assert.deepEqual(a2aMetadata(p, { skillId: 's' }), { skillId: 's', provenance: p });
    assert.equal(mcpMeta(null), undefined);
  });
});

describe('model contentMarking for images (#3328)', () => {
  it('accepts a declared provider mark for images', () => {
    const result = modelConfigSchema.safeParse({
      ...base,
      contentMarking: {
        image: { by: 'provider', scheme: 'synthid', statementRef: 'DPA-annex-3' }
      }
    });
    assert.equal(result.success, true);
  });

  it('refuses an iHub mark on images (iHub applies none) and unknown members', () => {
    for (const contentMarking of [
      { image: { by: 'ihub', scheme: 'vllm-gumbel' } },
      { image: { by: 'provider', unknown: true } },
      { audio: { by: 'none' } }
    ]) {
      assert.equal(modelConfigSchema.safeParse({ ...base, contentMarking }).success, false);
    }
  });
});
