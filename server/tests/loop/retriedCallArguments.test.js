// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `elideRetriedCallArguments`: a failed tool call the model has since sent
 * again is replayed with its long argument values left out, so retries do not
 * fill the context window (intrafind/ihub-apps#3831).
 *
 * Run: node --test server/tests/loop/retriedCallArguments.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { elideRetriedCallArguments } from '../../services/loop/contextCompaction.js';

const BIG = 'x'.repeat(5000);
const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});
const assistant = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const result = (id, content) => ({
  role: 'tool',
  tool_call_id: id,
  content: JSON.stringify(content)
});
const FAILED = { success: false, error: '"sheets" is not valid JSON' };

describe('elideRetriedCallArguments', () => {
  it('shortens a failed call once the same tool is called again', () => {
    const messages = [
      { role: 'user', content: 'make a workbook' },
      assistant(call('a', 'create_xlsx', { filename: 'f.xlsx', sheets: BIG })),
      result('a', FAILED),
      assistant(call('b', 'create_xlsx', { filename: 'f.xlsx', sheets: BIG })),
      result('b', FAILED)
    ];
    const out = elideRetriedCallArguments(messages);
    assert.equal(out.collapsed, 1);
    assert.ok(out.freedChars > 4900);
    const first = JSON.parse(out.messages[1].tool_calls[0].function.arguments);
    assert.deepEqual(first, {
      filename: 'f.xlsx',
      sheets: '[5000 characters left out: this call failed and was sent again]'
    });
    assert.equal(out.messages[3], messages[3], 'the newest attempt is the same object');
    assert.equal(out.messages[2], messages[2], 'the error it got stays');
    assert.equal(
      messages[1].tool_calls[0].function.arguments.length > 5000,
      true,
      'input untouched'
    );
  });

  it('leaves a call alone that worked, was not sent again, or is short', () => {
    const worked = [
      assistant(call('a', 'create_xlsx', { sheets: BIG })),
      result('a', { success: true }),
      assistant(call('b', 'create_xlsx', { sheets: BIG })),
      result('b', { success: true })
    ];
    assert.equal(elideRetriedCallArguments(worked).messages, worked);

    const otherTool = [
      assistant(call('a', 'create_xlsx', { sheets: BIG })),
      result('a', FAILED),
      assistant(call('b', 'read_url', { url: 'u' })),
      result('b', { ok: true })
    ];
    assert.equal(elideRetriedCallArguments(otherTool).messages, otherTool);

    const short = [
      assistant(call('a', 'create_xlsx', { sheets: '[]' })),
      result('a', FAILED),
      assistant(call('b', 'create_xlsx', { sheets: '[1]' })),
      result('b', FAILED)
    ];
    assert.equal(elideRetriedCallArguments(short).messages, short);
  });

  it('is stable: a second pass changes nothing', () => {
    const messages = [
      assistant(call('a', 'create_xlsx', { sheets: BIG })),
      result('a', FAILED),
      assistant(call('b', 'create_xlsx', { sheets: BIG })),
      result('b', FAILED)
    ];
    const once = elideRetriedCallArguments(messages).messages;
    const twice = elideRetriedCallArguments(once);
    assert.equal(twice.collapsed, 0);
    assert.equal(twice.messages, once);
  });

  it('replaces arguments that are not a JSON object with a note', () => {
    const messages = [
      assistant({ id: 'a', type: 'function', function: { name: 't', arguments: `[${BIG}` } }),
      result('a', FAILED),
      assistant(call('b', 't', {})),
      result('b', { ok: true })
    ];
    const out = elideRetriedCallArguments(messages);
    assert.deepEqual(JSON.parse(out.messages[0].tool_calls[0].function.arguments), {
      note: '[5001 characters left out: this call failed and was sent again]'
    });
  });
});
