import { describe, it, expect } from '@jest/globals';
import { SweepPages } from '../../storage/sweepPages.js';
import {
  A2A_CLIENT_CONTEXTS_NAMESPACE,
  A2aClientContextStore,
  CLIENT_CONTEXT_RETENTION_MS
} from '../../services/a2a/a2aClientContextStore.js';

/**
 * Retention sweeps look at one page per tick. They must move on to the next
 * page each tick, so expired documents after a page of live ones are still
 * removed — and start over once a pass reaches the end.
 */

/** A keyset-paged document store, like the filesystem provider. */
function pagedDocuments() {
  const docs = new Map();
  return {
    docs,
    async get(_ns, key) {
      return docs.get(key) || null;
    },
    async put(_ns, key, data) {
      docs.set(key, { key, data });
    },
    async delete(_ns, key) {
      return docs.delete(key);
    },
    async list(_ns, { limit = 100, cursor } = {}) {
      if (cursor !== undefined && !cursor.startsWith('after:')) {
        const error = new Error('Invalid list cursor');
        error.code = 'INVALID_CURSOR';
        throw error;
      }
      const after = cursor ? cursor.slice('after:'.length) : null;
      const keys = [...docs.keys()].sort().filter(k => after === null || k > after);
      const items = keys.slice(0, limit).map(k => docs.get(k));
      const more = keys.length > limit;
      return { items, nextCursor: more ? `after:${items.at(-1).key}` : null };
    }
  };
}

describe('SweepPages', () => {
  it('walks the namespace page by page and starts over at the end', async () => {
    const documents = pagedDocuments();
    for (const k of ['a', 'b', 'c', 'd', 'e']) await documents.put('ns', k, {});
    const pages = new SweepPages();
    const keys = async () => (await pages.next(documents, 'ns', 2)).items.map(d => d.key);
    expect(await keys()).toEqual(['a', 'b']);
    expect(await keys()).toEqual(['c', 'd']);
    expect(await keys()).toEqual(['e']);
    expect(await keys()).toEqual(['a', 'b']);
  });

  it('starts over when the store no longer accepts the cursor', async () => {
    const documents = pagedDocuments();
    for (const k of ['a', 'b', 'c']) await documents.put('ns', k, {});
    const pages = new SweepPages();
    pages.cursors.set('ns', 'garbage');
    expect((await pages.next(documents, 'ns', 2)).items.map(d => d.key)).toEqual(['a', 'b']);
  });

  it('keeps one cursor per namespace', async () => {
    const documents = pagedDocuments();
    for (const k of ['a', 'b', 'c']) await documents.put('x', k, {});
    const pages = new SweepPages();
    await pages.next(documents, 'one', 2);
    expect(pages.cursors.get('one')).toBe('after:b');
    expect(pages.cursors.has('two')).toBe(false);
  });
});

describe('A2aClientContextStore sweep', () => {
  it('removes expired conversations that sit behind a full page of live ones', async () => {
    let now = 10 * CLIENT_CONTEXT_RETENTION_MS;
    const documents = pagedDocuments();
    const store = new A2aClientContextStore({ documents, now: () => now });
    // 200 live documents sort before the expired one.
    for (let i = 0; i < 200; i++) {
      await documents.put(A2A_CLIENT_CONTEXTS_NAMESPACE, `a${String(i).padStart(3, '0')}`, {
        updatedAt: now
      });
    }
    await documents.put(A2A_CLIENT_CONTEXTS_NAMESPACE, 'z-expired', {
      updatedAt: now - CLIENT_CONTEXT_RETENTION_MS - 1
    });
    expect(await store.sweep()).toBe(0);
    expect(await store.sweep()).toBe(1);
    expect(documents.docs.has('z-expired')).toBe(false);
  });
});
