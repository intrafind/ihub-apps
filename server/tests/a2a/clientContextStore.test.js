import { describe, it, expect } from '@jest/globals';
import {
  A2A_CLIENT_CONTEXTS_NAMESPACE,
  A2aClientContextStore,
  CLIENT_CONTEXT_RETENTION_MS,
  clientContextKey,
  clientContextRef
} from '../../services/a2a/a2aClientContextStore.js';

/**
 * The outbound A2A client's conversation memory lives on the storage
 * provider, so a chat keeps its conversation with an agent across restarts
 * and workers. Two store instances over one document store stand for two
 * workers (or one worker before and after a restart).
 */

function fakeDocuments() {
  const docs = new Map();
  const id = (ns, key) => `${ns}/${key}`;
  return {
    docs,
    async get(ns, key) {
      return docs.get(id(ns, key)) || null;
    },
    async put(ns, key, data, opts = {}) {
      docs.set(id(ns, key), { key, data, ownerId: opts.ownerId });
    },
    async delete(ns, key) {
      return docs.delete(id(ns, key));
    },
    async list(ns) {
      return {
        items: [...docs.entries()].filter(([k]) => k.startsWith(`${ns}/`)).map(([, v]) => v)
      };
    }
  };
}

const ref = { userId: 'alice', chatId: 'chat-1', agentId: 'langdock' };

describe('A2aClientContextStore', () => {
  it('hands a conversation to another worker and survives a restart', async () => {
    const documents = fakeDocuments();
    const first = new A2aClientContextStore({ documents });
    await first.set(ref, { contextId: 'ctx-1', taskId: 'task-1' });

    const second = new A2aClientContextStore({ documents });
    expect(await second.get(ref)).toEqual({ contextId: 'ctx-1', taskId: 'task-1' });

    // The document is owned by the user and says which conversation it is.
    const stored = documents.docs.get(`${A2A_CLIENT_CONTEXTS_NAMESPACE}/${clientContextKey(ref)}`);
    expect(stored.ownerId).toBe('alice');
    expect(stored.data).toMatchObject({ userId: 'alice', chatId: 'chat-1', agentId: 'langdock' });
  });

  it('lets the latest write win over another worker’s memory', async () => {
    const documents = fakeDocuments();
    const a = new A2aClientContextStore({ documents });
    const b = new A2aClientContextStore({ documents });
    await a.set(ref, { contextId: 'ctx-1', taskId: 'task-1' });
    expect(await b.get(ref)).toEqual({ contextId: 'ctx-1', taskId: 'task-1' });
    await b.set(ref, { contextId: 'ctx-1' }); // the task moved on
    expect(await a.get(ref)).toEqual({ contextId: 'ctx-1' });
  });

  it('keeps users, chats and agents apart', async () => {
    const store = new A2aClientContextStore({ documents: fakeDocuments() });
    await store.set(ref, { contextId: 'ctx-1' });
    expect(await store.get({ ...ref, userId: 'bob' })).toBe(null);
    expect(await store.get({ ...ref, chatId: 'chat-2' })).toBe(null);
    expect(await store.get({ ...ref, agentId: 'other' })).toBe(null);
  });

  it('never hands out a document stored for another conversation', async () => {
    const documents = fakeDocuments();
    const store = new A2aClientContextStore({ documents });
    await documents.put(A2A_CLIENT_CONTEXTS_NAMESPACE, clientContextKey(ref), {
      userId: 'mallory',
      chatId: 'chat-1',
      agentId: 'langdock',
      contextId: 'theirs',
      updatedAt: Date.now()
    });
    expect(await store.get(ref)).toBe(null);
  });

  it('forgets a conversation when neither id is left', async () => {
    const documents = fakeDocuments();
    const store = new A2aClientContextStore({ documents });
    await store.set(ref, { contextId: 'ctx-1' });
    await store.set(ref, {});
    expect(documents.docs.size).toBe(0);
    expect(await store.get(ref)).toBe(null);
  });

  it('drops conversations past their retention', async () => {
    let now = 1_000_000;
    const documents = fakeDocuments();
    const store = new A2aClientContextStore({ documents, now: () => now });
    await store.set(ref, { contextId: 'ctx-1' });
    now += CLIENT_CONTEXT_RETENTION_MS + 1;
    expect(await store.get(ref)).toBe(null);
    expect(await store.sweep()).toBeGreaterThanOrEqual(1);
    expect(documents.docs.size).toBe(0);
  });

  it('works memory-only without a storage provider', async () => {
    const store = new A2aClientContextStore({ documents: null });
    await store.set(ref, { contextId: 'ctx-1' });
    expect(await store.get(ref)).toEqual({ contextId: 'ctx-1' });
  });

  it('remembers nothing for a call outside a chat of a known user', () => {
    expect(clientContextRef({ chatId: 'c' }, 'a')).toBe(null);
    expect(clientContextRef({ user: { id: 'u' } }, 'a')).toBe(null);
    expect(clientContextRef({ user: { id: 'u' }, chatId: 'c' }, 'a')).toEqual({
      userId: 'u',
      chatId: 'c',
      agentId: 'a'
    });
  });
});
