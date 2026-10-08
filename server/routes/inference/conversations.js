/**
 * `/api/inference/v1/conversations` — the OpenAI Conversations API on iHub
 * chats.
 *
 *   POST   /conversations                     create (optionally with items, metadata)
 *   GET    /conversations/{id}                read
 *   POST   /conversations/{id}                update metadata
 *   DELETE /conversations/{id}                delete the chat (and its runs)
 *   GET    /conversations/{id}/items          list items (limit, order, after)
 *   POST   /conversations/{id}/items          add items
 *   GET    /conversations/{id}/items/{item}   read one item
 *   DELETE /conversations/{id}/items/{item}   remove one item
 *
 * A conversation is a chat owned by the caller, in the caller's chat history.
 * Responses run in it through `POST /responses` with `conversation`; see
 * services/inference/conversations.js for the binding rules.
 *
 * @module routes/inference/conversations
 */
import crypto from 'node:crypto';
import { buildServerPath } from '../../utils/basePath.js';
import runLog from '../../services/loop/RunLog.js';
import { abortChatRequest } from '../../sse.js';
import { cancelChatWorkflow } from '../../tools/workflowRunner.js';
import { getWorkflowStateRepository } from '../../services/workflow/WorkflowStateRepository.js';
import { deleteChatWithCascade } from '../../services/chat/chatDeletion.js';
import { deriveChatTitle } from '../../services/chat/ChatRepository.js';
import { StorageError, storageHttpStatus } from '../../storage/errors.js';
import { InferenceApiError, sendOpenAiError } from '../../services/inference/errors.js';
import {
  apiOrigin,
  conversationObject,
  itemFromMessage,
  loadConversation,
  messagesFromItems,
  ownerOf,
  requireConversations,
  validateMetadata
} from '../../services/inference/conversations.js';
import { apiUser } from './shared.js';

const COMPONENT = 'ConversationsApi';

/** Page size of an item listing: OpenAI's default and cap. */
const DEFAULT_ITEM_LIMIT = 20;
const MAX_ITEM_LIMIT = 100;

/** A storage failure as an API error; everything else passes through. */
function storageFailure(error) {
  if (error instanceof StorageError) {
    const status = storageHttpStatus(error) || 500;
    return new InferenceApiError(
      status,
      String(error.code || 'storage_error').toLowerCase(),
      error.message
    );
  }
  return error;
}

function send(res, error) {
  return sendOpenAiError(res, storageFailure(error), COMPONENT);
}

/** Append text messages to a chat, in order. */
async function appendItems(repository, chatId, messages) {
  const stored = [];
  for (const message of messages) {
    const appended = await repository.appendMessage(chatId, {
      role: message.role,
      content: message.content
    });
    if (appended?.message) stored.push(appended.message);
  }
  return stored;
}

/** An item listing in OpenAI's list shape. */
function itemList(items, hasMore = false) {
  return {
    object: 'list',
    data: items,
    first_id: items[0]?.id ?? null,
    last_id: items[items.length - 1]?.id ?? null,
    has_more: hasMore
  };
}

export default function registerConversationsRoutes(app) {
  const base = buildServerPath('/api/inference/v1/conversations');

  /**
   * @swagger
   * /inference/v1/conversations:
   *   post:
   *     summary: Create a conversation (OpenAI Conversations API)
   *     description: |
   *       Creates an iHub chat owned by the caller; it appears in the caller's chat history.
   *       It is bound to an app by the first response run in it. Needs chat persistence.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               items:
   *                 type: array
   *                 description: Up to 20 text message items (user / assistant) to start with
   *               metadata:
   *                 type: object
   *                 additionalProperties:
   *                   type: string
   *     responses:
   *       200:
   *         description: The conversation (`{ id, object, created_at, metadata }`)
   *       401:
   *         description: Authentication required
   *       503:
   *         description: Chat persistence is off
   */
  app.post(base, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const metadata = validateMetadata(req.body?.metadata);
      const messages = messagesFromItems(req.body?.items);
      const owner = await ownerOf(user);
      const chatId = crypto.randomUUID();
      const firstUser = messages.find(message => message.role === 'user');
      const chat = await repository.ensureChat({
        chatId,
        ownerId: owner.id,
        identityMode: owner.mode,
        title: deriveChatTitle(firstUser?.content || ''),
        origin: apiOrigin(user),
        metadata: metadata || {}
      });
      if (!chat)
        throw new InferenceApiError(
          503,
          'conversations_unavailable',
          'Could not store the conversation'
        );
      await appendItems(repository, chatId, messages);
      res.json(conversationObject((await repository.getChat(chatId)) || chat));
    } catch (error) {
      send(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/conversations/{conversationId}:
   *   get:
   *     summary: Retrieve a conversation
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The conversation
   *       404:
   *         description: Not found (or not the caller's)
   *   post:
   *     summary: Update a conversation's metadata
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [metadata]
   *             properties:
   *               metadata:
   *                 type: object
   *                 additionalProperties:
   *                   type: string
   *     responses:
   *       200:
   *         description: The updated conversation
   *   delete:
   *     summary: Delete a conversation
   *     description: Deletes the chat, its transcript and its runs.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: "`{ id, object: 'conversation.deleted', deleted: true }`"
   */
  app.get(`${base}/:conversationId`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'read');
      res.json(conversationObject(chat));
    } catch (error) {
      send(res, error);
    }
  });

  app.post(`${base}/:conversationId`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'write');
      const metadata = validateMetadata(req.body?.metadata);
      if (metadata === null) {
        throw new InferenceApiError(400, 'missing_metadata', 'metadata is required', {
          param: 'metadata'
        });
      }
      const updated = await repository.updateChat(chat.id, { metadata });
      res.json(conversationObject(updated || { ...chat, metadata }));
    } catch (error) {
      send(res, error);
    }
  });

  app.delete(`${base}/:conversationId`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'write');
      // Stop a response still running in it before erasing what records it
      // (the same order `DELETE /api/chats/:id` keeps).
      if (chat.status === 'running' || chat.activeRunId) {
        abortChatRequest(chat.id);
        await cancelChatWorkflow(chat.id);
      }
      await deleteChatWithCascade(repository, chat.id, {
        deleteRun: runId => runLog.deleteRun(runId),
        removeWorkflowState: runId => getWorkflowStateRepository().remove(runId),
        component: COMPONENT
      });
      res.json({ id: chat.id, object: 'conversation.deleted', deleted: true });
    } catch (error) {
      send(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/conversations/{conversationId}/items:
   *   get:
   *     summary: List conversation items
   *     description: |
   *       The chat's messages as items. A user item holds the raw input (the variables it was
   *       rendered with in `metadata.variables`); an assistant item holds the answer, with the
   *       validated structured output as `parsed` and the model that produced it in
   *       `metadata.model`.
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 20
   *       - in: query
   *         name: order
   *         schema:
   *           type: string
   *           enum: [asc, desc]
   *           default: desc
   *       - in: query
   *         name: after
   *         schema:
   *           type: string
   *         description: Item id to list after
   *     responses:
   *       200:
   *         description: "`{ object: 'list', data, first_id, last_id, has_more }`"
   *   post:
   *     summary: Add items to a conversation
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [items]
   *             properties:
   *               items:
   *                 type: array
   *                 description: Up to 20 text message items (user / assistant)
   *     responses:
   *       200:
   *         description: The added items
   */
  app.get(`${base}/:conversationId/items`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'read');
      const limitRaw = req.query.limit === undefined ? DEFAULT_ITEM_LIMIT : Number(req.query.limit);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_ITEM_LIMIT) {
        throw new InferenceApiError(
          400,
          'invalid_parameter',
          `limit must be an integer 1-${MAX_ITEM_LIMIT}`,
          {
            param: 'limit'
          }
        );
      }
      const order = req.query.order === undefined ? 'desc' : req.query.order;
      if (order !== 'asc' && order !== 'desc') {
        throw new InferenceApiError(400, 'invalid_parameter', 'order must be asc or desc', {
          param: 'order'
        });
      }
      const { messages } = await repository.getMessages(chat.id);
      let ordered = order === 'asc' ? messages : [...messages].reverse();
      if (typeof req.query.after === 'string' && req.query.after) {
        const at = ordered.findIndex(message => message.id === req.query.after);
        if (at === -1) {
          throw new InferenceApiError(404, 'item_not_found', `Item not found: ${req.query.after}`, {
            param: 'after'
          });
        }
        ordered = ordered.slice(at + 1);
      }
      const page = ordered.slice(0, limitRaw);
      res.json(
        itemList(
          page.map(message => itemFromMessage(message)),
          ordered.length > page.length
        )
      );
    } catch (error) {
      send(res, error);
    }
  });

  app.post(`${base}/:conversationId/items`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'write');
      if (!Array.isArray(req.body?.items) || req.body.items.length === 0) {
        throw new InferenceApiError(400, 'missing_items', 'items must be a non-empty array', {
          param: 'items'
        });
      }
      const messages = messagesFromItems(req.body.items);
      const stored = await appendItems(repository, chat.id, messages);
      res.json(itemList(stored.map(message => itemFromMessage(message))));
    } catch (error) {
      send(res, error);
    }
  });

  /**
   * @swagger
   * /inference/v1/conversations/{conversationId}/items/{itemId}:
   *   get:
   *     summary: Retrieve a conversation item
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: itemId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The item
   *   delete:
   *     summary: Delete a conversation item
   *     tags:
   *       - OpenAI Compatible
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: conversationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: itemId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The conversation
   */
  app.get(`${base}/:conversationId/items/:itemId`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'read');
      const { messages } = await repository.getMessages(chat.id);
      const message = messages.find(entry => entry.id === req.params.itemId);
      if (!message) {
        throw new InferenceApiError(404, 'item_not_found', `Item not found: ${req.params.itemId}`);
      }
      res.json(itemFromMessage(message));
    } catch (error) {
      send(res, error);
    }
  });

  app.delete(`${base}/:conversationId/items/:itemId`, async (req, res) => {
    try {
      const user = apiUser(req);
      const repository = requireConversations(user);
      const chat = await loadConversation(repository, req.params.conversationId, user, 'write');
      const { deleted, chat: updated } = await repository.deleteMessage(chat.id, req.params.itemId);
      if (!deleted) {
        throw new InferenceApiError(404, 'item_not_found', `Item not found: ${req.params.itemId}`);
      }
      res.json(conversationObject(updated || chat));
    } catch (error) {
      send(res, error);
    }
  });
}
