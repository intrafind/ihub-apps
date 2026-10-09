/**
 * What deleting a user takes with it.
 *
 * Removing the users.json record is what ends the user's access: every place that
 * accepts a session token asks the record (utils/tokenUser.js), and a personal API
 * key asks for its owner. That is not all there is to the user. Their OAuth
 * connections, API keys, the credentials they stored for other systems, their
 * scheduled tasks and the content they created are all filed under their id, and
 * nothing else would ever remove them. Left behind they are personal data with
 * nobody to answer for it, and for a user who signs in through an identity
 * provider the next sign-in creates a *new* account, so the old data is never
 * reached again.
 *
 * Everything the user owned goes. What stays is the record of what happened:
 * the audit log and the usage analytics, which are not the user's to take with
 * them and carry no content.
 *
 * The steps come in two kinds. `access` is what lets something act as the user or
 * on their behalf (API keys, connections, stored credentials, scheduled tasks):
 * it always goes. `content` is what the user made (chats, prompts, skills, short
 * links): it goes too for now, and is the part an admin should be able to keep
 * and hand to another user instead. That choice is not built yet; the kind is
 * what it will select on.
 *
 * The cleanup is not part of the delete request. The record is already gone when
 * it starts, which is what ended the access, so nothing here is time-critical
 * and a user with a lot of chats should not make the admin wait for them. Each
 * step is one store and is independent of the others: one failing is recorded
 * and the rest still run. Steps are idempotent.
 *
 * @module services/userDeletion
 */
import { revokeConnectionsForUser } from './oauth/ConnectionService.js';
import { deletePersonalClientsByOwner } from '../utils/oauthClientManager.js';
import { tokenStorageIdFor } from './mcp/mcpUserTokens.js';
import tokenStorageService from './TokenStorageService.js';
import { oauthClientsFile } from '../utils/contentsPath.js';
import logger from '../utils/logger.js';

const COMPONENT = 'UserDeletion';

/**
 * Every id a user's runs, chats and tasks can be filed under. The ledger resolves
 * a principal in the installation's identity mode, and the mode can change, so a
 * user can own things under their id and under its pseudonym.
 *
 * @param {string} userId - The user's id
 * @returns {Promise<string[]>}
 */
async function ownerIdsOf(userId) {
  const { resolvePrincipal } = await import('./loop/runIdentity.js');
  const pseudonym = (await resolvePrincipal({ id: userId }, { mode: 'pseudonymized' })).id;
  return [...new Set([userId, pseudonym])];
}

/** Delete one user-owned entity of a repository's `listOwned`/`delete` pair. */
async function deleteOwned(repository, userId) {
  let removed = 0;
  for (const entity of await repository.listOwned(userId)) {
    if (await repository.delete(entity.id)) removed += 1;
  }
  return removed;
}

/**
 * The steps, in the order they run. A step gets the user id and the platform
 * configuration and answers with what it removed.
 *
 * @type {Array<{name: string, kind: 'access'|'content', run: (userId: string, platform: Object) => Promise<Object>}>}
 */
export const USER_CLEANUP_STEPS = [
  {
    // A personal key is its client record, so the key dies with the record.
    name: 'personalApiKeys',
    kind: 'access',
    run: async (userId, platform) => {
      const removed = await deletePersonalClientsByOwner(
        oauthClientsFile(platform?.oauth),
        userId,
        'user-deletion'
      );
      return { removed: removed.length };
    }
  },
  {
    name: 'oauthConnections',
    kind: 'access',
    run: userId => revokeConnectionsForUser(userId)
  },
  {
    name: 'integrationTokens',
    kind: 'access',
    run: async userId => ({
      removed: await tokenStorageService.deleteAllTokensForStorageIds([
        userId,
        tokenStorageIdFor(userId)
      ])
    })
  },
  {
    // The pool holds the user's tokens in memory; only this worker's is reached.
    name: 'mcpConnections',
    kind: 'access',
    run: async userId => {
      const { default: mcpClientManager } = await import('./mcp/McpClientManager.js');
      return { closed: await mcpClientManager.evictAllUserConnections(userId) };
    }
  },
  {
    // A task is a standing instruction to act as its owner: it goes before the
    // chats, so a run cannot start a chat after they were deleted.
    name: 'scheduledTasks',
    kind: 'access',
    run: async userId => {
      const { deleteTasksOfOwner } = await import('./scheduler/tasks/taskService.js');
      return deleteTasksOfOwner(await ownerIdsOf(userId));
    }
  },
  {
    name: 'chats',
    kind: 'content',
    run: async userId => {
      const [{ getChatRepository }, { deleteChatsOfOwner }, { default: runLog }] =
        await Promise.all([
          import('./chat/ChatRepository.js'),
          import('./chat/chatDeletion.js'),
          import('./loop/RunLog.js')
        ]);
      const { getWorkflowStateRepository } = await import('./workflow/WorkflowStateRepository.js');
      const { abortChatRequest } = await import('../sse.js');
      const { cancelChatWorkflow } = await import('../tools/workflowRunner.js');

      const repository = getChatRepository();
      let removed = 0;
      for (const ownerId of await ownerIdsOf(userId)) {
        removed += await deleteChatsOfOwner(repository, ownerId, {
          deleteRun: runId => runLog.deleteRun(runId),
          removeWorkflowState: runId => getWorkflowStateRepository().remove(runId),
          stopChat: async chat => {
            abortChatRequest(chat.id);
            await cancelChatWorkflow(chat.id);
          },
          component: COMPONENT
        });
      }
      return { removed };
    }
  },
  {
    name: 'userPrompts',
    kind: 'content',
    run: async userId => {
      const { getUserPromptRepository } = await import('./prompts/UserPromptRepository.js');
      const repository = getUserPromptRepository();
      const removed = await deleteOwned(repository, userId);
      await repository.deletePreferences(userId);
      return { removed };
    }
  },
  {
    name: 'userSkills',
    kind: 'content',
    run: async userId => {
      const { getUserSkillRepository } = await import('./skills/UserSkillRepository.js');
      return { removed: await deleteOwned(getUserSkillRepository(), userId) };
    }
  },
  {
    name: 'shortLinks',
    kind: 'content',
    run: async userId => {
      const { searchLinks, deleteLink } = await import('../shortLinkManager.js');
      let removed = 0;
      for (const link of await searchLinks({ ownerId: userId })) {
        if (await deleteLink(link.code)) removed += 1;
      }
      return { removed };
    }
  }
];

/**
 * Remove what belongs to a user who has just been deleted.
 *
 * Never throws: it runs after the response, with nobody to report to. What it
 * could not do is in the log, and in the returned `failed` list.
 *
 * @param {Object} params
 * @param {string} params.userId - The deleted user's id
 * @param {Object} params.platform - Platform configuration
 * @param {Array} [params.steps] - The steps to run; the full set by default
 * @returns {Promise<{results: Object, failed: string[]}>} What each step removed,
 *   and the names of the steps that failed
 */
export async function cleanUpDeletedUser({ userId, platform, steps = USER_CLEANUP_STEPS }) {
  const results = {};
  const failed = [];

  for (const step of steps) {
    try {
      results[step.name] = await step.run(userId, platform);
    } catch (error) {
      failed.push(step.name);
      logger.error('User cleanup step failed', { component: COMPONENT, step: step.name, error });
    }
  }

  const summary = { component: COMPONENT, results, failed };
  if (failed.length > 0) logger.warn('Cleaned up after a deleted user, with failures', summary);
  else logger.info('Cleaned up after a deleted user', summary);
  return { results, failed };
}

/**
 * Cleanups still running, so a shutdown or a test can wait for them.
 *
 * @type {Set<Promise<unknown>>}
 */
const running = new Set();

/**
 * Start the cleanup in the background and return at once.
 *
 * @param {Object} params - As {@link cleanUpDeletedUser}
 * @param {(outcome: {results: Object, failed: string[]}) => void} [params.onDone] -
 *   Called when it finishes, for the caller to record the outcome
 * @returns {Promise<void>} Settles when the cleanup has finished; callers need not await it
 */
export function startUserCleanup({ onDone, ...params }) {
  const task = cleanUpDeletedUser(params)
    .then(outcome => onDone?.(outcome))
    .catch(error => {
      logger.error('User cleanup failed', { component: COMPONENT, error });
    })
    .finally(() => running.delete(task));
  running.add(task);
  return task;
}

/**
 * Wait for every cleanup that is running.
 *
 * @returns {Promise<void>}
 */
export async function waitForUserCleanups() {
  await Promise.all([...running]);
}
