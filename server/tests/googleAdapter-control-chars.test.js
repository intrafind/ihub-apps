// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, expect, test } from '@jest/globals';
import GoogleAdapter from '../adapters/google.js';

const model = {
  modelId: 'gemini-pro',
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
  provider: 'google'
};

async function sentText(content) {
  const req = await GoogleAdapter.createCompletionRequest(
    model,
    [{ role: 'user', content }],
    'key',
    {}
  );
  return req.body.contents.flatMap(c => c.parts.map(p => p.text)).join('');
}

describe('Google adapter text sanitising', () => {
  test('strips null bytes and control characters, keeps tab, newline and carriage return', async () => {
    const text = await sentText('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\tg\nh\ri');
    expect(text).toBe('abcdef\tg\nh\ri');
  });

  test('replaces lone surrogates and keeps valid pairs', async () => {
    const text = await sentText('x\uD800y\uDC00z😀');
    expect(text).toBe('x�y�z😀');
  });

  test('leaves printable text untouched', async () => {
    expect(await sentText('Grüße, 世界!')).toBe('Grüße, 世界!');
  });
});
