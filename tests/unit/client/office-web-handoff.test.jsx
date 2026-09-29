import {
  buildImportMessages,
  buildWebChatUrl,
  classifyImportError
} from '../../../client/src/features/office/utilities/officeWebHandoff';

/**
 * "Open in web" hands the pane's conversation to the web app. What matters
 * here is what does and does not travel: only settled user/assistant turns,
 * with what the model was actually sent, and never the host item.
 */

describe('buildImportMessages', () => {
  it('keeps settled user and assistant turns, oldest first', () => {
    expect(
      buildImportMessages([
        { id: '1', role: 'user', content: 'Reply that we accept.' },
        { id: '2', role: 'assistant', content: 'Dear Mara, we accept.' }
      ])
    ).toEqual([
      { role: 'user', content: 'Reply that we accept.' },
      { role: 'assistant', content: 'Dear Mara, we accept.' }
    ]);
  });

  it('leaves out what nobody said or what has no answer worth replaying', () => {
    const result = buildImportMessages([
      { role: 'assistant', content: 'Hello! How can I help?', isGreeting: true },
      { role: 'system', content: 'Chat cleared.' },
      { role: 'user', content: 'Summarize.' },
      { role: 'assistant', content: 'Streaming so f', loading: true },
      { role: 'assistant', content: 'Boom', error: true },
      { role: 'assistant', content: 'Half an ans', cancelled: true },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'The summary.' }
    ]);

    expect(result.map(m => m.content)).toEqual(['Summarize.', 'The summary.']);
  });

  it('sends a user turn as the model received it when the pane kept both', () => {
    // `content` is what the bubble shows; `rawContent` is what went out.
    expect(
      buildImportMessages([
        { role: 'user', content: 'Generate a reply', rawContent: 'Write a reply to Mara.' }
      ])
    ).toEqual([{ role: 'user', content: 'Write a reply to Mara.' }]);
  });

  it('carries a timestamp only when the message has one', () => {
    const result = buildImportMessages([
      { role: 'user', content: 'a', ts: '2026-09-29T08:00:00.000Z' },
      { role: 'assistant', content: 'b' }
    ]);

    expect(result[0].ts).toBe('2026-09-29T08:00:00.000Z');
    expect('ts' in result[1]).toBe(false);
  });

  it('never carries the host item: no email body, attachments or upload payloads', () => {
    const [message] = buildImportMessages([
      {
        role: 'user',
        content: 'Reply',
        hostContext: { bodyText: 'CONFIDENTIAL BODY' },
        fileData: { fileName: 'a.pdf', data: 'BASE64' },
        imageData: { data: 'BASE64' }
      }
    ]);

    expect(Object.keys(message).sort()).toEqual(['content', 'role']);
    expect(JSON.stringify(message)).not.toMatch(/CONFIDENTIAL|BASE64/);
  });

  it('is empty for anything that is not a transcript', () => {
    expect(buildImportMessages(undefined)).toEqual([]);
    expect(buildImportMessages(null)).toEqual([]);
    expect(buildImportMessages([null, undefined])).toEqual([]);
  });
});

describe('buildWebChatUrl', () => {
  it('addresses the route the web app opens a stored chat on', () => {
    expect(buildWebChatUrl('https://ihub.example.com', 'outlook-reply', 'chat-1')).toBe(
      'https://ihub.example.com/apps/outlook-reply/c/chat-1'
    );
  });

  it('keeps a deployment base path and tolerates a trailing slash', () => {
    expect(buildWebChatUrl('https://example.com/ihub/', 'a', 'chat-1')).toBe(
      'https://example.com/ihub/apps/a/c/chat-1'
    );
  });

  it('encodes ids rather than letting them alter the path', () => {
    expect(buildWebChatUrl('https://x.test', 'a/b', 'c d?')).toBe(
      'https://x.test/apps/a%2Fb/c/c%20d%3F'
    );
  });

  it('is null when any part is missing', () => {
    expect(buildWebChatUrl('', 'a', 'c')).toBeNull();
    expect(buildWebChatUrl('https://x.test', '', 'c')).toBeNull();
    expect(buildWebChatUrl('https://x.test', 'a', '')).toBeNull();
    expect(buildWebChatUrl(undefined, 'a', 'c')).toBeNull();
  });
});

describe('classifyImportError', () => {
  const failure = (status, code) => ({ response: { status, data: { details: { code } } } });

  it('recognises the server codes', () => {
    expect(classifyImportError(failure(503, 'CHAT_PERSISTENCE_UNAVAILABLE'))).toBe('unavailable');
    expect(classifyImportError(failure(403, 'APP_ACCESS_DENIED'))).toBe('denied');
    expect(classifyImportError(failure(400, 'TOO_MANY_MESSAGES'))).toBe('tooLong');
  });

  it('falls back on the status when the body carries no code', () => {
    expect(classifyImportError({ response: { status: 503 } })).toBe('unavailable');
    expect(classifyImportError({ response: { status: 403 } })).toBe('denied');
  });

  it('calls everything else a plain failure', () => {
    expect(classifyImportError(failure(500))).toBe('failed');
    expect(classifyImportError(new Error('Network Error'))).toBe('failed');
    expect(classifyImportError(undefined)).toBe('failed');
  });
});
