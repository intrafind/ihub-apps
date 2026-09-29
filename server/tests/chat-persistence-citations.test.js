/**
 * `chatCitations` — the documents behind a chat answer, as the chat stores
 * them so that reopening it draws the same Documents panel (iAssistant
 * citations and the iFinder tool documents alike).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STORED_CITATIONS_BYTES,
  MAX_STORED_REFERENCES,
  MAX_STORED_RESULT_ITEMS,
  boundStoredCitations,
  mergeCitations
} from '../services/chat/chatCitations.js';
import { jsonByteLength } from '../services/mcp/mcpApps.js';

const item = (id, extra = {}) => ({
  document_id: id,
  title: `Doc ${id}`,
  links: [{ type: 'ACCESS', documentId: id, searchProfile: 'p' }],
  ...extra
});

describe('mergeCitations: the payloads of a turn, folded the way the client folds them', () => {
  it('a later payload’s field replaces the earlier one, a missing field keeps it', () => {
    const merged = mergeCitations([
      { references: [{ document_id: 'a', content: 'x' }] },
      { resultItems: [item('a')] },
      { resultItems: [item('a'), item('b')] }
    ]);
    assert.deepEqual(merged, {
      references: [{ document_id: 'a', content: 'x' }],
      resultItems: [item('a'), item('b')]
    });
  });

  it('nothing to merge is null', () => {
    assert.equal(mergeCitations([]), null);
    assert.equal(mergeCitations(undefined), null);
    assert.equal(mergeCitations([null, 'x', { references: [], resultItems: [] }]), null);
  });
});

describe('boundStoredCitations: only what the panel reads, bounded', () => {
  it('keeps the tile fields and the ACCESS link, drops everything else', () => {
    const stored = boundStoredCitations({
      references: [
        {
          document_id: 'a',
          content: 'passage',
          index: 2,
          score: 0.9,
          additional_document_metadata: { title: ['A'], internalField: 'x' }
        }
      ],
      resultItems: [
        item('a', {
          raw: { anything: true },
          additional_document_metadata: {
            'file.name': 'a.pdf',
            application: 'PDF',
            'accessInfo.deepLink': 'https://x.example/a',
            navigationTree: ['deep', 'structure']
          },
          links: [
            { type: 'PREVIEW', href: 'https://x.example/p' },
            { type: 'ACCESS', documentId: 'a', searchProfile: 'p', token: 'secret' }
          ]
        })
      ]
    });
    assert.deepEqual(stored, {
      references: [
        {
          document_id: 'a',
          additional_document_metadata: { title: ['A'] },
          content: 'passage',
          index: 2
        }
      ],
      resultItems: [
        {
          document_id: 'a',
          title: 'Doc a',
          additional_document_metadata: {
            'accessInfo.deepLink': 'https://x.example/a',
            'file.name': 'a.pdf',
            application: 'PDF'
          },
          links: [{ type: 'ACCESS', documentId: 'a', searchProfile: 'p' }]
        }
      ]
    });
  });

  it('drops entries the panel could not list (no id) and non-objects', () => {
    const stored = boundStoredCitations({
      references: [{ content: 'orphan passage' }, 'x', null],
      resultItems: [{ title: 'no id' }, item('b'), { additional_document_metadata: { id: 'c' } }]
    });
    assert.deepEqual(stored.references, []);
    assert.deepEqual(
      stored.resultItems.map(entry => entry.document_id || entry.additional_document_metadata.id),
      ['b', 'c']
    );
  });

  it('caps the counts and the stored size, passages first', () => {
    const many = boundStoredCitations({
      references: Array.from({ length: MAX_STORED_REFERENCES + 20 }, (_, i) => ({
        document_id: `r${i}`,
        content: 'p'
      })),
      resultItems: Array.from({ length: MAX_STORED_RESULT_ITEMS + 20 }, (_, i) => item(`d${i}`))
    });
    assert.equal(many.references.length, MAX_STORED_REFERENCES);
    assert.equal(many.resultItems.length, MAX_STORED_RESULT_ITEMS);

    const big = boundStoredCitations({
      references: Array.from({ length: MAX_STORED_REFERENCES }, (_, i) => ({
        document_id: `r${i}`,
        content: 'x'.repeat(10000)
      })),
      resultItems: [item('kept')]
    });
    assert.ok(jsonByteLength(big) <= MAX_STORED_CITATIONS_BYTES);
    assert.ok(big.references.length < MAX_STORED_REFERENCES, 'passages were dropped');
    assert.ok(
      big.references.every(ref => ref.content.length === 4000),
      'each passage is capped'
    );
    assert.deepEqual(
      big.resultItems.map(entry => entry.document_id),
      ['kept']
    );
  });

  it('nothing left to store is null', () => {
    assert.equal(boundStoredCitations(null), null);
    assert.equal(boundStoredCitations({ references: [], resultItems: [{ title: 'x' }] }), null);
  });
});
