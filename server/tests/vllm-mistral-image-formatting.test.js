/**
 * Unit tests for the vLLM + Mistral adapters' image-message formatting.
 *
 * Issue #1467 reported that Outlook image attachments silently failed on
 * vLLM. Root cause: both adapters previously read `message.imageData.base64`
 * as if `imageData` were always a single object, but the chat client
 * (Office adapter + the main app's image uploader) ships `imageData` as an
 * array. So `Array.base64` resolved to `undefined`, and the resulting
 * `image_url.url` was effectively `data:undefined;base64,undefined` —
 * which every vision model rejects.
 *
 * These tests pin the fixed behaviour: array shape supported, raw base64
 * wrapped in a `data:<mime>;base64,…` URL, content-type honoured.
 */

import assert from 'assert';
import VLLMAdapter from '../adapters/vllm.js';
import MistralAdapter from '../adapters/mistral.js';
import logger from '../utils/logger.js';

function runImageFormattingTests(adapter, label) {
  // 1. Array shape: the path the Outlook attachment fix now exercises.
  {
    const messages = [
      {
        role: 'user',
        content: 'What do you see?',
        imageData: [
          {
            base64: 'AAAA',
            fileType: 'image/jpeg',
            fileName: 'photo.jpg'
          }
        ]
      }
    ];

    const formatted = adapter.formatMessages(messages);
    assert.strictEqual(formatted.length, 1, `${label}: single message in, single message out`);

    const content = formatted[0].content;
    assert.ok(Array.isArray(content), `${label}: multipart content is an array`);
    assert.deepStrictEqual(
      content[0],
      { type: 'text', text: 'What do you see?' },
      `${label}: text part preserved`
    );
    assert.strictEqual(content[1].type, 'image_url', `${label}: image part has type image_url`);
    assert.strictEqual(
      content[1].image_url.url,
      'data:image/jpeg;base64,AAAA',
      `${label}: array shape wraps base64 in a data URL with the correct MIME`
    );
    assert.strictEqual(content[1].image_url.detail, 'high', `${label}: detail flag preserved`);
  }

  // 2. Multiple images in one array → multiple image_url parts.
  {
    const messages = [
      {
        role: 'user',
        content: 'Compare these',
        imageData: [
          { base64: 'AAAA', fileType: 'image/jpeg', fileName: 'a.jpg' },
          { base64: 'BBBB', fileType: 'image/png', fileName: 'b.png' }
        ]
      }
    ];

    const formatted = adapter.formatMessages(messages);
    const content = formatted[0].content;
    assert.strictEqual(content.length, 3, `${label}: 1 text + 2 image parts`);
    assert.strictEqual(content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
    assert.strictEqual(content[2].image_url.url, 'data:image/png;base64,BBBB');
  }

  // 3. Skip malformed entries (no base64) in the array.
  {
    const messages = [
      {
        role: 'user',
        content: 'Skip the empty one',
        imageData: [
          { base64: 'AAAA', fileType: 'image/jpeg' },
          { base64: null, fileType: 'image/jpeg' }, // dropped
          {} // dropped
        ]
      }
    ];

    const formatted = adapter.formatMessages(messages);
    const imageParts = formatted[0].content.filter(p => p.type === 'image_url');
    assert.strictEqual(imageParts.length, 1, `${label}: malformed images skipped`);
  }

  // 4. Legacy single-object shape (kept for backwards compat).
  {
    const messages = [
      {
        role: 'user',
        content: 'Legacy shape',
        imageData: { base64: 'AAAA', fileType: 'image/png' }
      }
    ];

    const formatted = adapter.formatMessages(messages);
    const content = formatted[0].content;
    assert.strictEqual(
      content[1].image_url.url,
      'data:image/png;base64,AAAA',
      `${label}: single-object shape still wrapped as data URL`
    );
  }

  // 5. Strip existing data-URL prefix on the base64 string (Office attachments
  // are raw base64, but the main app's uploader sends `data:image/jpeg;base64,…`
  // already — both shapes should normalize to a single `data:` prefix).
  {
    const messages = [
      {
        role: 'user',
        content: null,
        imageData: [{ base64: 'data:image/jpeg;base64,AAAA', fileType: 'image/jpeg' }]
      }
    ];

    const formatted = adapter.formatMessages(messages);
    assert.strictEqual(
      formatted[0].content[0].image_url.url,
      'data:image/jpeg;base64,AAAA',
      `${label}: existing data-URL prefix stripped before re-wrapping`
    );
  }

  // 6. No imageData → plain content passes through unchanged.
  {
    const messages = [{ role: 'user', content: 'plain text' }];
    const formatted = adapter.formatMessages(messages);
    assert.strictEqual(formatted[0].content, 'plain text', `${label}: non-image content unchanged`);
  }

  logger.info(`${label} image-formatting tests passed`);
}

runImageFormattingTests(VLLMAdapter, 'vLLM adapter');
runImageFormattingTests(MistralAdapter, 'Mistral adapter');
