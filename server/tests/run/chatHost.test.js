// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat turn lives in `services/run/hosts/ChatHost.js`; `ChatService.runTurn`
 * hands it over with the service as the host's collaborator.
 *
 * `ChatHost.js` and `ChatService.js` import each other. Each is loaded first in
 * a process of its own, so a name of the cycle read while the modules are
 * evaluated, rather than while a turn runs, fails here. What a turn does is
 * pinned by `chatTurn.test.js` and the goldens.
 *
 * Run: node --test server/tests/run/chatHost.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ChatHost } from '../../services/run/hosts/ChatHost.js';
import ChatService from '../../services/chat/ChatService.js';

const run = promisify(execFile);
const HOST = fileURLToPath(new URL('../../services/run/hosts/ChatHost.js', import.meta.url));
const SERVICE = fileURLToPath(new URL('../../services/chat/ChatService.js', import.meta.url));

/** Load `first` in a fresh process and report what both modules export. */
async function loadFirst(first) {
  const script = [
    `await import(${JSON.stringify(first)});`,
    `const host = await import(${JSON.stringify(HOST)});`,
    `const service = await import(${JSON.stringify(SERVICE)});`,
    'console.log(JSON.stringify([typeof host.ChatHost, typeof service.default]));'
  ].join('\n');
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 60000
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

describe('ChatHost', () => {
  for (const [name, first] of [
    ['ChatService.js', SERVICE],
    ['ChatHost.js', HOST]
  ]) {
    it(`loads when ${name} is imported first`, async () => {
      assert.deepEqual(await loadFirst(first), ['function', 'function']);
    });
  }

  it('keeps the service as its collaborator', () => {
    const service = new ChatService({ runTool: async () => ({}) });
    const host = new ChatHost(service);
    assert.equal(host.svc, service);
    assert.equal(typeof host.runTurn, 'function');
  });

  it('runs the turn of ChatService.runTurn with the same parameters and result', async () => {
    const service = new ChatService({ runTool: async () => ({}) });
    const params = { chatId: 'c1', streaming: false };
    const result = { runId: 'r1', status: 'completed' };
    const seen = [];
    const original = ChatHost.prototype.runTurn;
    ChatHost.prototype.runTurn = async function (given) {
      seen.push({ svc: this.svc, given });
      return result;
    };
    try {
      assert.equal(await service.runTurn(params), result);
    } finally {
      ChatHost.prototype.runTurn = original;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].svc, service);
    assert.equal(seen[0].given, params);
  });
});
