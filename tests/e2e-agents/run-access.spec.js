// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { chatTurn, counter, signedIn, stub } from './helpers.mjs';
import { ADMIN, APPROVAL_APP, MODELS, OTHER, USER } from '../config/agents-scenario.mjs';

/**
 * Run access by intent (#3785, #3191), against the running server: a message
 * into a running answer and the answer to an approval are the owner's alone.
 * An admin reads the run and can stop it, and nothing more.
 *
 * No page is opened: the rule is the API's, and the composer that sends such a
 * message comes later.
 */

/** `POST /api/runs/{runId}/human-events`, answering `{ status, body }`. */
async function humanEvent(api, runId, event) {
  const res = await api.post(`/api/runs/${runId}/human-events`, { data: event });
  return { status: res.status(), body: await res.json(), type: res.headers()['content-type'] };
}

test.describe('Run access by intent', () => {
  test.afterEach(async () => {
    // A failed test must not leave a model call waiting for the next one.
    await stub.releaseAll();
  });

  test(
    'only the owner sends a message into a running answer; an admin reads and stops it',
    { tag: '@gate' },
    async () => {
      const user = await signedIn(USER);
      const other = await signedIn(OTHER);
      const admin = await signedIn(ADMIN);
      const key = `a1-${crypto.randomUUID().slice(0, 8)}`;
      const chatId = `e2e-${crypto.randomUUID()}`;

      // The model does not answer until the hang is released: the turn is running.
      const turn = chatTurn(user, 'chat', `e2e-hang:${key}`, { chatId, modelId: MODELS.default });
      let runId = null;
      await expect
        .poll(
          async () => {
            const chat = await user.get(`/api/chats/${chatId}`);
            runId = chat.ok() ? (await chat.json()).chat?.activeRunId || null : null;
            return runId;
          },
          { message: 'the chat names the run that is writing its answer', timeout: 20_000 }
        )
        .toBeTruthy();

      const steer = { kind: 'steer', message: 'Use the newer report' };
      for (const [who, api] of [
        ['the admin', admin],
        ['another user', other]
      ]) {
        const refused = await humanEvent(api, runId, steer);
        expect(refused.status, who).toBe(403);
        expect(refused.body.code, who).toBe('RUN_STEER_FORBIDDEN');
        expect(refused.type, who).toMatch(/^application\/problem\+json/);
      }
      // The admin still reads the run; the other user does not even that.
      expect((await admin.get(`/api/runs/${runId}`)).status()).toBe(200);
      expect((await other.get(`/api/runs/${runId}`)).status()).toBe(403);

      const accepted = await humanEvent(user, runId, steer);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.runId).toBe(runId);

      // Only the owner's message is on the run.
      const events = await (await user.get(`/api/runs/${runId}/events`)).json();
      const messages = events.items.filter(event => event.type === 'human/event');
      expect(messages.map(event => event.data.message)).toEqual([steer.message]);

      await stub.release(key);
      const done = await turn;
      expect(done.status, done.text).toBe(200);

      // A stop is what an admin may send; this run has ended, so it only records.
      const stopped = await humanEvent(admin, runId, { kind: 'stop' });
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      const audit = await admin.get(
        `/api/admin/audit-log?resource=run&resourceId=${encodeURIComponent(runId)}`
      );
      expect(audit.status()).toBe(200);
      const entries = (await audit.json()).items.filter(entry => entry.resourceId === runId);
      // The entry says that nothing was stopped: the audit log shows no
      // intervention that did not happen.
      expect(entries.map(entry => entry.summary)).toEqual([
        'Admin sent a stop to a run that is not their own; nothing was running'
      ]);
      expect(entries[0].details.stoppedSomething).toBe(false);
    }
  );

  test(
    'an admin does not answer another user’s pending approval, and a message does not either',
    { tag: '@gate' },
    async () => {
      const user = await signedIn(USER);
      const admin = await signedIn(ADMIN);
      const key = `approval-${crypto.randomUUID().slice(0, 8)}`;

      // The app asks before every tool call: the turn ends on a pending approval.
      const turn = await chatTurn(
        user,
        APPROVAL_APP,
        `e2e-tool:e2e_counter_write:{"key":"${key}","value":"approved by nobody"}`,
        { modelId: MODELS.tools, extra: { toolApprovalCapable: true } }
      );
      expect(turn.status, turn.text).toBe(200);
      const raised = turn.frames.find(frame => frame.type === 'interaction/raised');
      expect(raised, turn.text).toBeTruthy();
      const interaction = raised.data.interaction || raised.data;
      expect(interaction.kind).toBe('approval');
      const answerUrl = `/api/runs/${interaction.runId}/interactions/${interaction.id}/answer`;

      const byAdmin = await admin.post(answerUrl, { data: { decision: 'approve' } });
      expect(byAdmin.status()).toBe(403);
      expect((await byAdmin.json()).code).toBe('FORBIDDEN');

      // A message is not an answer: the approval stays pending.
      const message = await humanEvent(user, interaction.runId, {
        kind: 'steer',
        message: 'I approve'
      });
      expect(message.status, JSON.stringify(message.body)).toBe(409);
      expect(message.body.code).toBe('RUN_NOT_ACTIVE');

      // The owner gets past the access check: a chat approval is answered in its chat.
      const byOwner = await user.post(answerUrl, { data: { decision: 'approve' } });
      expect(byOwner.status()).toBe(409);
      expect((await byOwner.json()).code).toBe('ANSWER_IN_CHAT');

      const pending = await (await user.get(`/api/runs/${interaction.runId}/interactions`)).json();
      expect(pending.items.map(item => item.id)).toEqual([interaction.id]);
      // Nothing was written: nobody approved the call.
      expect((await counter.read()).counters[key]).toBeUndefined();
    }
  );
});
