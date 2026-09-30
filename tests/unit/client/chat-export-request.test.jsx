jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() }
}));

import { apiClient } from '../../../client/src/api/client';
import {
  ExportRequestError,
  fetchExport,
  requestExportText,
  signClipboardText
} from '../../../client/src/api/endpoints/exports';
import {
  buildChatExportRequest,
  buildExportSettings,
  buildExportTitle,
  canExportByIds,
  describeExportError,
  getEuIconMode,
  getExportableMessages,
  getMessagePreview,
  hasTextSignpost,
  isClipboardSignpostEnabled,
  shouldSignClipboardCopy,
  toExportMessage,
  toggleMessageSelection
} from '../../../client/src/features/chat/utils/exportRequest';
import {
  buildDocumentExportRequest,
  deriveDocumentTitle
} from '../../../client/src/shared/utils/markdownExports';

/**
 * Server-side exports (EU AI Act Art. 50(2), issues #2571/#2576).
 *
 * The export dialog must never claim more than the server can prove: a
 * stored chat goes out as message ids (the server loads what it stored), and
 * anything the store cannot vouch for — a turn made in this session, an
 * unstored chat — goes out as content, which the server checks against its
 * provenance records.
 */

const stored = (id, role, content, extra = {}) => ({
  id,
  serverId: id,
  role,
  content,
  fromServer: true,
  ...extra
});

describe('getExportableMessages', () => {
  it('drops greetings, streaming turns, errors, UI notices and empty messages', () => {
    const messages = [
      { id: 'g', role: 'assistant', content: 'Welcome!', isGreeting: true },
      { id: 'u1', role: 'user', content: 'Question' },
      { id: 'a1', role: 'assistant', content: 'Answer' },
      { id: 'l', role: 'assistant', content: 'partial', loading: true },
      { id: 'e', role: 'assistant', content: 'Boom', error: true },
      { id: 's', role: 'system', content: 'Transcription failed', isErrorMessage: true },
      { id: 'n', role: 'system', content: 'Notice' },
      { id: 'blank', role: 'user', content: '   ' },
      stored('stored-system', 'system', 'Stored system prompt')
    ];
    expect(getExportableMessages(messages).map(m => m.id)).toEqual(['u1', 'a1', 'stored-system']);
  });

  it('keeps structured output as JSON text', () => {
    const [message] = getExportableMessages([
      { id: 'j', role: 'assistant', content: { answer: 42 } }
    ]);
    expect(toExportMessage(message).content).toBe('{\n  "answer": 42\n}');
  });
});

describe('buildChatExportRequest', () => {
  const settings = {
    model: 'gpt-4o',
    style: 'concise',
    outputFormat: 'markdown',
    temperature: 0.7,
    variables: { tone: 'formal' }
  };

  it('exports a stored chat by message ids', () => {
    const body = buildChatExportRequest({
      format: 'pdf',
      messages: [stored('m1', 'user', 'Hi'), stored('m2', 'assistant', 'Hello')],
      serverBacked: true,
      chatId: 'chat-1',
      appId: 'chat',
      settings,
      template: 'professional'
    });
    expect(body).toEqual({
      format: 'pdf',
      source: 'chat',
      appId: 'chat',
      chatId: 'chat-1',
      messageIds: ['m1', 'm2'],
      settings,
      options: { template: 'professional' }
    });
    // The stored chat's own title wins on the server when none is given.
    expect(body.title).toBeUndefined();
    expect(body.messages).toBeUndefined();
  });

  it('sends content when one selected message has no stored id yet', () => {
    const body = buildChatExportRequest({
      format: 'docx',
      messages: [
        stored('m1', 'user', 'Hi'),
        {
          id: 'msg-live',
          role: 'assistant',
          content: 'Fresh answer',
          provenance: { model: { id: 'mistral' } }
        }
      ],
      serverBacked: true,
      chatId: 'chat-1',
      appId: 'chat',
      fallbackTitle: 'Chat — Hi'
    });
    expect(body.chatId).toBeUndefined();
    expect(body.messageIds).toBeUndefined();
    expect(body.messages).toEqual([
      { id: 'm1', role: 'user', content: 'Hi' },
      { id: 'msg-live', role: 'assistant', content: 'Fresh answer', model: 'mistral' }
    ]);
    expect(body.title).toBe('Chat — Hi');
    expect(body.options).toBeUndefined();
  });

  it('sends content for a chat that is not server-backed, even with stored ids', () => {
    const body = buildChatExportRequest({
      format: 'markdown',
      messages: [stored('m1', 'user', 'Hi', { ts: '2026-09-01T10:00:00Z' })],
      serverBacked: false,
      chatId: 'chat-1'
    });
    expect(body.messageIds).toBeUndefined();
    expect(body.messages).toEqual([
      { id: 'm1', role: 'user', content: 'Hi', timestamp: '2026-09-01T10:00:00.000Z' }
    ]);
  });

  it('only exports the selection that is exportable', () => {
    const body = buildChatExportRequest({
      format: 'txt',
      messages: [
        { id: 'g', role: 'assistant', content: 'Welcome', isGreeting: true },
        { id: 'u', role: 'user', content: 'Q' }
      ]
    });
    expect(body.messages.map(m => m.id)).toEqual(['u']);
  });

  it('carries the label options and the single-message flag', () => {
    const body = buildChatExportRequest({
      format: 'html',
      messages: [{ id: 'a', role: 'assistant', content: 'A' }],
      euIcon: true,
      humanReviewed: true,
      single: true
    });
    expect(body.options).toEqual({ euIcon: true, humanReviewed: true });
    expect(body.single).toBe(true);
  });

  it('prefers an explicit title over the fallback, for stored chats too', () => {
    const body = buildChatExportRequest({
      format: 'pdf',
      messages: [stored('m1', 'user', 'Hi')],
      serverBacked: true,
      chatId: 'c',
      title: 'Quarterly planning',
      fallbackTitle: 'ignored'
    });
    expect(body.title).toBe('Quarterly planning');
  });

  it('refuses an empty selection and an unknown format', () => {
    expect(() => buildChatExportRequest({ format: 'pdf', messages: [] })).toThrow(
      expect.objectContaining({ code: 'NO_MESSAGES' })
    );
    expect(() =>
      buildChatExportRequest({ format: 'rtf', messages: [{ role: 'user', content: 'x' }] })
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }));
  });
});

describe('canExportByIds', () => {
  it('needs a server-backed chat, a chat id and a stored id on every message', () => {
    const messages = [stored('a', 'user', 'x')];
    expect(canExportByIds(messages, { serverBacked: true, chatId: 'c' })).toBe(true);
    expect(canExportByIds(messages, { serverBacked: true, chatId: null })).toBe(false);
    expect(canExportByIds(messages, { serverBacked: false, chatId: 'c' })).toBe(false);
    expect(canExportByIds([], { serverBacked: true, chatId: 'c' })).toBe(false);
  });
});

describe('buildExportSettings', () => {
  it('drops empty values so the export shows no empty settings block', () => {
    expect(
      buildExportSettings({ model: undefined, style: '', temperature: null, variables: {} })
    ).toEqual({});
    expect(buildExportSettings({ temperature: 0 })).toEqual({ temperature: 0 });
  });
});

describe('buildExportTitle', () => {
  it('uses the app name and the first user message as the topic', () => {
    expect(
      buildExportTitle({
        appName: 'Sales Assistant',
        messages: [{ role: 'user', content: '**Pricing** for `Q3`?' }]
      })
    ).toBe('Sales Assistant — Pricing for ?');
    expect(buildExportTitle({ appName: 'Sales', messages: [], single: true })).toBe(
      'Sales — Message'
    );
    expect(buildExportTitle({ appName: 'Sales', messages: [] })).toBe('Sales — Chat');
  });
});

describe('toggleMessageSelection', () => {
  const keys = ['a', 'b', 'c', 'd'];

  it('toggles one message', () => {
    const next = toggleMessageSelection({ keys, selected: new Set(keys), key: 'b' });
    expect([...next]).toEqual(['a', 'c', 'd']);
  });

  it('applies the clicked state to the whole range on shift-click', () => {
    const next = toggleMessageSelection({
      keys,
      selected: new Set(['a']),
      key: 'd',
      anchorKey: 'b',
      range: true
    });
    expect([...next].sort()).toEqual(['a', 'b', 'c', 'd']);
    const cleared = toggleMessageSelection({
      keys,
      selected: new Set(keys),
      key: 'a',
      anchorKey: 'c',
      range: true
    });
    expect([...cleared]).toEqual(['d']);
  });
});

describe('EU AI icon and signposts', () => {
  it('shows the EU icon option only while AI transparency is on', () => {
    expect(getEuIconMode({ enabled: true, labels: { euIcon: 'optional' } })).toBe('optional');
    expect(getEuIconMode({ enabled: true, labels: { euIcon: 'always' } })).toBe('always');
    expect(getEuIconMode({ enabled: false, labels: { euIcon: 'always' } })).toBe('off');
    expect(getEuIconMode(null)).toBe('off');
  });

  it('lets the app override the clipboard signpost', () => {
    const aiConfig = { enabled: true, text: { signpost: { clipboard: true } } };
    expect(isClipboardSignpostEnabled(aiConfig, null)).toBe(true);
    expect(
      isClipboardSignpostEnabled(aiConfig, { aiTransparency: { signpost: { clipboard: false } } })
    ).toBe(false);
  });

  it('signs copied text and markdown once, never JSON', () => {
    const aiConfig = { enabled: true, text: { signpost: { clipboard: true } } };
    const signed = `Text﻿${String.fromCodePoint(0xe0133)}`;
    expect(hasTextSignpost(signed)).toBe(true);
    expect(shouldSignClipboardCopy({ format: 'txt', text: 'Text', aiConfig })).toBe(true);
    expect(shouldSignClipboardCopy({ format: 'markdown', text: signed, aiConfig })).toBe(false);
    expect(shouldSignClipboardCopy({ format: 'json', text: '{}', aiConfig })).toBe(false);
  });
});

describe('describeExportError', () => {
  it('maps statuses to translated messages', () => {
    expect(describeExportError({ status: 403 }).key).toBe('pages.appChat.export.errors.disabled');
    expect(describeExportError({ status: 404 }).key).toBe(
      'pages.appChat.export.errors.chatNotFound'
    );
    expect(describeExportError({ status: 400, message: 'Bad' })).toMatchObject({
      key: 'pages.appChat.export.errors.failed',
      params: { message: 'Bad' }
    });
    expect(describeExportError({ code: 'DOWNLOAD_BLOCKED' }).key).toBe(
      'pages.appChat.export.errors.downloadBlocked'
    );
  });
});

describe('getMessagePreview', () => {
  it('flattens markdown to one short line', () => {
    expect(getMessagePreview({ content: '# Title\n\nSome **bold** [link](http://x)' })).toBe(
      'Title Some bold link'
    );
    expect(getMessagePreview({ content: 'x'.repeat(200) }, 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('buildDocumentExportRequest', () => {
  it('sends the document as the one assistant message with its source', () => {
    expect(
      buildDocumentExportRequest({
        content: '# Audit\n\nBody',
        name: 'audit-report.md',
        format: 'pdf',
        source: 'workflow'
      })
    ).toEqual({
      format: 'pdf',
      source: 'workflow',
      title: 'audit-report',
      messages: [{ role: 'assistant', content: '# Audit\n\nBody' }],
      single: true
    });
  });

  it('marks canvas documents as edited and keeps the app', () => {
    const body = buildDocumentExportRequest({
      content: 'Draft',
      format: 'docx',
      source: 'canvas',
      appId: 'writer',
      title: 'My draft'
    });
    expect(body).toMatchObject({ source: 'canvas', appId: 'writer', title: 'My draft' });
  });

  it('derives a title from the first heading and refuses empty documents', () => {
    expect(deriveDocumentTitle('Intro line\n## Section')).toBe('Section');
    expect(deriveDocumentTitle('Just *text*')).toBe('Just text');
    expect(buildDocumentExportRequest({ content: '# Heading', format: 'html' }).title).toBe(
      'Heading'
    );
    expect(() => buildDocumentExportRequest({ content: '  ', format: 'pdf' })).toThrow();
  });
});

describe('api/endpoints/exports', () => {
  afterEach(() => jest.clearAllMocks());

  it('posts the body, and names the file after Content-Disposition', async () => {
    apiClient.post.mockResolvedValue({
      data: new Blob(['# Export'], { type: 'text/markdown' }),
      headers: {
        'content-disposition': 'attachment; filename="a.md"; filename*=UTF-8\'\'%C3%BCber.md',
        'content-type': 'text/markdown',
        'x-ai-export-manifest': 'exp_1'
      }
    });
    const body = { format: 'markdown', messages: [{ role: 'user', content: 'x' }] };
    const result = await fetchExport(body);
    expect(apiClient.post).toHaveBeenCalledWith(
      '/exports',
      body,
      expect.objectContaining({ responseType: 'blob' })
    );
    expect(result.filename).toBe('über.md');
    expect(result.manifestId).toBe('exp_1');
    await expect(requestExportText(body)).resolves.toBe('# Export');
  });

  it('falls back to a generated filename without the header', async () => {
    apiClient.post.mockResolvedValue({ data: new Blob(['x']), headers: {} });
    const result = await fetchExport({ format: 'pdf', title: 'Team sync' });
    expect(result.filename).toMatch(/^team-sync-\d{4}-\d{2}-\d{2}_\d{4}\.pdf$/);
  });

  it('turns a JSON error body inside a Blob into an ExportRequestError', async () => {
    apiClient.post.mockRejectedValue({
      message: 'Request failed with status code 403',
      response: {
        status: 403,
        data: new Blob([JSON.stringify({ error: 'Exports are disabled' })])
      }
    });
    const error = await fetchExport({ format: 'pdf' }).catch(e => e);
    expect(error).toBeInstanceOf(ExportRequestError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('Exports are disabled');
  });

  it('asks the server for the clipboard signpost and keeps the text otherwise', async () => {
    apiClient.post.mockResolvedValue({ data: { text: 'signed', signed: true } });
    await expect(signClipboardText('plain', 'chat')).resolves.toBe('signed');
    expect(apiClient.post).toHaveBeenCalledWith('/provenance/signpost', {
      text: 'plain',
      appId: 'chat'
    });
    apiClient.post.mockResolvedValue({ data: {} });
    await expect(signClipboardText('plain')).resolves.toBe('plain');
  });
});
