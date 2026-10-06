/**
 * The Outlook pane's pop-out: the chat moves into an Office dialog the user
 * can resize, and the pane stays behind as the dialog's way to Outlook.
 *
 * Pinned here:
 *
 * - the message bridge between the two windows (calls, answers, events,
 *   messages too long for one Office message, strangers' messages ignored);
 * - the dialog's Outlook gateway: with it installed, the Outlook utilities
 *   ask the pane instead of an `Office.context.mailbox` the dialog does not
 *   have, and answer the synchronous questions from the pane's last word;
 * - how a chat travels between the windows: its route state and its
 *   transcript in session storage;
 * - the pane-side helpers: when the pane offers the pop-out, and the address
 *   it opens.
 */

import '@testing-library/jest-dom';

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`,
  getBasePath: () => '',
  KNOWN_ROUTES: []
}));

const {
  createPopoutEndpoint,
  BRIDGE_TIMEOUT_MESSAGE,
  BRIDGE_CLOSED_MESSAGE
} = require('../../../client/src/features/office/utilities/officePopoutBridge');

/** Two endpoints wired to each other, the way messageChild / messageParent do. */
function connect({
  paneHandlers = {},
  dialogHandlers = {},
  chunkSize,
  onPaneEvent,
  onDialogEvent
} = {}) {
  const sent = { toDialog: [], toPane: [] };
  let pane;
  let dialog;
  pane = createPopoutEndpoint({
    send: message => {
      sent.toDialog.push(message);
      queueMicrotask(() => dialog.receive(message));
    },
    handlers: paneHandlers,
    onEvent: onPaneEvent,
    chunkSize
  });
  dialog = createPopoutEndpoint({
    send: message => {
      sent.toPane.push(message);
      queueMicrotask(() => pane.receive(message));
    },
    handlers: dialogHandlers,
    onEvent: onDialogEvent,
    chunkSize
  });
  return { pane, dialog, sent };
}

describe('officePopoutBridge', () => {
  test('a call is answered with what the other side returns, sync or async', async () => {
    const { dialog } = connect({
      paneHandlers: {
        add: ({ a, b }) => a + b,
        later: async () => ({ ok: true })
      }
    });
    await expect(dialog.request('add', { a: 2, b: 3 })).resolves.toBe(5);
    await expect(dialog.request('later')).resolves.toEqual({ ok: true });
  });

  test('a handler that throws, or a method nobody serves, rejects the call', async () => {
    const { dialog } = connect({
      paneHandlers: {
        broken: () => {
          throw new Error('Outlook said no');
        }
      }
    });
    await expect(dialog.request('broken')).rejects.toThrow('Outlook said no');
    await expect(dialog.request('nope')).rejects.toThrow('Unknown method: nope');
  });

  test('events go one way and are answered by nobody', async () => {
    const onDialogEvent = jest.fn();
    const { pane, sent } = connect({ onDialogEvent });
    pane.emit('itemchanged', { mode: 'compose' });
    await Promise.resolve();
    expect(onDialogEvent).toHaveBeenCalledWith('itemchanged', { mode: 'compose' });
    expect(sent.toPane).toHaveLength(0);
  });

  test('a payload longer than one message arrives whole, in whatever order its parts come', async () => {
    const big = 'x'.repeat(10_000);
    const parts = [];
    const received = jest.fn();
    const sender = createPopoutEndpoint({ send: m => parts.push(m), chunkSize: 2048 });
    const receiver = createPopoutEndpoint({ send: () => {}, onEvent: received, chunkSize: 2048 });

    sender.emit('chatState', { transcript: big });
    expect(parts.length).toBeGreaterThan(4);
    expect(parts.every(part => part.length <= 2048)).toBe(true);

    [...parts].reverse().forEach(part => receiver.receive(part));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith('chatState', { transcript: big });
  });

  test('a large answer to a call is chunked too', async () => {
    const attachment = 'A'.repeat(50_000);
    const { dialog } = connect({
      paneHandlers: { readItemContext: () => ({ attachments: [{ content: attachment }] }) },
      chunkSize: 4096
    });
    const ctx = await dialog.request('readItemContext');
    expect(ctx.attachments[0].content).toBe(attachment);
  });

  test("other senders' messages and garbage are ignored", () => {
    const onEvent = jest.fn();
    const endpoint = createPopoutEndpoint({ send: () => {}, onEvent });
    endpoint.receive('https://ihub.example.com/office/callback.html?code=abc');
    endpoint.receive(JSON.stringify({ ihub: 'other', v: 1, t: 'evt', m: 'x' }));
    endpoint.receive('{not json');
    endpoint.receive(undefined);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('a call nobody answers fails after its timeout', async () => {
    jest.useFakeTimers();
    try {
      const endpoint = createPopoutEndpoint({ send: () => {}, timeoutMs: 1000 });
      const call = endpoint.request('hello');
      jest.advanceTimersByTime(1001);
      await expect(call).rejects.toThrow(BRIDGE_TIMEOUT_MESSAGE);
    } finally {
      jest.useRealTimers();
    }
  });

  test('disposing fails the calls still waiting and refuses new ones', async () => {
    const endpoint = createPopoutEndpoint({ send: () => {} });
    const waiting = endpoint.request('hello');
    endpoint.dispose();
    await expect(waiting).rejects.toThrow(BRIDGE_CLOSED_MESSAGE);
    await expect(endpoint.request('hello')).rejects.toThrow(BRIDGE_CLOSED_MESSAGE);
  });
});

describe('the popped-out chat routes Outlook through the pane', () => {
  afterEach(() => {
    delete global.Office;
  });

  /** A fresh module registry with the gateway installed (or not). */
  function load(remote) {
    const mods = {};
    jest.isolateModules(() => {
      mods.remote = require('../../../client/src/features/office/utilities/officeRemote');
      mods.capabilities = require('../../../client/src/features/office/utilities/officeCapabilities');
      mods.actions = require('../../../client/src/features/office/utilities/outlookMailActions');
      mods.context = require('../../../client/src/features/office/utilities/outlookMailContext');
      mods.attachments = require('../../../client/src/features/office/utilities/outlookAttachments');
      mods.navigation = require('../../../client/src/utils/externalNavigation');
      if (remote) mods.remote.setOfficeRemote(remote);
    });
    return mods;
  }

  // An Office dialog: Office.js is there, the mailbox is not.
  beforeEach(() => {
    global.Office = { context: { ui: { messageParent: jest.fn() } } };
  });

  test('without the gateway, the dialog has no mailbox', () => {
    const { capabilities, actions } = load(null);
    expect(capabilities.isMailboxAvailable()).toBe(false);
    expect(actions.detectOutlookMode()).toBeNull();
  });

  test("synchronous questions are answered from the pane's last word", () => {
    const remote = {
      state: {
        mailbox: true,
        mode: 'compose',
        isAppointment: false,
        attachHost: true,
        canAttach: true
      },
      call: jest.fn()
    };
    const mods = load(remote);
    expect(mods.capabilities.isMailboxAvailable()).toBe(true);
    expect(mods.actions.detectOutlookMode()).toBe('compose');
    expect(mods.capabilities.isOutlookAppointmentMode()).toBe(false);
    expect(mods.attachments.isOutlookAttachmentHost()).toBe(true);
    expect(mods.attachments.canAttachFileToOutlookItem()).toBe(true);

    // An item change in the pane updates them before the dialog's own event.
    mods.remote.updateOfficeRemoteState({ mode: 'read', isAppointment: true, canAttach: false });
    expect(mods.actions.detectOutlookMode()).toBe('read');
    expect(mods.capabilities.isOutlookAppointmentMode()).toBe(true);
    expect(mods.attachments.canAttachFileToOutlookItem()).toBe(false);
    expect(remote.call).not.toHaveBeenCalled();
  });

  test('reading the item, running an action and attaching a file are asked of the pane', async () => {
    const remote = {
      state: { mailbox: true, mode: 'compose', attachHost: true, canAttach: true },
      call: jest.fn(async method => {
        if (method === 'readItemContext') return { available: true, itemId: 'ITEM-1' };
        if (method === 'readMailContext') return { available: true, itemId: 'ITEM-1' };
        if (method === 'runMailAction') return { ok: true, action: 'insert' };
        if (method === 'attachFile') return { ok: true };
        return null;
      })
    };
    const mods = load(remote);

    await expect(mods.context.fetchCurrentOutlookItemContext()).resolves.toEqual({
      available: true,
      itemId: 'ITEM-1'
    });
    await expect(mods.context.fetchCurrentMailContext()).resolves.toMatchObject({
      itemId: 'ITEM-1'
    });
    await expect(
      mods.actions.runOutlookMailAction('insert', '**Hi**', { forwardLabels: { from: 'From' } })
    ).resolves.toEqual({ ok: true, action: 'insert' });
    expect(remote.call).toHaveBeenCalledWith('runMailAction', {
      action: 'insert',
      markdown: '**Hi**',
      options: { forwardLabels: { from: 'From' } }
    });
    await expect(
      mods.attachments.attachFileToOutlookItem({ base64: 'QUJD', filename: 'a.pdf' })
    ).resolves.toEqual({ ok: true });
    expect(remote.call).toHaveBeenCalledWith('attachFile', { base64: 'QUJD', filename: 'a.pdf' });
  });

  test('a pane that is gone fails the action with a message instead of a throw', async () => {
    const remote = {
      state: { mailbox: true, mode: 'read' },
      call: jest.fn(() => Promise.reject(new Error('The Outlook pane did not answer.')))
    };
    const { actions } = load(remote);
    await expect(actions.runOutlookMailAction('reply', 'Hi')).resolves.toMatchObject({
      ok: false,
      action: 'reply',
      message: expect.stringContaining('The Outlook pane did not answer.')
    });
  });

  test('a URL is opened by the pane: the dialog has no openBrowserWindow', () => {
    const remote = { state: { mailbox: true }, call: jest.fn(() => Promise.resolve({ ok: true })) };
    const { navigation } = load(remote);
    expect(navigation.openExternalUrl('https://ihub.example.com/apps/mail')).toBe(true);
    expect(remote.call).toHaveBeenCalledWith('openUrl', {
      url: 'https://ihub.example.com/apps/mail'
    });
  });

  test('the dialog never refreshes the token itself: the pane does and hands it over', async () => {
    let auth;
    const remote = {
      state: {},
      call: jest.fn(async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }))
    };
    jest.isolateModules(() => {
      require('../../../client/src/features/office/utilities/officeRemote').setOfficeRemote(remote);
      auth = require('../../../client/src/features/office/api/officeAuth');
    });
    global.fetch = jest.fn();
    await auth.refreshAccessToken({ baseUrl: 'https://ihub.example.com', clientId: 'c' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(remote.call).toHaveBeenCalledWith('refreshToken');
    expect(auth.getAccessToken()).toBe('new-access');
    expect(auth.getRefreshToken()).toBe('new-refresh');
    delete global.fetch;
  });
});

describe('the pane side', () => {
  afterEach(() => {
    delete global.Office;
  });

  const popout = () => require('../../../client/src/features/office/utilities/officePopout');

  test('the pop-out page is the task-pane page, flagged', () => {
    const { buildPopoutUrl, isPopoutPage } = popout();
    const url = buildPopoutUrl({
      href: 'https://ihub.example.com/ihub/office/taskpane.html?_host_Info=Outlook#x',
      language: 'de',
      theme: 'dark'
    });
    expect(url).toBe(
      'https://ihub.example.com/ihub/office/taskpane.html?popout=1&lang=de&theme=dark'
    );
    expect(isPopoutPage(new URL(url).search)).toBe(true);
    expect(isPopoutPage('?_host_Info=Outlook')).toBe(false);
  });

  test('offered only in Outlook with a dialog API that can message the dialog', () => {
    const { isPopoutSupported } = popout();
    const office = isSupported => ({
      context: {
        mailbox: { item: {} },
        ui: { displayDialogAsync: jest.fn() },
        requirements: { isSetSupported: (set, version) => isSupported(set, version) }
      }
    });

    global.Office = office(set => set === 'DialogApi');
    expect(isPopoutSupported()).toBe(true);

    // Volume-licensed Outlook 2016/2019: no messageChild.
    global.Office = office(() => false);
    expect(isPopoutSupported()).toBe(false);

    // The browser extension and the web app: no Office at all.
    delete global.Office;
    expect(isPopoutSupported()).toBe(false);
  });
});

describe('a chat travelling between the windows', () => {
  const chatTravel = require('../../../client/src/features/office/utilities/officePopoutChat');
  beforeEach(() => sessionStorage.clear());

  const state = {
    app: { id: 'mail' },
    chatId: 'office-1',
    fresh: false,
    chatStored: false,
    transcript: JSON.stringify([{ id: 'u1', role: 'user', content: 'Hi' }]),
    variables: { tone: 'formal' },
    inputValue: 'half-typed',
    pinnedEmails: [{ itemId: 'E1' }]
  };

  test('opens as the same chat, with what it had besides its transcript', () => {
    expect(chatTravel.popoutChatRouteState(state)).toEqual({
      chatId: 'office-1',
      restoredChat: {
        variables: { tone: 'formal' },
        inputValue: 'half-typed',
        pinnedEmails: [{ itemId: 'E1' }]
      }
    });
  });

  test('a chat with nothing sent yet opens as a new chat, keeping what was typed', () => {
    const route = chatTravel.popoutChatRouteState({ ...state, fresh: true });
    expect(route).not.toHaveProperty('chatId');
    expect(route.restoredChat.inputValue).toBe('half-typed');
  });

  test('a chat that is not stored brings its transcript into session storage', () => {
    chatTravel.seedPopoutTranscript(state);
    expect(sessionStorage.getItem('ai_hub_chat_messages_office-1')).toBe(state.transcript);

    // An emptied chat leaves no stale copy behind.
    chatTravel.seedPopoutTranscript({ ...state, transcript: null });
    expect(sessionStorage.getItem('ai_hub_chat_messages_office-1')).toBeNull();
  });

  test('a stored chat brings nothing: the store has it', () => {
    chatTravel.seedPopoutTranscript({ ...state, chatStored: true });
    expect(sessionStorage.getItem('ai_hub_chat_messages_office-1')).toBeNull();
  });
});
