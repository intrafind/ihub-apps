// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A remembered chat id belongs to the user who started the chat: every chat is
 * stored under its owner, so an id kept across a change of user would hydrate
 * as empty and refuse the next message.
 */
import { bindChatIdsToUser, getOrCreateChatId, readChatId } from '../../../client/src/utils/chatId';

beforeEach(() => sessionStorage.clear());

test('keeps the ids while the user stays the same', () => {
  bindChatIdsToUser('anonymous');
  const id = getOrCreateChatId('chat');
  bindChatIdsToUser('anonymous');
  expect(readChatId('chat')).toBe(id);
});

test('forgets every remembered chat id when the tab becomes another user', () => {
  bindChatIdsToUser('anonymous');
  getOrCreateChatId('chat');
  getOrCreateChatId('writer', 'canvas');
  sessionStorage.setItem('unrelated', 'stays');

  bindChatIdsToUser('user-1');

  expect(readChatId('chat')).toBeNull();
  expect(readChatId('writer', 'canvas')).toBeNull();
  expect(sessionStorage.getItem('unrelated')).toBe('stays');
});

test('binds the first user it sees without forgetting anything', () => {
  const id = getOrCreateChatId('chat');
  bindChatIdsToUser('user-1');
  expect(readChatId('chat')).toBe(id);
});
