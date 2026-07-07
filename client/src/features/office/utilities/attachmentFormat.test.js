#!/usr/bin/env node

/**
 * Regression tests for Outlook attachment format handling — issue #1451
 * ("[Outlook] Bug: PDF / Word / .eml attachments fail silently or throw").
 *
 * Covers the classification helpers that decide whether an attachment
 * descriptor (as produced by outlookMailContext.js) is usable content,
 * an unsupported format (attached email / invite / cloud link), or a
 * genuine fetch failure. Pure (no React, no Office.js) so it runs under
 * node directly.
 *
 * Run directly: `node client/src/features/office/utilities/attachmentFormat.test.js`.
 */

import {
  sanitizeContentType,
  hasBase64Content,
  isUnsupportedAttachmentFormat
} from './attachmentFormat.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

console.log('🧪 sanitizeContentType\n');
{
  check(
    'strips trailing name= parameter',
    sanitizeContentType('image/jpeg; name="foo.jpg"') === 'image/jpeg'
  );
  check('lowercases', sanitizeContentType('Application/PDF') === 'application/pdf');
  check('null → empty string', sanitizeContentType(null) === '');
  check('non-string → empty string', sanitizeContentType(42) === '');
}

console.log('\n🧪 hasBase64Content — PDF / Word attachments (issue #1451)\n');
{
  const pdf = { content: { format: 'base64', content: 'JVBERi0xLjQK' } };
  check('base64 PDF content is usable', hasBase64Content(pdf) === true);

  const docx = { content: { format: 'Base64', content: 'UEsDBBQABgAI' } };
  check('format is case-insensitive', hasBase64Content(docx) === true);

  const missingContent = { content: { format: 'base64', content: '' } };
  check('empty content string is not usable', hasBase64Content(missingContent) === false);

  const noContent = { name: 'invoice.pdf' };
  check('attachment with no content field is not usable', hasBase64Content(noContent) === false);
}

console.log('\n🧪 hasBase64Content — attached .eml / invite / cloud-link attachments\n');
{
  const eml = { content: { format: 'eml', content: 'RnJvbTogYUBiLmNvbQ==' } };
  check('eml-format content is NOT base64-usable', hasBase64Content(eml) === false);

  const invite = { content: { format: 'icalendar', content: 'QkVHSU46VkNBTEVOREFS' } };
  check('icalendar-format content is NOT base64-usable', hasBase64Content(invite) === false);

  const cloudLink = { content: { format: 'url', content: 'https://contoso.sharepoint.com/x' } };
  check(
    'url-format (cloud share link) content is NOT base64-usable — was previously fed to atob()',
    hasBase64Content(cloudLink) === false
  );
}

console.log('\n🧪 isUnsupportedAttachmentFormat\n');
{
  const pdf = { content: { format: 'base64', content: 'JVBERi0xLjQK' } };
  check('a normal PDF is not "unsupported"', isUnsupportedAttachmentFormat(pdf) === false);

  const eml = { name: 'Fwd: Q3 report.eml', content: { format: 'eml', content: 'RnJvbTo=' } };
  check(
    'a forwarded .eml attachment IS flagged unsupported (not silently "attached")',
    isUnsupportedAttachmentFormat(eml) === true
  );

  const invite = { content: { format: 'icalendar', content: 'QkVHSU4=' } };
  check(
    'an .ics invite attachment is flagged unsupported',
    isUnsupportedAttachmentFormat(invite) === true
  );

  const cloudLink = { content: { format: 'url', content: 'https://contoso.sharepoint.com/x' } };
  check(
    'a OneDrive/SharePoint link attachment is flagged unsupported',
    isUnsupportedAttachmentFormat(cloudLink) === true
  );

  const failed = {
    error: 'Attachment too large to include automatically.',
    content: { format: 'eml', content: 'RnJvbTo=' }
  };
  check(
    'a fetch failure (.error set) is reported as failed, not unsupported',
    isUnsupportedAttachmentFormat(failed) === false
  );

  const pending = { name: 'invoice.pdf' };
  check(
    'an attachment with no content yet is not "unsupported"',
    isUnsupportedAttachmentFormat(pending) === false
  );
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
