// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who answers an approval or a question in its chat (#3785, #3191).
 *
 * A chat tool approval and an `ask_user` question are not answered at
 * `/api/runs/.../answer` (that route sends them back with `ANSWER_IN_CHAT`):
 * the next chat message answers them, or moves past them. Three call sites
 * decide who may do that, and each asks run access with the intent `answer`:
 *
 * - `prepareChatApproval`: the message that carries `approvalResponse`;
 * - `prepareChatApproval`: any other message, which supersedes a pending approval;
 * - `settleChatClarifications`: a `clarificationResponse`, or a message that
 *   skips past a pending question.
 *
 * The cases call these functions with the real access check and the real
 * interaction service, as an admin and as another user who reached the chat.
 * With the intent `cancel` at any of the three sites, which an admin holds,
 * the admin cases below fail.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startRunAccessHarness, USERS } from './helpers/runAccessHarness.js';

let h;
let prepareChatApproval;
let settleChatClarifications;
before(async () => {
  h = await startRunAccessHarness();
  ({ prepareChatApproval } = await import('../services/chat/chatToolApproval.js'));
  ({ settleChatClarifications } = await import('../routes/chat/sessionRoutes.js'));
});
after(async () => {
  await h.stop();
});

/** The source a chat turn records on what it raises for its user. */
function chatSource(run) {
  return {
    chatId: run.chatId,
    appId: 'chat',
    principalId: run.principalId,
    identityMode: 'default'
  };
}

/** A tool approval raised by a chat turn, and the chat document that waits for it. */
async function seedChatApproval() {
  const run = await h.seedUserRun();
  const interaction = await h.interactionService.raise({
    runId: run.runId,
    kind: 'approval',
    origin: 'tool',
    prompt: { title: 'Send the mail?', message: 'Send the mail?', inputType: 'confirm' },
    source: { ...chatSource(run), toolId: 'sendMail' }
  });
  const chat = {
    id: run.chatId,
    toolApproval: { grants: [], pending: { interactionId: interaction.id, runId: run.runId } }
  };
  return { run, interaction, chat };
}

/** A question (`ask_user`) raised by a chat turn. */
async function seedChatQuestion() {
  const run = await h.seedUserRun();
  const interaction = await h.interactionService.raise({
    runId: run.runId,
    kind: 'question',
    origin: 'tool',
    prompt: { message: 'Which report?', inputType: 'text' },
    source: chatSource(run)
  });
  return { run, interaction };
}

/** A chat repository that records what the approval code writes to the chat. */
function recordingRepository() {
  const updates = [];
  return {
    updates,
    async updateChat(chatId, patch) {
      updates.push({ chatId, patch });
    }
  };
}

const statusOf = async interaction => (await h.interactionService.get(interaction.id))?.status;
const notOwners = [USERS.admin, USERS.otherUser];

describe('a chat tool approval: the message that answers it', () => {
  it('refuses an admin and another user with APPROVAL_FORBIDDEN and leaves it pending', async () => {
    for (const user of notOwners) {
      const { run, interaction, chat } = await seedChatApproval();
      const repository = recordingRepository();
      for (const decision of ['approve', 'reject']) {
        const result = await prepareChatApproval({
          chatId: run.chatId,
          user,
          chat,
          lastMessage: { approvalResponse: { interactionId: interaction.id, decision } },
          repository
        });
        assert.deepEqual(
          result.refusal,
          {
            status: 403,
            code: 'APPROVAL_FORBIDDEN',
            message: 'This approval belongs to another user'
          },
          `${user.id} ${decision}`
        );
        assert.equal(result.commit, null, `${user.id}: nothing to commit`);
      }
      assert.equal(await statusOf(interaction), 'pending', `${user.id}: still pending`);
      assert.deepEqual(repository.updates, [], `${user.id}: the chat keeps its pending approval`);
    }
  });

  it('lets the owner answer: the approval is settled when the turn commits', async () => {
    const { run, interaction, chat } = await seedChatApproval();
    const result = await prepareChatApproval({
      chatId: run.chatId,
      user: USERS.owner,
      chat,
      lastMessage: { approvalResponse: { interactionId: interaction.id, decision: 'approve' } },
      repository: recordingRepository()
    });
    assert.equal(result.refusal, null);
    assert.deepEqual(result.pausedTurn, { runId: run.runId, interactionId: interaction.id });
    assert.equal(typeof result.commit, 'function');
    await result.commit();
    assert.equal(await statusOf(interaction), 'answered');
  });
});

describe('a chat tool approval: a message that moves past it', () => {
  it('is not superseded by the message of an admin or of another user', async () => {
    for (const user of notOwners) {
      const { run, interaction, chat } = await seedChatApproval();
      await prepareChatApproval({
        chatId: run.chatId,
        user,
        chat,
        lastMessage: { role: 'user', content: 'Something else' },
        repository: recordingRepository()
      });
      assert.equal(await statusOf(interaction), 'pending', `${user.id}: still pending`);
    }
  });

  it('is superseded by its owner’s next message', async () => {
    const { run, interaction, chat } = await seedChatApproval();
    await prepareChatApproval({
      chatId: run.chatId,
      user: USERS.owner,
      chat,
      lastMessage: { role: 'user', content: 'Something else' },
      repository: recordingRepository()
    });
    assert.equal(await statusOf(interaction), 'cancelled');
  });
});

describe('a question in a chat', () => {
  it('is neither answered nor superseded by an admin or by another user', async () => {
    for (const user of notOwners) {
      const { run, interaction } = await seedChatQuestion();
      const answered = await settleChatClarifications({
        chatId: run.chatId,
        user,
        lastMessage: {
          clarificationResponse: { interactionId: interaction.id, value: 'The newer one' }
        }
      });
      assert.equal(answered, null, `${user.id}: no run continues`);
      assert.equal(await statusOf(interaction), 'pending', `${user.id}: not answered`);

      const skipped = await settleChatClarifications({
        chatId: run.chatId,
        user,
        lastMessage: { role: 'user', content: 'Something else' }
      });
      assert.equal(skipped, null);
      assert.equal(await statusOf(interaction), 'pending', `${user.id}: not superseded`);
    }
  });

  it('is answered by its owner, and the run continues', async () => {
    const { run, interaction } = await seedChatQuestion();
    const answered = await settleChatClarifications({
      chatId: run.chatId,
      user: USERS.owner,
      lastMessage: {
        clarificationResponse: { interactionId: interaction.id, value: 'The newer one' }
      }
    });
    assert.deepEqual(answered, { runId: run.runId, interactionId: interaction.id });
    const stored = await h.interactionService.get(interaction.id);
    assert.equal(stored.status, 'answered');
    assert.equal(stored.answer.value, 'The newer one');
  });

  it('is superseded by its owner’s next message', async () => {
    const { run, interaction } = await seedChatQuestion();
    await settleChatClarifications({
      chatId: run.chatId,
      user: USERS.owner,
      lastMessage: { role: 'user', content: 'Something else' }
    });
    assert.equal(await statusOf(interaction), 'cancelled');
  });
});
