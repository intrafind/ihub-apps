/**
 * The search profile a resumed iAssistant conversation's documents are linked
 * into (`GET /api/apps/:appId/conversations/:id/messages`).
 *
 * The adapter pins the profile on the chat's conversation state when it
 * creates the conversation. A reopened conversation must link its documents
 * into that profile, not into whatever the configuration says today — after an
 * admin moves the iAssistant to another search profile, links built from the
 * current configuration would point the old documents at the wrong corpus.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import conversationStateManager from '../services/integrations/ConversationStateManager.js';
import iAssistantProfileResolver from '../services/integrations/iAssistantProfileResolver.js';
import { conversationSearchProfile } from '../routes/chat/conversationRoutes.js';

const APP = { id: 'iassistant-app', iassistant: { searchProfile: 'configured' } };
const USER = { id: 'user-1' };
const BASE = { user: USER, baseUrl: 'https://ifinder.example' };

describe('conversationSearchProfile', () => {
  let original;
  let resolveCalls;

  beforeEach(() => {
    original = iAssistantProfileResolver.resolveSearchProfile;
    resolveCalls = 0;
    iAssistantProfileResolver.resolveSearchProfile = async () => {
      resolveCalls += 1;
      return { searchProfile: 'resolved-now', source: 'profile' };
    };
  });

  afterEach(() => {
    iAssistantProfileResolver.resolveSearchProfile = original;
  });

  it('uses the profile pinned on the chat’s state when that state is this conversation', async () => {
    conversationStateManager.setState('chat-pinned', {
      conversationId: 'conv-1',
      searchProfile: 'pinned-at-creation',
      ownerId: USER.id
    });
    const profile = await conversationSearchProfile(APP, {
      ...BASE,
      chatId: 'chat-pinned',
      conversationId: 'conv-1'
    });
    assert.equal(profile, 'pinned-at-creation');
    assert.equal(resolveCalls, 0, 'nothing is resolved when the pinned profile is known');
  });

  it('resolves from configuration when the chat’s state is another conversation', async () => {
    conversationStateManager.setState('chat-other', {
      conversationId: 'conv-other',
      searchProfile: 'pinned-elsewhere',
      ownerId: USER.id
    });
    const profile = await conversationSearchProfile(APP, {
      ...BASE,
      chatId: 'chat-other',
      conversationId: 'conv-1'
    });
    assert.equal(profile, 'resolved-now');
  });

  it('never reads another user’s state', async () => {
    conversationStateManager.setState('chat-foreign', {
      conversationId: 'conv-1',
      searchProfile: 'someone-elses',
      ownerId: 'user-2'
    });
    const profile = await conversationSearchProfile(APP, {
      ...BASE,
      chatId: 'chat-foreign',
      conversationId: 'conv-1'
    });
    assert.equal(profile, 'resolved-now');
  });

  it('resolves from configuration without a usable chat id or a pinned profile', async () => {
    for (const chatId of [undefined, '', '../etc/passwd', ['chat-pinned']]) {
      const profile = await conversationSearchProfile(APP, {
        ...BASE,
        chatId,
        conversationId: 'conv-1'
      });
      assert.equal(profile, 'resolved-now', `chatId ${JSON.stringify(chatId)}`);
    }

    conversationStateManager.setState('chat-unpinned', {
      conversationId: 'conv-2',
      searchProfile: null,
      ownerId: USER.id
    });
    const profile = await conversationSearchProfile(APP, {
      ...BASE,
      chatId: 'chat-unpinned',
      conversationId: 'conv-2'
    });
    assert.equal(profile, 'resolved-now');
  });

  it('a resolver failure leaves the history without links rather than failing it', async () => {
    iAssistantProfileResolver.resolveSearchProfile = async () => {
      throw new Error('iFinder unreachable');
    };
    const profile = await conversationSearchProfile(APP, { ...BASE, conversationId: 'conv-1' });
    assert.equal(profile, undefined);
  });
});
