#!/usr/bin/env node

/**
 * Regression tests for parsing attached emails (.eml) and meeting invites
 * (.ics/iCalendar) that Outlook exposes via getAttachmentContentAsync —
 * issue #1451 ("[Outlook] Bug: PDF / Word / .eml attachments fail silently
 * or throw"). These formats are plain text, so rather than treating them as
 * "unsupported" and dropping them, they're parsed into readable content —
 * see buildChatApiMessages.js's buildFileEntryForAttachment.
 *
 * Pure (atob/TextDecoder only) so it runs under node directly.
 *
 * Run directly: `node client/src/features/office/utilities/emailAttachmentParsers.test.js`.
 */

import { parseEmlAttachment, parseIcsAttachment } from './emailAttachmentParsers.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// A plain-text, single-part forwarded email.
const SIMPLE_EML =
  'RnJvbTogSmFuZSBEb2UgPGphbmVAZXhhbXBsZS5jb20+DQpUbzogQm9iIFNtaXRoIDxib2JAZXhhbXBsZS5jb20+DQpTdWJqZWN0OiBSZTogUTMgbnVtYmVycw0KRGF0ZTogTW9uLCAxNSBKdWwgMjAyNiAwOTowMDowMCArMDAwMA0KQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PVVURi04DQoNCkhpIEJvYiwNCg0KUGxlYXNlIHNlZSB0aGUgYXR0YWNoZWQgZmlndXJlcyBmb3IgUTMuDQoNClRoYW5rcywNCkphbmUNCg==';

// multipart/alternative with a quoted-printable plain part, an HTML part,
// and an RFC 2047 base64-encoded Subject header.
const MULTIPART_EML =
  'RnJvbTogSmFuZSBEb2UgPGphbmVAZXhhbXBsZS5jb20+DQpUbzogQm9iIFNtaXRoIDxib2JAZXhhbXBsZS5jb20+DQpTdWJqZWN0OiA9P1VURi04P0I/UnNPMmNuTjBaWElnVW1Wd2IzSjA/PQ0KRGF0ZTogVHVlLCAxNiBKdWwgMjAyNiAxMDowMDowMCArMDAwMA0KQ29udGVudC1UeXBlOiBtdWx0aXBhcnQvYWx0ZXJuYXRpdmU7IGJvdW5kYXJ5PSJCT1VOREFSWTEyMyINCg0KLS1CT1VOREFSWTEyMw0KQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PVVURi04DQpDb250ZW50LVRyYW5zZmVyLUVuY29kaW5nOiBxdW90ZWQtcHJpbnRhYmxlDQoNCkhlbGxvPTJDIHRoaXMgaXMgdGhlIHBsYWluIHBhcnQuDQoNCi0tQk9VTkRBUlkxMjMNCkNvbnRlbnQtVHlwZTogdGV4dC9odG1sOyBjaGFyc2V0PVVURi04DQoNCjxodG1sPjxib2R5PjxwPkhlbGxvLCB0aGlzIGlzIHRoZSA8Yj5odG1sPC9iPiBwYXJ0LjwvcD48L2JvZHk+PC9odG1sPg0KDQotLUJPVU5EQVJZMTIzLS0NCg==';

// A single-VEVENT meeting invite with a CN'd organizer and an escaped
// newline in DESCRIPTION.
const ICS =
  'QkVHSU46VkNBTEVOREFSDQpWRVJTSU9OOjIuMA0KQkVHSU46VkVWRU5UDQpTVU1NQVJZOlF1YXJ0ZXJseSBQbGFubmluZw0KRFRTVEFSVDoyMDI2MDcxNVQwOTAwMDBaDQpEVEVORDoyMDI2MDcxNVQxMDAwMDBaDQpMT0NBVElPTjpDb25mZXJlbmNlIFJvb20gQQ0KT1JHQU5JWkVSO0NOPUphbmUgRG9lOm1haWx0bzpqYW5lQGV4YW1wbGUuY29tDQpERVNDUklQVElPTjpQbGVhc2UgcmV2aWV3IHRoZSBkZWNrXG5iZWZvcmUgdGhlIGNhbGwuDQpFTkQ6VkVWRU5UDQpFTkQ6VkNBTEVOREFSDQo=';

console.log('🧪 parseEmlAttachment — simple plain-text email\n');
{
  const text = parseEmlAttachment(SIMPLE_EML);
  check('returns non-null', text !== null, text);
  check('includes Subject header', text?.includes('Subject: Re: Q3 numbers'));
  check('includes From header', text?.includes('From: Jane Doe <jane@example.com>'));
  check('includes To header', text?.includes('To: Bob Smith <bob@example.com>'));
  check('includes body text', text?.includes('Please see the attached figures for Q3.'));
}

console.log('\n🧪 parseEmlAttachment — multipart/alternative with encoded subject\n');
{
  const text = parseEmlAttachment(MULTIPART_EML);
  check('returns non-null', text !== null, text);
  check(
    'decodes RFC 2047 base64-encoded Subject',
    text?.includes('Subject: Förster Report'),
    text
  );
  check(
    'prefers the quoted-printable text/plain part over the HTML part',
    text?.includes('Hello, this is the plain part.'),
    text
  );
  check('does not leak MIME boundary markers into the output', !text?.includes('BOUNDARY123'));
}

console.log('\n🧪 parseEmlAttachment — malformed input\n');
{
  check('empty string → null', parseEmlAttachment('') === null);
  check('garbage (non-base64) → null', parseEmlAttachment('not-base64!!') === null);
  check(
    'base64 text with no header/body split → null',
    parseEmlAttachment(Buffer.from('just one line, no blank line').toString('base64')) === null
  );
}

console.log('\n🧪 parseIcsAttachment — meeting invite\n');
{
  const text = parseIcsAttachment(ICS);
  check('returns non-null', text !== null, text);
  check('includes the meeting subject', text?.includes('Meeting: Quarterly Planning'), text);
  check(
    'includes a formatted start/end time',
    text?.includes('When: 2026-07-15 09:00 – 2026-07-15 10:00'),
    text
  );
  check('includes the location', text?.includes('Location: Conference Room A'));
  check(
    'resolves ORGANIZER CN + mailto into "Name <email>"',
    text?.includes('Organizer: Jane Doe <jane@example.com>'),
    text
  );
  check(
    'unescapes the ICS-escaped newline in DESCRIPTION',
    text?.includes('Please review the deck\nbefore the call.'),
    text
  );
}

console.log('\n🧪 parseIcsAttachment — malformed input\n');
{
  check('empty string → null', parseIcsAttachment('') === null);
  check(
    'base64 text with no recognizable fields → null',
    parseIcsAttachment(Buffer.from('not an ics file at all').toString('base64')) === null
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
