/**
 * App API (`/api/v1`): call an iHub app from outside, OpenAI-style.
 *
 *   POST /api/v1/apps/{appId}/chat/completions  run the app's full pipeline
 *                                               (prompt, variables, sources,
 *                                               tools, skills) on a message,
 *                                               streamed or not
 *   POST /api/v1/attachments                    upload a file, reference it
 *                                               on a user message
 *
 * The inference API (`/api/inference/v1`) reaches raw models; this surface
 * reaches apps, so the request has no `model` requirement (the app's model
 * applies, `model` overrides it) and the answer is what the app would have
 * said in the chat, tools executed server-side. Authentication is the same
 * as everywhere else on the API: a personal API key or an OAuth token as a
 * bearer, and the caller's groups decide which apps it may call.
 *
 * Requests run through `ChatService.runTurn` — the same code path as the chat
 * UI — with an injected stream emitter that turns the run's frames into
 * OpenAI chat-completion chunks, so persistence (`chat_id`), attachments,
 * tools and telemetry behave exactly as in the browser.
 *
 * @module routes/appApi
 */
import crypto from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import validate from '../validators/validate.js';
import logger from '../utils/logger.js';
import activityTracker from '../telemetry/ActivityTracker.js';
import { recordAppUsage } from '../telemetry/metrics.js';
import defaultChatService from '../services/chat/ChatService.js';
import { RunStreamEmitter } from '../services/loop/RunStream.js';
import runLog, { newRunId } from '../services/loop/RunLog.js';
import { resolvePrincipal, isAnonymousUser } from '../services/loop/runIdentity.js';
import { usageToOpenAI } from '../services/loop/LLMClient.js';
import { SSE_V2_EVENTS } from '../../shared/runEvents.js';
import { authorizeChat } from '../services/chat/chatAccess.js';
import {
  getChatRepository,
  isPersistableChatId,
  normalizeChatSettings
} from '../services/chat/ChatRepository.js';
import { isChatPersistenceActive } from '../services/chat/chatPersistence.js';
import { logInteraction } from '../utils.js';
import { activeRequests } from '../sse.js';
import {
  AttachmentError,
  decodeDataUrl,
  processAttachment,
  resolveMimeType,
  isSupportedMimeType
} from '../services/api/attachmentProcessing.js';
import {
  getApiAttachmentStore,
  isAttachmentId,
  ATTACHMENT_TTL_MS
} from '../services/api/attachmentStore.js';

const COMPONENT = 'AppApi';

/** Largest upload accepted by `POST /api/v1/attachments`. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Attachments one message may reference (ids plus inline parts). */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Expired uploads are swept this often. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() })])
  }),
  z.object({
    type: z.literal('file'),
    file: z.object({
      file_data: z.string().optional(),
      file_id: z.string().optional(),
      filename: z.string().optional()
    })
  })
]);

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z
    .union([z.string(), z.array(contentPartSchema)])
    .nullable()
    .optional(),
  name: z.string().optional(),
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  metadata: z
    .object({ attachments: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional() })
    .passthrough()
    .optional()
});

const completionsBodySchema = z.object({
  messages: z.array(messageSchema).min(1),
  model: z.string().min(1).max(200).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.any()).optional(),
  chat_id: z.string().min(1).max(100).optional(),
  language: z.string().min(2).max(10).optional(),
  user: z.string().optional()
});

const completionsSchema = {
  params: z.object({ appId: z.string().min(1).max(128) }),
  body: completionsBodySchema
};

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sendApiError(res, error) {
  if (error instanceof ApiError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code, ...error.extra });
  }
  if (error instanceof AttachmentError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logger.error('App API request failed', { component: COMPONENT, error: error.message });
  return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
}

/** The acting user with permissions resolved (anonymous when the platform allows it). */
function resolveUser(req) {
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};
  if (req.user && !req.user.permissions) {
    req.user = enhanceUserWithPermissions(req.user, authConfig, platform);
  }
  if (!req.user && isAnonymousAccessAllowed(platform)) {
    req.user = enhanceUserWithPermissions(null, authConfig, platform);
  }
  return req.user || null;
}

function requestLanguage(req, body) {
  return (
    body?.language ||
    req.headers['accept-language']?.split(',')[0] ||
    configCache.getPlatform()?.defaultLanguage ||
    'en'
  );
}

function newCompletionId() {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
}

/** The text of an OpenAI message: a string, or its text parts joined. */
function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/**
 * Resolve the files a user message carries — inline `image_url` / `file`
 * parts and uploaded attachment ids — into the chat's `imageData` /
 * `fileData` lists.
 */
async function resolveMessageFiles(message, { user, store }) {
  const imageData = [];
  const fileData = [];
  let count = 0;
  const take = processed => {
    if (++count > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new ApiError(
        400,
        'TOO_MANY_ATTACHMENTS',
        `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`
      );
    }
    if (processed.kind === 'image') imageData.push(processed.imageData);
    else fileData.push(processed.fileData);
  };

  const parts = Array.isArray(message.content) ? message.content : [];
  let inlineIndex = 0;
  for (const part of parts) {
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const decoded = decodeDataUrl(url);
      if (!decoded) {
        throw new ApiError(
          400,
          'IMAGE_URL_NOT_SUPPORTED',
          'image_url must be a data: URL (remote image URLs are not fetched)'
        );
      }
      inlineIndex += 1;
      const ext = decoded.mimeType.split('/').pop() || 'png';
      take(
        await processAttachment({
          buffer: decoded.buffer,
          mimeType: decoded.mimeType,
          fileName: `image-${inlineIndex}.${ext}`
        })
      );
    } else if (part.type === 'file') {
      if (part.file.file_id) {
        take(await loadAttachment(part.file.file_id, { user, store }));
        continue;
      }
      const decoded = decodeDataUrl(part.file.file_data);
      if (!decoded) {
        throw new ApiError(
          400,
          'FILE_DATA_INVALID',
          'file.file_data must be a data: URL, or pass file.file_id of an uploaded attachment'
        );
      }
      take(
        await processAttachment({
          buffer: decoded.buffer,
          mimeType: decoded.mimeType,
          fileName: part.file.filename || `attachment-${++inlineIndex}`
        })
      );
    }
  }

  const ids = [...(message.attachments || []), ...(message.metadata?.attachments || [])];
  for (const id of ids) {
    take(await loadAttachment(id, { user, store }));
  }
  return { imageData, fileData };
}

async function loadAttachment(id, { user, store }) {
  if (!isAttachmentId(id)) {
    throw new ApiError(400, 'ATTACHMENT_NOT_FOUND', `Unknown attachment id: ${id}`);
  }
  const entry = await store.get(id, user.id);
  if (!entry) {
    // Unknown, expired or somebody else's: the same answer for all three.
    throw new ApiError(
      404,
      'ATTACHMENT_NOT_FOUND',
      `Attachment ${id} was not found or has expired`
    );
  }
  return processAttachment({
    buffer: entry.data,
    mimeType: entry.meta.mimeType,
    fileName: entry.meta.fileName
  });
}

/** `[{type, name, bytes}]` descriptors the chat store keeps for a message. */
function attachmentDescriptors({ imageData, fileData }) {
  return [...fileData, ...imageData].map(entry => ({
    type: entry.fileType || entry.type || 'file',
    ...(entry.fileName ? { name: entry.fileName } : {}),
    ...(Number.isFinite(entry.fileSize) ? { bytes: entry.fileSize } : {})
  }));
}

/** HTTP status for a turn that ended in error, from the chat's error description. */
function errorStatus(errorInfo) {
  const code = String(errorInfo?.code || '');
  if (errorInfo?.isContextWindowError || /CONTEXT_WINDOW|INVALID_REQUEST|MALFORMED/i.test(code))
    return 400;
  if (/ACCESS_DENIED|FORBIDDEN/i.test(code)) return 403;
  if (/NOT_FOUND/i.test(code)) return 404;
  if (/RATE_LIMIT/i.test(code)) return 429;
  if (/TIMEOUT/i.test(code)) return 504;
  return 502;
}

/** OpenAI finish reasons from the loop's. */
function openAiFinishReason(finishReason) {
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'length';
  return 'stop';
}

export default function registerAppApiRoutes(
  app,
  {
    chatService = defaultChatService,
    getLocalizedError = async key => key,
    DEFAULT_TIMEOUT,
    attachmentStore = null
  } = {}
) {
  const base = buildServerPath('/api/v1');
  const store = () => attachmentStore || getApiAttachmentStore();

  app.use(base, authRequired);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 }
  });

  /**
   * @swagger
   * /v1/attachments:
   *   post:
   *     summary: Upload an attachment for the App API
   *     description: |
   *       Upload a file (multipart/form-data, field `file`) to reference from a user message of
   *       `POST /v1/apps/{appId}/chat/completions` via `attachments: ["<id>"]`. PDFs and text
   *       formats are read as documents, images are shown to vision models. Uploads expire after
   *       24 hours and are visible to the uploader only. Maximum size 20 MB.
   *     tags:
   *       - App API
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               file:
   *                 type: string
   *                 format: binary
   *     responses:
   *       201:
   *         description: The stored attachment
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id: { type: string, example: att_3f2c9d1e4b7a4c5e8d1f2a3b4c5d6e7f }
   *                 filename: { type: string }
   *                 mime_type: { type: string }
   *                 size: { type: integer }
   *                 expires_at: { type: string, format: date-time }
   *       400:
   *         description: No file, empty file or unreadable PDF
   *       413:
   *         description: File larger than 20 MB
   *       415:
   *         description: Unsupported file type
   */
  app.post(`${base}/attachments`, (req, res) => {
    upload.single('file')(req, res, async err => {
      try {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            throw new ApiError(
              413,
              'FILE_TOO_LARGE',
              `The file exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`
            );
          }
          throw new ApiError(400, 'INVALID_UPLOAD', err.message || 'Invalid upload');
        }
        const user = resolveUser(req);
        if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
        if (isAnonymousUser(user)) {
          throw new ApiError(401, 'UNAUTHORIZED', 'Uploads need an authenticated caller');
        }
        const file = req.file;
        if (!file || !file.buffer?.length) {
          throw new ApiError(400, 'NO_FILE', "Send the file as multipart/form-data field 'file'");
        }
        const mimeType = resolveMimeType(file.mimetype, file.originalname);
        if (!isSupportedMimeType(mimeType)) {
          throw new AttachmentError(
            'UNSUPPORTED_MEDIA_TYPE',
            `Unsupported file type ${mimeType}: send PDF, plain-text formats (txt, md, csv, json, xml, html, code) or images (png, jpeg, gif, webp)`
          );
        }
        // Processed once now so a broken file is rejected at upload time,
        // not when the message that references it runs.
        await processAttachment({ buffer: file.buffer, mimeType, fileName: file.originalname });
        const meta = await store().put({
          ownerId: user.id,
          fileName: file.originalname || `attachment.${mimeType.split('/').pop()}`,
          mimeType,
          buffer: file.buffer
        });
        logger.info('App API attachment stored', {
          component: COMPONENT,
          id: meta.id,
          userId: user.id,
          mimeType,
          size: meta.size
        });
        return res.status(201).json({
          id: meta.id,
          object: 'attachment',
          filename: meta.fileName,
          mime_type: meta.mimeType,
          size: meta.size,
          created_at: meta.createdAt,
          expires_at: meta.expiresAt
        });
      } catch (error) {
        return sendApiError(res, error);
      }
    });
  });

  /**
   * @swagger
   * /v1/apps/{appId}/chat/completions:
   *   post:
   *     summary: Chat with an iHub app (OpenAI-shaped)
   *     description: |
   *       Runs the app's full pipeline — system prompt, variables, sources, tools and skills —
   *       on the conversation and answers in OpenAI chat-completion shape, streamed
   *       (`stream: true`, Server-Sent Events ending in `[DONE]`) or as one JSON object.
   *
   *       Extensions beyond the OpenAI request: `variables` (app variables for the prompt
   *       template), `chat_id` (store the conversation server-side and continue it later; pass
   *       a new UUID to start one, then post only the new message), `language`, and per-message
   *       `attachments` (ids from `POST /v1/attachments`). `image_url` and `file` content parts
   *       are accepted as data URLs. `system` messages are refused: the app's prompt applies.
   *     tags:
   *       - App API
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [messages]
   *             properties:
   *               messages:
   *                 type: array
   *                 items:
   *                   type: object
   *                   properties:
   *                     role: { type: string, enum: [user, assistant] }
   *                     content: { description: A string or an array of text / image_url / file parts }
   *                     attachments: { type: array, items: { type: string } }
   *               model: { type: string, description: Optional model override }
   *               stream: { type: boolean }
   *               stream_options: { type: object, properties: { include_usage: { type: boolean } } }
   *               temperature: { type: number }
   *               variables: { type: object }
   *               chat_id: { type: string }
   *               language: { type: string }
   *     responses:
   *       200:
   *         description: A chat completion (or an SSE stream of chunks)
   *       400:
   *         description: Invalid request
   *       401:
   *         description: Authentication required
   *       404:
   *         description: App not found or not available to the caller
   */
  app.post(
    `${base}/apps/:appId/chat/completions`,
    validate(completionsSchema),
    async (req, res) => {
      const body = req.body;
      const language = requestLanguage(req, body);
      const clientWantsStream = body.stream === true;
      let chatId = null;
      try {
        const user = resolveUser(req);
        if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');

        const platform = configCache.getPlatform() || {};
        const { data: apps = [] } = await configCache.getAppsForUser(user, platform);
        const appConfig = findByIdCaseInsensitive(apps, req.params.appId);
        if (!appConfig) {
          throw new ApiError(
            404,
            'APP_NOT_FOUND',
            `App not found or not available: ${req.params.appId}`
          );
        }

        if (body.messages.some(m => m.role === 'system')) {
          throw new ApiError(
            400,
            'SYSTEM_MESSAGE_NOT_ALLOWED',
            "The app's own prompt applies; put instructions in the user message or in variables"
          );
        }
        const last = body.messages[body.messages.length - 1];
        if (last.role !== 'user') {
          throw new ApiError(
            400,
            'LAST_MESSAGE_NOT_USER',
            'The last message must be from the user'
          );
        }
        const lastText = messageText(last);
        const files = await resolveMessageFiles(last, { user, store: store() });
        if (!lastText.trim() && files.imageData.length === 0 && files.fileData.length === 0) {
          throw new ApiError(400, 'EMPTY_MESSAGE', 'The user message is empty');
        }

        // --- conversation & persistence ------------------------------------
        const repository = getChatRepository();
        let persistence = null;
        let conversation = body.messages.map(m => ({ role: m.role, content: messageText(m) }));
        const newMessage = {
          role: 'user',
          content: lastText,
          ...(body.variables ? { variables: body.variables } : {}),
          ...(files.imageData.length ? { imageData: files.imageData } : {}),
          ...(files.fileData.length ? { fileData: files.fileData } : {})
        };
        conversation[conversation.length - 1] = newMessage;

        if (body.chat_id) {
          if (!isPersistableChatId(body.chat_id)) {
            throw new ApiError(
              400,
              'INVALID_CHAT_ID',
              'chat_id may contain letters, digits, dots, hyphens and underscores only'
            );
          }
          const active = isChatPersistenceActive({
            features: configCache.getFeatures(),
            platformConfig: platform,
            user,
            ephemeral: false
          });
          if (!active) {
            throw new ApiError(
              400,
              'CHAT_PERSISTENCE_UNAVAILABLE',
              'Stored conversations are not available for this caller: chat persistence is off, or the caller is anonymous'
            );
          }
          const access = await authorizeChat(body.chat_id, user, { repository, intent: 'write' });
          if (!access.ok)
            throw new ApiError(404, 'CHAT_NOT_FOUND', `Chat not found: ${body.chat_id}`);
          if (body.messages.length > 1) {
            throw new ApiError(
              400,
              'CLIENT_HISTORY_NOT_ALLOWED',
              'A stored conversation keeps its own history: post only the new user message',
              {
                hint: 'Send messages as a single-element array, or leave chat_id out and post the whole conversation yourself.'
              }
            );
          }
          if (access.chat && access.chat.appId && access.chat.appId !== appConfig.id) {
            throw new ApiError(
              400,
              'CHAT_APP_MISMATCH',
              `Chat ${body.chat_id} belongs to app ${access.chat.appId}`
            );
          }
          chatId = body.chat_id;
          const stored = await repository.getMessages(chatId);
          const history = stored.messages
            .filter(
              entry => entry?.role && typeof entry.content === 'string' && entry.content.trim()
            )
            .map(entry => ({ role: entry.role, content: entry.content }));
          conversation =
            appConfig.sendChatHistory === false ? [newMessage] : [...history, newMessage];
          const identityMode = runLog.identityMode();
          const principal = await resolvePrincipal(user, { mode: identityMode });
          persistence = {
            repository,
            ownerId: principal.id,
            identityMode: principal.mode || identityMode,
            content: lastText,
            clientMessageId: null,
            attachments: attachmentDescriptors(files),
            settings: normalizeChatSettings({ temperature: body.temperature })
          };
        } else {
          // Not a storable id on purpose: an ephemeral call leaves no chat behind.
          chatId = `api:${crypto.randomUUID()}`;
        }

        const messageId = crypto.randomUUID();
        activityTracker.recordActivity({ userId: user.id, chatId });
        recordAppUsage(appConfig.id, user.id, { 'app.api': 'v1' });

        const prep = await chatService.prepareChatRequest({
          appId: appConfig.id,
          modelId: body.model,
          messages: conversation,
          temperature: body.temperature,
          language,
          user,
          chatId
        });
        if (!prep.success) {
          const message = await getLocalizedError(
            prep.error?.code || 'internalError',
            {},
            language
          );
          const code = prep.error?.code || 'REQUEST_PREPARATION_FAILED';
          const status = /modelAccessDenied|accessDenied/i.test(code)
            ? 403
            : /notFound/i.test(code)
              ? 404
              : 400;
          throw new ApiError(
            status,
            code,
            message || prep.error?.message || 'Request could not be prepared'
          );
        }
        if (body.max_tokens)
          prep.data.maxTokens = Math.min(body.max_tokens, prep.data.maxTokens || body.max_tokens);

        const model = prep.data.model;
        const completionId = newCompletionId();
        const created = Math.floor(Date.now() / 1000);
        const runId = newRunId('chat');
        const buildLogData = (streaming, extra = {}) => ({
          messageId,
          appId: appConfig.id,
          modelId: model?.id,
          sessionId: chatId,
          user,
          messages: prep.data.llmMessages,
          options: { temperature: body.temperature, language, streaming, source: 'app-api' },
          ...extra
        });

        // --- streaming setup ------------------------------------------------
        let clientDisconnected = false;
        let sentRole = false;
        let streamedText = '';
        const chunk = (delta, extra = {}) => ({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: model?.id,
          ...(persistence ? { chat_id: chatId } : {}),
          choices: [{ index: 0, delta, finish_reason: null, ...extra }]
        });
        const write = obj => {
          if (!clientDisconnected && !res.writableEnded)
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        if (clientWantsStream) {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();
        }
        res.on('close', () => {
          if (!res.writableFinished) {
            clientDisconnected = true;
            // runTurn registers the turn's controller under the chat id; aborting
            // it frees the provider call the way a closed browser tab does.
            activeRequests.get(chatId)?.abort();
          }
        });

        const emitter = new RunStreamEmitter({
          streamId: chatId,
          runId,
          deliver: (_streamId, envelope) => {
            if (!clientWantsStream) return;
            if (envelope.type === SSE_V2_EVENTS.STEP_DELTA && envelope.data?.kind === 'text') {
              const text = envelope.data.content;
              if (!text) return;
              streamedText += text;
              write(chunk({ ...(sentRole ? {} : { role: 'assistant' }), content: text }));
              sentRole = true;
            }
          }
        });

        await logInteraction('chat_request', buildLogData(clientWantsStream));
        const outcome = await chatService.runTurn({
          prep: prep.data,
          chatId,
          messageId,
          streaming: true,
          emitter,
          headless: true,
          buildLogData,
          timeoutMs: DEFAULT_TIMEOUT,
          getLocalizedError,
          language,
          user,
          runId,
          persistence
        });

        if (clientDisconnected) return undefined;
        const usage = outcome.usage ? usageToOpenAI(outcome.usage) : undefined;

        // --- errors -----------------------------------------------------------
        if (outcome.status === 'error' || outcome.status === 'aborted') {
          const info = outcome.errorInfo || {
            code: outcome.status === 'aborted' ? 'ABORTED' : 'ERROR',
            message: outcome.error?.message || 'The app did not answer'
          };
          if (clientWantsStream) {
            // Mid-stream failures are reported in-band the way OpenAI does it.
            write({
              error: {
                message: info.message,
                type: 'server_error',
                code: String(info.code || 'ERROR')
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return undefined;
          }
          return res
            .status(errorStatus(info))
            .json({ error: info.message, code: String(info.code || 'ERROR') });
        }

        const content = outcome.content || '';
        const finishReason = openAiFinishReason(outcome.finishReason);

        if (clientWantsStream) {
          // A passthrough (workflow) answer arrives whole, without deltas.
          if (!sentRole) {
            write(chunk({ role: 'assistant', content }));
          } else if (content && content !== streamedText && content.startsWith(streamedText)) {
            write(chunk({ content: content.slice(streamedText.length) }));
          }
          write(chunk({}, { finish_reason: finishReason }));
          if (body.stream_options?.include_usage === true && usage) {
            write({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: model?.id,
              ...(persistence ? { chat_id: chatId } : {}),
              choices: [],
              usage
            });
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return undefined;
        }

        return res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model: model?.id,
          ...(persistence ? { chat_id: chatId } : {}),
          choices: [
            { index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }
          ],
          ...(usage ? { usage } : {})
        });
      } catch (error) {
        if (res.headersSent) {
          if (!res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({ error: { message: error.message, type: 'server_error', code: error.code || 'INTERNAL_ERROR' } })}\n\n`
            );
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return undefined;
        }
        return sendApiError(res, error);
      }
    }
  );

  setInterval(() => {
    store()
      .sweep()
      .catch(() => {});
  }, SWEEP_INTERVAL_MS).unref();

  logger.debug('App API routes registered', {
    component: COMPONENT,
    attachmentTtlMs: ATTACHMENT_TTL_MS
  });
}
