/**
 * Unit tests for MSG (.msg / Outlook) body extraction in
 * client/src/features/upload/utils/fileProcessing.js
 *
 * Regression coverage for the bug where HTML-only newsletters extracted only
 * the headers (Subject/From/To) and no body: such messages carry no plain-text
 * PidTagBody (0x1000) — the body lives in PidTagHtml (0x1013), surfaced by
 * msgreader as a `html` Uint8Array. The old code only read `fileData.body`, so
 * the body was silently dropped.
 *
 * The tests drive the pure `extractMsgContent(fileData)` with synthetic parsed
 * data so they don't depend on the binary parser (or on shipping a real .msg
 * fixture, which would leak private email content into the repo).
 */

import '@testing-library/jest-dom';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest. Mock the one endpoint
// it pulls in so the import chain stays out of the way.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => ({ categories: {}, mimeTypes: {} }))
}));

const {
  extractMsgContent,
  htmlToText
} = require('../../../client/src/features/upload/utils/fileProcessing');

const encodeUtf8 = str => new TextEncoder().encode(str);
// Encode a string as single-byte windows-1252 (sufficient for Latin-1 range).
const encodeLatin1 = str => Uint8Array.from([...str].map(c => c.charCodeAt(0) & 0xff));

describe('htmlToText', () => {
  it('strips tags, decodes entities and keeps block structure as line breaks', () => {
    const html =
      '<html><head><style>p{color:red}</style><title>x</title></head>' +
      '<body><p>Hello&nbsp;world</p><p>Zeile&amp;zwei</p><div>drei</div></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('Hello world\nZeile&zwei\ndrei');
  });

  it('drops script/style content entirely', () => {
    const text = htmlToText('<div>keep</div><script>alert(1)</script><style>.a{}</style>');
    expect(text).toBe('keep');
    expect(text).not.toMatch(/alert|\.a\{/);
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('extractMsgContent', () => {
  it('extracts the body from an HTML-only message stored as PidTagHtml bytes', async () => {
    // Mirrors the reported newsletter: no plain body, HTML lives in `html`.
    const fileData = {
      subject: 'Wochen-News vom 26. Juni 2026',
      senderName: 'Franz Kögl',
      senderEmail: '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=USER',
      senderSmtpAddress: 'Franz.Koegl@intrafind.com',
      recipients: [
        { name: 'Alle', smtpAddress: 'alle@intrafind.de', recipType: 'to' },
        { name: 'SM iFinder', smtpAddress: 'ifinder@intrafind.de', recipType: 'to' }
      ],
      messageDeliveryTime: 'Fri, 26 Jun 2026 08:55:24 GMT',
      internetCodepage: 65001,
      messageCodepage: 1252,
      html: encodeUtf8(
        '<html><body><p>Guten Morgen zusammen,</p><p>nächste Woche haben wir unser Audit.</p></body></html>'
      )
    };

    const result = await extractMsgContent(fileData);

    // Headers
    expect(result).toContain('Subject: Wochen-News vom 26. Juni 2026');
    // X.500 Exchange DN must be dropped in favour of the real SMTP address.
    expect(result).toContain('From: Franz Kögl <Franz.Koegl@intrafind.com>');
    expect(result).not.toContain('EXCHANGELABS');
    expect(result).toContain('To: Alle <alle@intrafind.de>, SM iFinder <ifinder@intrafind.de>');
    expect(result).toContain('Date: Fri, 26 Jun 2026 08:55:24 GMT');
    // Body — the part the old code dropped.
    expect(result).toContain('Guten Morgen zusammen,');
    expect(result).toContain('nächste Woche haben wir unser Audit.');
  });

  it('decodes HTML bytes using the declared windows-1252 code page', async () => {
    const fileData = {
      subject: 'Umlaut test',
      internetCodepage: 1252,
      html: encodeLatin1('<html><body><p>Grüße über Köln</p></body></html>')
    };
    const result = await extractMsgContent(fileData);
    expect(result).toContain('Grüße über Köln');
  });

  it('falls back to the bodyHtml string when no plain body exists', async () => {
    const fileData = {
      subject: 'HTML string body',
      bodyHtml: '<div>Hallo <b>Welt</b></div>'
    };
    const result = await extractMsgContent(fileData);
    expect(result).toContain('Hallo Welt');
  });

  it('prefers the plain-text body over HTML when both are present', async () => {
    const fileData = {
      subject: 'Both bodies',
      body: 'PLAIN BODY WINS',
      html: encodeUtf8('<p>html body</p>')
    };
    const result = await extractMsgContent(fileData);
    expect(result).toContain('PLAIN BODY WINS');
    expect(result).not.toContain('html body');
  });

  it('groups To and Cc recipients and prefers SMTP over Exchange DN', async () => {
    const fileData = {
      subject: 'Recipients',
      recipients: [
        { name: 'A', smtpAddress: 'a@example.com', recipType: 'to' },
        { name: 'B', email: '/O=EXCH/CN=B', smtpAddress: 'b@example.com', recipType: 'cc' }
      ]
    };
    const result = await extractMsgContent(fileData);
    expect(result).toContain('To: A <a@example.com>');
    expect(result).toContain('Cc: B <b@example.com>');
    expect(result).not.toContain('/O=EXCH');
  });

  it('lists attachment names without their content', async () => {
    const fileData = {
      subject: 'With attachments',
      body: 'see attached',
      attachments: [{ fileName: 'report.pdf' }, { name: 'data.xlsx' }]
    };
    const result = await extractMsgContent(fileData);
    expect(result).toContain('Attachments: report.pdf, data.xlsx');
  });

  it('returns headers only (no throw) when no body can be extracted', async () => {
    const fileData = { subject: 'Header only', senderName: 'Nobody' };
    const result = await extractMsgContent(fileData);
    expect(result).toBe('Subject: Header only\nFrom: Nobody');
  });

  it('returns an empty string for empty input', async () => {
    expect(await extractMsgContent(null)).toBe('');
    expect(await extractMsgContent(undefined)).toBe('');
  });
});
