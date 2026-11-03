// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The open email, added emails, open meeting and open page as chat files
 * (`origin: 'email' | 'meeting' | 'page'`) — client/src/features/office/utilities/
 * hostItemFiles.js and `buildHostItems` / the attachment `base64` of
 * buildChatApiMessages.js.
 *
 * What must hold: the stored form renders byte-identically to the `hostContext`
 * form (the app prompts do not change), names are safe, originals are sent only
 * where the storage mode keeps them and within the per-file cap, and without a
 * storing chat nothing changes.
 */

import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

jest.mock('../../../client/src/features/upload/utils/fileProcessing', () => ({
  processDocumentFile: jest.fn(async file => ({
    content: `MOCK_TEXT(${file?.name || 'unknown'})`,
    pageImages: undefined
  })),
  resizeImageCanvas: jest.fn()
}));

const {
  buildHostContext,
  buildHostItems,
  buildFileDataFromMailAttachments
} = require('../../../client/src/features/office/utilities/buildChatApiMessages');
const {
  MAX_ORIGINAL_BYTES,
  base64Bytes,
  normalizeItemUrl,
  omitRepeatedOriginals,
  originalWithinCap,
  sanitizeItemFileName,
  stableItemId,
  synthesizeEmlBase64
} = require('../../../client/src/features/office/utilities/hostItemFiles');
const {
  parseEmlAttachment
} = require('../../../client/src/features/office/utilities/emailAttachmentParsers');
const { renderUserMessage } = require('../../../shared/promptContext');

const FULL = { mode: 'original_and_text' };
const SERVER_TEXT = { mode: 'server_text_only' };
const CLIENT_TEXT = { mode: 'client_text_only' };

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const unb64 = base64 => Buffer.from(base64, 'base64').toString('utf8');

const EMAIL = {
  available: true,
  itemKind: 'message',
  itemId: 'AAMkAGI2',
  subject: 'Angebot: Preise/2026',
  from: { name: 'Mara Müller', email: 'mara@example.com' },
  to: [
    { name: 'Jonas', email: 'jonas@example.com' },
    { name: 'Eva', email: 'eva@example.com' }
  ],
  cc: [{ name: 'Chef', email: 'chef@example.com' }],
  dateTimeCreated: '2026-11-03T08:15:00.000Z',
  mailboxUser: { name: 'Jonas', email: 'jonas@example.com' },
  bodyText: 'Hallo Jonas,\n\nanbei das Angebot.\n\nMara',
  attachments: []
};
const PINNED = [
  {
    itemId: 'AAMkPINNED',
    subject: 'Vorab',
    from: { name: 'Eva', email: 'eva@example.com' },
    to: [{ name: 'Jonas', email: 'jonas@example.com' }],
    cc: [],
    dateTimeCreated: '2026-10-30T15:00:00.000Z',
    bodyText: 'Kurze Info vorab.'
  }
];
const MEETING = {
  available: true,
  itemKind: 'appointment',
  itemId: 'AAMkMEET',
  subject: 'Planung',
  isOrganizer: false,
  organizer: { name: 'Mara', email: 'mara@example.com' },
  start: '2026-11-04T09:00:00.000Z',
  end: '2026-11-04T10:00:00.000Z',
  location: 'Raum 5',
  requiredAttendees: [{ name: 'Jonas', email: 'jonas@example.com' }],
  optionalAttendees: [],
  bodyText: 'Agenda: Budget'
};
const PAGE = {
  available: true,
  itemKind: 'page',
  title: 'Docs: Intro / Start',
  url: 'https://Example.com/docs#top',
  bodyText: '# Docs\n\nHello'
};

describe('buildHostItems', () => {
  test('without a storing chat it is hostContext, exactly as before', () => {
    const out = buildHostItems({ item: EMAIL, pinned: PINNED, storage: null });
    expect(out.fileData).toBeNull();
    expect(out.hostContext).toEqual(buildHostContext({ item: EMAIL, pinned: PINNED }));
    expect(out.hostContext.currentEmail.subject).toBe('Angebot: Preise/2026');
    expect(buildHostItems({ item: null, storage: null })).toEqual({
      hostContext: null,
      fileData: null
    });
  });

  test('with a storing chat the email, the added emails and no hostContext', () => {
    const { hostContext, fileData } = buildHostItems({
      item: EMAIL,
      pinned: PINNED,
      storage: FULL
    });
    expect(hostContext).toBeNull();
    expect(fileData).toHaveLength(2);
    const [added, open] = fileData;
    expect(added).toMatchObject({
      origin: 'email',
      type: 'document',
      fileName: 'Vorab.eml',
      fileType: 'message/rfc822',
      meta: { itemId: 'AAMkPINNED', subject: 'Vorab', isCurrent: false }
    });
    expect(open).toMatchObject({
      origin: 'email',
      fileName: 'Angebot Preise 2026.eml',
      fileType: 'message/rfc822',
      meta: {
        itemId: 'AAMkAGI2',
        subject: 'Angebot: Preise/2026',
        from: 'Mara Müller (mara@example.com)',
        mailboxUser: 'Jonas (jonas@example.com)',
        isCurrent: true
      }
    });
    expect(open.content).toMatch(/^From: Mara Müller \(mara@example\.com\)\nTo: Jonas/);
    expect(open.content).toMatch(/\nMailbox-User: Jonas \(jonas@example\.com\)\n\nHallo Jonas/);
  });

  test('what is rendered from the files equals what is rendered from hostContext', () => {
    for (const storage of [FULL, SERVER_TEXT, CLIENT_TEXT]) {
      for (const item of [EMAIL, MEETING, PAGE]) {
        const pinned = item === EMAIL ? PINNED : [];
        const viaHost = renderUserMessage({
          content: 'Bitte antworten',
          hostContext: buildHostContext({ item, pinned })
        });
        const { fileData } = buildHostItems({ item, pinned, storage });
        const viaFiles = renderUserMessage({ content: 'Bitte antworten', files: fileData });
        expect(viaFiles).toBe(viaHost);
        expect(viaFiles).toMatch(/<content type="(email|meeting|page)" origin="open">/);
      }
    }
  });

  test('the open email also keeps its Mailbox-User line', () => {
    const { fileData } = buildHostItems({ item: EMAIL, storage: SERVER_TEXT });
    expect(renderUserMessage({ content: '', files: fileData })).toContain(
      '<mailbox_user>Jonas (jonas@example.com)</mailbox_user>'
    );
  });

  test('a body the user excluded leaves headers only, like hostContext', () => {
    const noBody = { ...EMAIL, bodyText: null };
    const viaHost = renderUserMessage({
      content: 'x',
      hostContext: buildHostContext({ item: noBody })
    });
    const { fileData } = buildHostItems({ item: noBody, storage: FULL });
    expect(renderUserMessage({ content: 'x', files: fileData })).toBe(viaHost);
    expect(fileData[0].base64).toBeUndefined(); // nothing to put in an .eml
  });

  test('meeting and page: names, types and meta', () => {
    const [meeting] = buildHostItems({ item: MEETING, storage: FULL }).fileData;
    expect(meeting).toMatchObject({
      origin: 'meeting',
      fileName: 'Planung.ics',
      fileType: 'text/calendar',
      meta: { itemId: 'AAMkMEET', subject: 'Planung', location: 'Raum 5' }
    });
    expect(meeting.base64).toBeUndefined();

    const [page] = buildHostItems({ item: PAGE, storage: FULL }).fileData;
    expect(page).toMatchObject({
      origin: 'page',
      fileName: 'Docs Intro Start.md',
      fileType: 'text/markdown',
      meta: {
        url: 'https://example.com/docs',
        itemId: 'https://example.com/docs',
        title: PAGE.title
      }
    });
    expect(
      page.content.startsWith('Title: Docs: Intro / Start\nURL: https://Example.com/docs#top')
    ).toBe(true);
    expect(page.base64).toBeUndefined();
  });

  test('a page without text and an unavailable item produce nothing', () => {
    expect(buildHostItems({ item: { ...PAGE, bodyText: '' }, storage: FULL }).fileData).toBeNull();
    expect(buildHostItems({ item: { available: false }, storage: FULL }).fileData).toBeNull();
  });

  test('a pinned email that is the open one is not added twice', () => {
    const { fileData } = buildHostItems({
      item: EMAIL,
      pinned: [{ ...PINNED[0], itemId: EMAIL.itemId }, PINNED[0]],
      storage: FULL
    });
    expect(fileData.map(f => f.meta.itemId)).toEqual(['AAMkPINNED', 'AAMkAGI2']);
  });

  test('an item without an Outlook id gets a stable one', () => {
    const draft = { ...EMAIL, itemId: null };
    const a = buildHostItems({ item: draft, storage: FULL }).fileData[0].meta.itemId;
    const b = buildHostItems({
      item: { ...draft, bodyText: 'edited body' },
      storage: FULL
    }).fileData[0].meta.itemId;
    expect(a).toMatch(/^local:email:/);
    expect(b).toBe(a);
    expect(stableItemId('email', 'real', ['x'])).toBe('real');
    expect(stableItemId('email', null, ['x'], true)).not.toBe(
      stableItemId('email', null, ['x'], false)
    );
  });
});

describe('originals of the open email', () => {
  test('original_and_text: the real .eml wins, else a synthesized one', () => {
    const real = b64('From: real@example.com\r\n\r\nreal');
    expect(buildHostItems({ item: EMAIL, storage: FULL, emlBase64: real }).fileData[0].base64).toBe(
      real
    );
    const synthesized = buildHostItems({ item: EMAIL, storage: FULL }).fileData[0].base64;
    expect(typeof synthesized).toBe('string');
    expect(synthesized).not.toBe(real);
    // added (pinned) emails get a synthesized original, never the real one of the open email
    const { fileData } = buildHostItems({
      item: EMAIL,
      pinned: PINNED,
      storage: FULL,
      emlBase64: real
    });
    expect(fileData[0].base64).not.toBe(real);
    expect(unb64(fileData[0].base64)).toContain('Subject: Vorab');
  });

  test('server_text_only and client_text_only send text only, whatever Outlook offered', () => {
    const real = b64('From: real@example.com\r\n\r\nreal');
    for (const storage of [SERVER_TEXT, CLIENT_TEXT]) {
      const { fileData } = buildHostItems({
        item: EMAIL,
        pinned: PINNED,
        storage,
        emlBase64: real
      });
      for (const entry of fileData) expect('base64' in entry).toBe(false);
    }
  });

  test('an original above the per-file cap is not sent', () => {
    const big = Buffer.alloc(2048, 1).toString('base64');
    expect(originalWithinCap(big, { ...FULL, maxFileBytes: 4096 })).toBe(big);
    expect(originalWithinCap(big, { ...FULL, maxFileBytes: 1024 })).toBeUndefined();
    expect(originalWithinCap(big, SERVER_TEXT)).toBeUndefined();
    expect(originalWithinCap('', FULL)).toBeUndefined();
    expect(base64Bytes(big)).toBe(2048);
    expect(MAX_ORIGINAL_BYTES).toBe(25 * 1024 * 1024);
    const { fileData } = buildHostItems({
      item: EMAIL,
      storage: { ...FULL, maxFileBytes: 4096 },
      emlBase64: Buffer.alloc(8192, 1).toString('base64')
    });
    expect(fileData[0].base64).toBeUndefined();
    expect(fileData[0].content).toContain('Subject: Angebot');
  });
});

describe('synthesized .eml', () => {
  const eml = () => synthesizeEmlBase64(EMAIL);

  test('is a CRLF message with folded, encoded headers and a base64 UTF-8 body', () => {
    const raw = unb64(eml());
    const [head, bodyPart] = raw.split('\r\n\r\n');
    expect(raw).not.toMatch(/[^\r]\n/);
    for (const line of head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(head).toContain('From: =?UTF-8?B?'); // "Mara Müller" is not ASCII
    expect(head).toContain('To: Jonas <jonas@example.com>, Eva <eva@example.com>');
    expect(head).toContain('Cc: Chef <chef@example.com>');
    expect(head).toContain('Date: Tue, 03 Nov 2026 08:15:00 +0000');
    expect(head).toContain('Subject: Angebot: Preise/2026');
    expect(head).toContain('Content-Type: text/plain; charset=utf-8');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(bodyPart.replaceAll('\r\n', ''), 'base64').toString('utf8')).toBe(
      EMAIL.bodyText.replaceAll('\n', '\r\n')
    );
  });

  test('is read back by the client parser', () => {
    const text = parseEmlAttachment(eml());
    expect(text).toContain('Subject: Angebot: Preise/2026');
    expect(text).toMatch(/From: Mara Müller\s*<mara@example\.com>/);
    expect(text).toContain('Hallo Jonas,');
    expect(text).toContain('anbei das Angebot.');
  });

  test('encodes a long non-ASCII subject in words that never split a character', () => {
    const subject =
      'Überprüfung der Vertragsänderungen für das Geschäftsjahr — 日本語のテキストも含む';
    const raw = unb64(synthesizeEmlBase64({ ...EMAIL, subject }));
    const head = raw.split('\r\n\r\n')[0];
    const unfolded = head.replaceAll(/\r\n[ \t]/g, ' ');
    const line = unfolded.split('\r\n').find(l => l.startsWith('Subject:'));
    const words = [...line.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m =>
      Buffer.from(m[1], 'base64').toString('utf8')
    );
    expect(words.join('')).toBe(subject);
    expect(words.every(w => !w.includes('�'))).toBe(true);
    for (const l of head.split('\r\n')) expect(l.length).toBeLessThanOrEqual(78);
  });

  test('quotes names with specials, skips invalid addresses and cannot be header-injected', () => {
    const raw = unb64(
      synthesizeEmlBase64({
        subject: 'Hi\r\nBcc: evil@example.com',
        from: { name: 'Doe, John "JD"', email: 'john@example.com' },
        to: [
          { name: 'x', email: 'not an address' },
          { name: 'Ok', email: 'ok@example.com' }
        ],
        cc: [],
        dateTimeCreated: 'garbage',
        bodyText: 'body'
      })
    );
    const head = raw.split('\r\n\r\n')[0];
    expect(head).toContain('From: "Doe, John \\"JD\\"" <john@example.com>');
    expect(head).toContain('To: Ok <ok@example.com>');
    expect(head).not.toContain('not an address');
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toContain('Subject: Hi Bcc: evil@example.com');
    expect(head).not.toMatch(/^Date:/m);
  });

  test('nothing without a body', () => {
    expect(synthesizeEmlBase64({ ...EMAIL, bodyText: '  ' })).toBeNull();
    expect(synthesizeEmlBase64(null)).toBeNull();
  });
});

describe('file names, ids and meta', () => {
  test('names have no separators or control characters, are capped and never empty', () => {
    expect(sanitizeItemFileName('a/b\\c:d*e?"f<g>h|i', '.eml', 'Email')).toBe(
      'a b c d e f g h i.eml'
    );
    expect(sanitizeItemFileName('line\nbreak\u0000nul\u202e', '.md', 'Page')).toBe(
      'line break nul.md'
    );
    expect(sanitizeItemFileName('  ..hidden..  ', '.eml', 'Email')).toBe('hidden.eml');
    expect(sanitizeItemFileName('', '.eml', 'Email')).toBe('Email.eml');
    expect(sanitizeItemFileName(null, '.ics', 'Meeting')).toBe('Meeting.ics');
    expect(sanitizeItemFileName('///', '.ics', 'Meeting')).toBe('Meeting.ics');
    expect(sanitizeItemFileName('x'.repeat(500), '.eml', 'Email')).toHaveLength(104);
    expect(sanitizeItemFileName('日本語'.repeat(80), '.eml', 'Email')).toHaveLength(104);
    expect(sanitizeItemFileName('RE: ../../etc/passwd', '.eml', 'Email')).toBe(
      'RE .. .. etc passwd.eml'
    );
  });

  test('page ids are the URL without fragment', () => {
    expect(normalizeItemUrl('https://Example.com/a/b/#x')).toBe('https://example.com/a/b/');
    expect(normalizeItemUrl('https://example.com/?q=1#x')).toBe('https://example.com/?q=1');
    expect(normalizeItemUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeItemUrl('')).toBe('');
  });

  test('meta stays far below the server limit even for a huge recipient list', () => {
    const many = Array.from({ length: 800 }, (_, i) => ({
      name: `Person ${i}`,
      email: `person${i}@example.com`
    }));
    const { fileData } = buildHostItems({ item: { ...EMAIL, to: many, cc: many }, storage: FULL });
    const entry = fileData[0];
    expect(Buffer.byteLength(JSON.stringify(entry.meta))).toBeLessThan(8 * 1024);
    expect(entry.meta.itemId).toBe('AAMkAGI2');
    expect(entry.meta.isCurrent).toBe(true);
    // the text keeps the whole list
    expect(entry.content).toContain('person799@example.com');
    expect(renderUserMessage({ content: '', files: fileData })).toContain('person799@example.com');
  });
});

describe('attachments keep their original', () => {
  const docx = {
    id: 'att1',
    name: 'Vertrag.docx',
    size: 3000,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: { format: 'base64', content: b64('PK-docx-bytes') }
  };

  test('storing chat with originals: base64 next to the extracted text', async () => {
    const [entry] = await buildFileDataFromMailAttachments([docx], undefined, FULL);
    expect(entry).toMatchObject({
      origin: 'attachment',
      fileName: 'Vertrag.docx',
      content: 'MOCK_TEXT(Vertrag.docx)',
      base64: docx.content.content
    });
  });

  test('server_text_only, client_text_only, no storing chat and over the cap: no base64', async () => {
    for (const storage of [SERVER_TEXT, CLIENT_TEXT, null, undefined]) {
      const [entry] = await buildFileDataFromMailAttachments([docx], undefined, storage);
      expect('base64' in entry).toBe(false);
    }
    const [capped] = await buildFileDataFromMailAttachments([docx], undefined, {
      ...FULL,
      maxFileBytes: 4
    });
    expect('base64' in capped).toBe(false);
    expect(capped.content).toBe('MOCK_TEXT(Vertrag.docx)');
  });

  test('cloud links have no bytes to keep; attached emails keep theirs', async () => {
    const eml = `Subject: Hi\r\nFrom: a@example.com\r\n\r\nHello there`;
    const entries = await buildFileDataFromMailAttachments(
      [
        {
          id: 'u',
          name: 'Link',
          contentType: 'application/pdf',
          content: { format: 'url', content: 'https://share.example.com/x' }
        },
        {
          id: 'e',
          name: 'fwd.eml',
          contentType: 'message/rfc822',
          content: { format: 'eml', content: b64(eml) }
        }
      ],
      undefined,
      FULL
    );
    expect('base64' in entries[0]).toBe(false);
    expect(entries[1].base64).toBe(b64(eml));
    expect(entries[1].content).toContain('Hello there');
  });
});

describe('an original is sent once per chat', () => {
  test('the same email and attachment lose their base64 on the next turn, a changed one keeps it', () => {
    const sent = new Set();
    const { fileData } = buildHostItems({ item: EMAIL, storage: FULL });
    const att = { fileName: 'a.docx', origin: 'attachment', content: 't', base64: b64('bytes') };
    const turn1 = omitRepeatedOriginals([...fileData, att], sent);
    expect(turn1.every(e => e.base64)).toBe(true);
    const turn2 = omitRepeatedOriginals(
      [...buildHostItems({ item: EMAIL, storage: FULL }).fileData, att],
      sent
    );
    expect(turn2.every(e => !('base64' in e))).toBe(true);
    expect(turn2[0].content).toBe(fileData[0].content);
    const changed = buildHostItems({ item: { ...EMAIL, bodyText: 'new' }, storage: FULL }).fileData;
    expect(omitRepeatedOriginals(changed, sent)[0].base64).toBeTruthy();
    // switching the email from open to added changes what the server compares
    const asAdded = buildHostItems({
      item: { available: false },
      pinned: [{ ...EMAIL, itemId: EMAIL.itemId }],
      storage: FULL
    }).fileData;
    expect(omitRepeatedOriginals(asAdded, sent)[0].base64).toBeTruthy();
  });
});

describe('fetchCurrentMailEml', () => {
  const {
    fetchCurrentMailEml
  } = require('../../../client/src/features/office/utilities/outlookMailContext');
  const setItem = item => {
    global.Office = {
      AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
      context: { mailbox: { item } }
    };
  };
  const itemWith = (overrides = {}) => ({
    itemId: 'm1',
    attachments: [{ id: 'a1' }],
    getAsFileAsync: jest.fn(cb => cb({ status: 'succeeded', value: 'RU1M' })),
    ...overrides
  });
  afterEach(() => {
    delete global.Office;
  });

  test('returns the message Outlook has and keeps it for the next turn', async () => {
    const item = itemWith({ itemId: 'm-cache' });
    setItem(item);
    expect(await fetchCurrentMailEml('m-cache', ['a1'])).toBe('RU1M');
    expect(await fetchCurrentMailEml('m-cache', ['a1'])).toBe('RU1M');
    expect(item.getAsFileAsync).toHaveBeenCalledTimes(1);
  });

  test('null when the item changed, an attachment was removed, or the API is missing', async () => {
    setItem(itemWith({ itemId: 'm2' }));
    expect(await fetchCurrentMailEml('other', ['a1'])).toBeNull();
    expect(await fetchCurrentMailEml('m2', [])).toBeNull(); // a1 was taken out of the context
    expect(await fetchCurrentMailEml(null, ['a1'])).toBeNull();
    setItem(itemWith({ itemId: 'm3', getAsFileAsync: undefined }));
    expect(await fetchCurrentMailEml('m3', ['a1'])).toBeNull();
    setItem(itemWith({ itemId: 'm4', getAsFileAsync: cb => cb({ status: 'failed', error: {} }) }));
    expect(await fetchCurrentMailEml('m4', ['a1'])).toBeNull();
    delete global.Office;
    expect(await fetchCurrentMailEml('m4', ['a1'])).toBeNull();
  });
});
