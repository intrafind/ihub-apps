// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The host of a chat turn: a person's chat, a scheduled run and both `/v1`
 * routes (`/v1/chat/completions`, `/v1/responses`), all through
 * `ChatService.runTurn`.
 *
 * `runTurn` runs one turn on the shared agent loop and projects it onto SSE v2
 * frames via `chatChannel` / `chatSeams` (one run per turn, `run/started` …
 * `run/ended`): it continues or starts the ledger run, stores the question
 * (`settleUserTurn`) and the answer (`materializeAssistantTurn`), schedules the
 * title and keeps a pending approval or connect with the chat. The helpers it
 * needs stay on the `ChatService` it gets as its collaborator (`svc`).
 *
 * @module services/run/hosts/ChatHost
 */

import configCache from '../../../configCache.js';
import {
  abortChatRequest,
  activeRequests,
  hasActiveChatRequest,
  hasChatClient
} from '../../../sse.js';
import { isFailureFinishReason } from '../../../adapters/toolCalling/index.js';
import logger from '../../../utils/logger.js';
import { abortCause, abortReason, causeOfSignal, describeCause } from '../../chat/abortCause.js';
import { addUsage } from '../../loop/llmUsage.js';
import { createContextTracker } from '../../loop/contextTracker.js';
import { newRunId, isValidRunId } from '../../loop/RunLog.js';
import { RunStreamEmitter, bindStreamRun, unbindStreamRun } from '../../loop/RunStream.js';
import { RUN_LOG_EVENTS, SSE_V2_EVENTS } from '../../../../shared/runEvents.js';
import { answerBasisOf, carriedBasis, settleKnowledgeScope } from '../../chat/answerBasis.js';
import { limitReachedIn } from '../../chat/outputLimit.js';
import { recordAnswerOriginMetrics } from '../../chat/answerOriginMetrics.js';
import {
  approvalSeam,
  imageLiftSeam,
  knowledgeSourceSeam,
  markInteractiveTools,
  passthroughSeam,
  questionSeam,
  structuredOutputSeam
} from '../../loop/seams/index.js';
import { createChatChannel } from '../../chat/chatChannel.js';
import { chatSteerSeam, createLeftover } from '../../chat/chatSteering.js';
import { discardRunActivity, recordRunActivity } from '../../chat/runActivity.js';
import { createPageReadGate, resolveMaxPageReads } from '../../chat/pageReadLimit.js';
import { createTurnSkillLog } from '../../chat/turnSkillLog.js';
import {
  admitTurnProjects,
  materializeAssistantTurn,
  normalizeAttachments,
  settleUserTurn
} from '../../chat/chatMaterializer.js';
import {
  chatTurnSeam,
  chatToolSeam,
  chatQuestionOptions,
  chatPassthroughOptions,
  chatApprovalOptions,
  approvalRefusalPayload
} from '../../chat/chatSeams.js';
import { continuationMessages, replaceToolResult } from '../../chat/chatToolApproval.js';
import { connectResumeMessages, loopResumeOf } from '../../chat/chatConnectResume.js';
import { describeChatError } from '../../chat/chatErrors.js';
import { scheduleChatTitle } from '../../chat/chatTitles.js';
import { appendSchedulingContextNote } from '../../scheduler/tasks/schedulingContext.js';
import { recordTextOutput } from '../../provenance/turnProvenance.js';
import {
  COMPONENT,
  CHAT_MAX_TOOL_ROUNDS,
  DURABLE_TURN_WALL_CLOCK_MS,
  chatCompactionModel,
  chatContextPolicies,
  chatToolPolicies,
  wireUsage
} from '../../chat/chatTurnPolicies.js';

const NO_STREAM = { emit: () => null, runId: null };

/**
 * Whether the reader of a durable turn is still there when it ends: the
 * caller's own answer when it supplied one (the inference API knows whether
 * its HTTP client is connected), else an attached SSE client.
 */
function clientConnectedOf(persist, chatId) {
  if (typeof persist?.clientConnected === 'function') {
    try {
      return persist.clientConnected() === true;
    } catch {
      return false;
    }
  }
  return hasChatClient(chatId);
}

/**
 * Whether a chat claimed for `runId` before its turn started is no longer
 * claimed for it, or another turn is in flight on it: the turn then yields
 * (`ChatService.runTurn`, `claimed`). Read right before the turn registers.
 *
 * @param {Object|null|undefined} repository
 * @param {string} chatId
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
async function claimLost(repository, chatId, runId) {
  if (!repository) return false;
  const current = await repository.getChat(chatId).catch(() => null);
  return current?.activeRunId !== runId || hasActiveChatRequest(chatId);
}

/** The host of a chat turn: one host serves one turn of one `ChatService`. */
export class ChatHost {
  /**
   * @param {import('../../chat/ChatService.js').default} svc - the chat service the turn
   *   runs for: its ledger, interaction log, tool runner, loop, telemetry and the
   *   storage of a pending approval or connect stay there
   */
  constructor(svc) {
    this.svc = svc;
  }

  /**
   * Run one chat turn.
   *
   * With `streaming: true` the turn is one run on the chat's SSE v2 stream
   * (`run/started`, `step/delta`, `tool/*`, `interaction/raised`,
   * `run/paused`, `stream/error`, `run/ended`) and the returned summary is
   * informational. With `streaming: false` nothing is emitted and the caller
   * answers the HTTP request from the summary. Interactive tools are headless
   * without a stream (nobody could answer), so `ask_user` gets a
   * `NO_USER_AVAILABLE` result instead of pausing.
   *
   * @param {Object} params
   * @param {Object} params.prep - `prepareChatRequest().data`
   * @param {string} params.chatId
   * @param {string} [params.messageId] - client exchange id of the assistant placeholder
   * @param {Array<{skillName:string, skillId?:string, activatedBy?:string, description?:string}>} [params.activatedSkills] -
   *   skills the turn activates up front (`requestedSkills`, `/name` in the message)
   * @param {boolean} [params.streaming=true]
   * @param {Function} params.buildLogData - `(streaming, extra) => logData`
   * @param {number} [params.timeoutMs] - hard timeout per model call
   * @param {Function} [params.getLocalizedError] - `(key, params, language) => Promise<string>`
   * @param {string} [params.language='en']
   * @param {Object} [params.user]
   * @param {string} [params.runId] - run id to use (default: minted)
   * @param {{interactionId?: string}} [params.continueRun] - `runId` names a paused run of this
   *   chat whose interaction this turn answers: the turn continues that run (same id, one
   *   journal for the whole turn) when `RunLog.continueRun` allows it, and otherwise runs
   *   under a new id. Stored turns only.
   * @param {Object} [params.persistence] - stored-chat context. Every chat turn from the chat
   *   route carries one; a caller without one (an app invoked internally, a headless agent)
   *   runs an unstored turn.
   *   `{ repository, ownerId, identityMode, content, clientMessageId?, attachments?,
   *   replaceFromMessageId?, temporary? }`, where `repository` is a `ChatRepository`, `ownerId`/
   *   `identityMode` are the run principal resolved once by the caller, and `content` is the
   *   raw text of the new user message (the stored history is never client-asserted, but the
   *   message being sent comes from the request). Optional extras for callers that store more
   *   than the chat UI does (the inference API): `message` (fields on the stored user message:
   *   `variables`, `renderedContent`), `chat` (fields patched onto the chat document with the
   *   user turn), `projects` (the container and attachments the turn writes under the chat
   *   lock, `resolveChatProjects().projectPatch`), `projectId` (the container the turn was
   *   prepared for; its question is stored only while the chat is still in it) — a conflict
   *   refuses the turn before the model is called, before it supersedes a running turn when
   *   the stored chat already shows it, and the summary carries `refusal`; `assistant` (fields on the stored answer:
   *   `model`), `origin` (how a chat
   *   created by this turn came about) and `clientConnected` (`() => boolean`, whether the
   *   caller is still there to read the answer; default: an SSE client is attached).
   * @param {RunStreamEmitter} [params.emitter] - Stream emitter to use instead of the chat's
   *   SSE-delivered one, for a caller that consumes the frames itself (the inference API
   *   turns them into OpenAI-shaped events).
   * @param {boolean} [params.headless=!streaming] - No user can answer a clarification: the
   *   ask_user tool is refused instead of pausing the turn.
   * @param {Object} [params.structuredOutput] - Check the final answer against an output
   *   contract: `{ validate: (content) => verdict, maxRetries?: number, onAttemptRejected? }`.
   *   An invalid answer is retried inside the run (`maxRetries`, default 1); one that never
   *   becomes valid ends the turn as an error (`OUTPUT_VALIDATION_FAILED`). A valid answer's
   *   content is the validated JSON, and the summary carries `structuredOutput`.
   * @param {Array<Object>} [params.extraSeams] - Further loop seams, run after the tool
   *   projection and before the question and passthrough seams (a scheduled run's
   *   integration check).
   * @param {Object} [params.approvalGate] - The approval seam to use instead of the chat's
   *   (a scheduled run's, which pauses for the task owner). Runs before every other seam.
   * @param {Object} [params.toolApproval] - Chat tool approval state (#2945):
   *   `{ grants?: string[], resume?: { interactionId, outcome: 'approved'|'rejected'|'expired',
   *   call: { id, name, toolId }, args, transcript } }` from `settleChatApprovals`. With
   *   `resume` the turn continues the paused one: its transcript replaces the decision
   *   message, and the approved call runs with exactly `args`.
   * @param {Object} [params.connectResume] - The call(s) to resume after a connect (#3752):
   *   `{ id, calls, transcript, question, basis }` from `prepareConnectResume`. The turn
   *   continues the stored one: the calls run once through the seams with the stored
   *   arguments (the approval policy still asks) and the model continues. No user message.
   * @param {boolean} [params.canApproveTools] - The client renders approval cards. Without
   *   it (and for a headless turn) a gated call gets `APPROVAL_REQUIRED_NO_USER`.
   * @param {{type: string, source?: string}} [params.trigger] - What started the turn, as the
   *   run ledger records it (default: a user).
   * @param {number} [params.maxWallClockMs] - Tighter wall-clock ceiling for a durable turn
   *   than {@link DURABLE_TURN_WALL_CLOCK_MS}.
   * @param {string} [params.clientTimezone] - The user's IANA timezone, handed to the tools
   *   (the scheduling tools read it) and to the scheduling note in the system prompt.
   * @param {Object|null} [params.priorContext] - The `context` stored with the last answer
   *   of the history the prompt holds: the context figure starts from it instead of
   *   counting the history again (see `loop/contextTracker.js`).
   * @param {boolean} [params.promptResent] - The next turn resends this turn's prompt as it
   *   is (whole history, nothing left out, no context only this turn carries): only then is
   *   the stored context one a next turn can start from.
   * @param {boolean} [params.startsLeftover=false] - The caller starts the messages the person
   *   sent into this answer and the answer did not read as the next turn of a kept chat
   *   (the chat route does, `chatTurnStart.js`): the chat is claimed for that turn when this
   *   one lets go of it, and the result names it (`leftover`). Otherwise they are dropped.
   * @param {boolean} [params.claimed=false] - The chat was claimed for `runId` before this
   *   turn started (a next turn made of an answer's leftover, `chatTurnStart.js`). The turn
   *   then yields to any newer one: it runs only while that claim holds and no other turn
   *   is in flight on the chat, checked before it would supersede anything and again under
   *   the chat lock when its question is stored. A turn that yields stores nothing and
   *   answers `{ status: 'superseded', superseded: true }`.
   * @returns {Promise<Object>} `{ runId, status, content, finishReason, usage, messages, knowledgeSources,
   *   pendingInteraction?, toolName?, error?, errorInfo?, structuredOutput?, refusal?, leftover? }`
   */
  async runTurn({
    prep,
    chatId,
    messageId,
    activatedSkills = [],
    streaming = true,
    buildLogData,
    timeoutMs,
    getLocalizedError,
    language = 'en',
    user,
    runId: givenRunId,
    continueRun = null,
    persistence = null,
    emitter = null,
    headless = !streaming,
    structuredOutput = null,
    extraSeams = [],
    approvalGate = null,
    toolApproval = null,
    connectResume = null,
    canApproveTools = !headless,
    trigger = null,
    maxWallClockMs = null,
    clientTimezone = null,
    outputId = undefined,
    priorContext = null,
    promptResent = false,
    startsLeftover = false,
    claimed = false
  }) {
    const svc = this.svc;
    const {
      app,
      model,
      llmMessages,
      tools = [],
      toolSearch = null,
      maxTokens,
      responseFormat,
      responseSchema,
      llmOptions = {},
      userFileData,
      promptSources = [],
      knowledgeScope = null,
      integrationScopes = {}
    } = prep;
    const log = typeof buildLogData === 'function' ? buildLogData : () => ({});
    const loopTools = markInteractiveTools(tools);
    const startedAt = Date.now();
    let runId = givenRunId && isValidRunId(givenRunId) ? givenRunId : newRunId('chat');
    const refs = { chatId, appId: app?.id, ...(messageId ? { messageId } : {}) };

    // One in-flight request per chat: a new turn supersedes the previous one
    // and the stop endpoint / client disconnect abort through this controller.
    //
    // A durable turn is tracked even without a stream. It was started by a
    // caller with no SSE connection — an integration, or a client whose stream
    // has not come up — and it keeps running after any client goes away, so
    // leaving it out of `activeRequests` would make it the one turn Stop can
    // never reach: the endpoint would answer "stopped" while the model ran to
    // completion and billed the tokens.
    // A turn whose project fields no longer hold (a racing first turn opened
    // the chat in another project) is refused before it supersedes anything:
    // otherwise the conflicting request would cancel the accepted turn that
    // is generating, then fail itself. Checked again under the chat lock when
    // the question is stored.
    if (persistence?.repository) {
      const refusal = await admitTurnProjects({
        repository: persistence.repository,
        chatId,
        projects: persistence.projects || null,
        projectId: persistence.projectId
      });
      if (refusal) {
        return {
          runId,
          status: 'error',
          content: '',
          finishReason: 'error',
          errorInfo: refusal,
          refusal,
          knowledgeSources: []
        };
      }
    }

    // A turn the chat was claimed for already never supersedes a newer one: a
    // message the person sent while it was being prepared wins. Checked right
    // before the turn registers, with nothing awaited in between, so a newer
    // turn on this worker either registered first (this one yields) or comes
    // after and supersedes this one.
    if (claimed && (await claimLost(persistence?.repository, chatId, runId))) {
      return svc._yieldedTurn(chatId, runId);
    }

    const controller = new AbortController();
    const trackRequest = !!chatId && (streaming || !!persistence?.repository);
    if (trackRequest) {
      // The turn in flight may be on another worker: the follow-up no longer
      // stops it from the browser, so the server has to.
      if (hasActiveChatRequest(chatId)) {
        const cause = abortCause('superseded', {
          via: 'ChatService.runTurn',
          related: { runId }
        });
        logger.info('Chat turn supersedes the one in flight', {
          component: COMPONENT,
          chatId,
          ...describeCause(cause)
        });
        if (activeRequests.has(chatId)) activeRequests.get(chatId).abort(abortReason(cause));
        else abortChatRequest(chatId, cause, { before: Date.now() });
      }
      controller.startedAt = Date.now();
      activeRequests.set(chatId, controller);
    }

    // A turn that answers a paused one continues its run, so the journal of
    // that one run holds the whole turn — what happened before the pause, the
    // answer, and the rest — and the answer's evidence record covers it all.
    // When the run cannot be continued this turn runs under a new id, as
    // every turn did before; the paused run keeps its `run/end` (`paused`).
    let continued = null;
    if (continueRun && runId === givenRunId) {
      if (persistence?.repository) {
        continued = await svc._continueLedgerRun({
          runId,
          interactionId: continueRun.interactionId,
          chatId,
          appId: app?.id,
          modelId: model?.id
        });
      }
      // Never a second `run/start` in the paused run's journal.
      if (!continued) runId = newRunId('chat');
    }
    // A turn that could not continue its paused run still reaches the results
    // that run condensed (#3819): its journal is kept while it is paused.
    const archiveRunIds =
      continueRun && !continued && givenRunId !== runId && isValidRunId(givenRunId)
        ? [givenRunId]
        : [];
    // What the run used before the pause: its end counts the whole turn.
    const carriedUsage = continued?.paused?.data?.usage || null;
    // The messages the person sent into this answer that it did not read: they
    // become the next turn, or are dropped, when the turn lets go of the chat.
    const leftover = createLeftover({
      runId,
      startsNextTurn: startsLeftover === true && Boolean(persistence?.repository)
    });

    // The turn's SSE v2 emitter (chat stream id = chatId, run id = this turn).
    // A caller with its own consumer (the inference API turning frames into
    // OpenAI-shaped events) injects one; the chat UI gets the default one,
    // delivered through the SSE layer.
    //
    // A stored turn without a stream (an integration posting with no SSE
    // client) still emits its frames into an emitter that delivers nowhere:
    // they are what records what the turn did for the stored answer
    // (`runActivity.js`). It is not bound to the chat's stream, so nothing
    // that looks for the turn producing on that stream mistakes it for one.
    const recordOnly = !emitter && !streaming && !!chatId && !!persistence?.repository;
    const stream =
      emitter ||
      (streaming && chatId
        ? new RunStreamEmitter({ streamId: chatId, runId })
        : recordOnly
          ? new RunStreamEmitter({ streamId: chatId, runId, deliver: () => false })
          : NO_STREAM);
    if (stream !== NO_STREAM && !recordOnly) bindStreamRun(chatId, runId, stream);

    logger.debug('Chat turn started', {
      component: COMPONENT,
      chatId,
      runId,
      appId: app?.id,
      modelId: model?.id,
      toolCount: loopTools.length,
      toolNames: loopTools.map(t => t.id).join(', '),
      streaming,
      hasUserFileData: !!userFileData
    });

    if (!continued) {
      await svc._startLedgerRun({ runId, kind: 'chat', user, refs, model, language, trigger });
    }

    // Scheduling tools resolve "tomorrow at nine" against the user's clock, so
    // the model has to be told what that clock says.
    appendSchedulingContextNote(llmMessages, loopTools, { timezone: clientTimezone });

    // A durable turn records the human half twice: on the ledger, so the run
    // can be replayed as a conversation, and in the chat store, which is what
    // the history UI reads back. Both happen before the first client frame so
    // the chat document exists by the time anything can ask for it.
    const persist = persistence?.repository ? persistence : null;
    // Whether the chat is in the store: only then does a generated file go
    // there as soon as its tool finishes (the card links to it).
    let chatStored = false;
    if (persist) {
      // What the turn does — its searches, tool calls, workflow steps — is
      // stored with the answer; folding starts before the first frame.
      recordRunActivity(runId);
      const attachments = normalizeAttachments(persist.attachments);
      // A resume after a connect has no user message: the person sent nothing.
      if (!persist.silent) {
        svc._appendUserMessageEvent({ runId, messageId, content: persist.content, attachments });
      }
      const settled = await settleUserTurn({
        silent: persist.silent === true,
        repository: persist.repository,
        chatId,
        ownerId: persist.ownerId,
        identityMode: persist.identityMode,
        appId: app?.id,
        modelId: model?.id,
        settings: persist.settings,
        variables: persist.variables,
        runId,
        content: persist.content,
        // The only client id on the wire is the exchange id of the assistant
        // placeholder, which the client also puts on the message it sends.
        clientMessageId: persist.clientMessageId ?? messageId ?? null,
        attachments,
        replaceFromMessageId: persist.replaceFromMessageId,
        message: persist.message,
        chat: persist.chat,
        projects: persist.projects,
        projectId: persist.projectId,
        origin: persist.origin,
        temporary: persist.temporary === true,
        onlyWhileClaimed: claimed === true
      });
      const { refusal } = settled;
      chatStored = settled.chatStored === true;
      // Claimed for this turn before it started, and taken by a newer turn on
      // another worker since: nothing of it was stored, and nothing was told
      // (`run/started` comes after this), so the newer turn's stream stays its own.
      if (settled.superseded) {
        discardRunActivity(runId);
        svc._endLedgerRun(runId, {
          status: 'aborted',
          finishReason: 'aborted',
          usage: carriedUsage,
          cause: abortCause('superseded', { via: 'ChatService.runTurn' }),
          startedAt
        });
        if (stream !== NO_STREAM) unbindStreamRun(chatId, runId);
        if (activeRequests.get(chatId) === controller) activeRequests.delete(chatId);
        return svc._yieldedTurn(chatId, runId);
      }
      // The chat's container changed under this turn (a first turn that
      // raced it opened the chat in another project): nothing of it was
      // stored, and it ends here, before the model is called.
      if (refusal) {
        discardRunActivity(runId);
        stream.emit(SSE_V2_EVENTS.STREAM_ERROR, refusal);
        stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
          status: 'error',
          finishReason: 'error',
          error: refusal
        });
        svc._endLedgerRun(runId, {
          status: 'error',
          finishReason: 'error',
          error: refusal,
          usage: carriedUsage,
          startedAt
        });
        if (stream !== NO_STREAM) unbindStreamRun(chatId, runId);
        if (trackRequest && activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return {
          runId,
          status: 'error',
          content: '',
          finishReason: 'error',
          errorInfo: refusal,
          refusal,
          knowledgeSources: []
        };
      }
    }

    stream.emit(SSE_V2_EVENTS.RUN_STARTED, {
      kind: 'chat',
      ...(model?.id ? { model: model.id } : {}),
      refs
    });
    // Which projects this turn reached, and whether each was loaded in full
    // or left to the knowledge tools (#1036): on the stream for the badge and
    // on the ledger so a re-sync and the stored answer carry it too.
    if (knowledgeScope?.projects?.length) {
      stream.emit(SSE_V2_EVENTS.KNOWLEDGE_SCOPE, knowledgeScope);
      svc.runLog.append(runId, RUN_LOG_EVENTS.KNOWLEDGE_SCOPE, knowledgeScope);
    }
    for (const skill of activatedSkills || []) {
      if (!skill?.skillName) continue;
      stream.emit(SSE_V2_EVENTS.TOOL_PROGRESS, {
        phase: 'skill.activation',
        message: skill.skillName,
        data: {
          skillName: skill.skillName,
          ...(skill.skillId ? { skillId: skill.skillId } : {}),
          ...(skill.activatedBy ? { activatedBy: skill.activatedBy } : {}),
          description: skill.description || ''
        }
      });
    }

    const channel = streaming ? createChatChannel({ chatId, runId, stream }) : null;
    // MCP App views this turn rendered, stored with the answer so reopening
    // the chat draws them again.
    const mcpAppViews = [];
    // Per-user OAuth MCP servers the turn's tools asked the user to connect,
    // stored with the answer so the Connect card survives the sign-in redirect.
    const authPrompts = [];
    // The calls that returned `INTEGRATION_AUTH_REQUIRED`, kept with the chat
    // so the connect can resume them (#3752).
    const connectCalls = [];
    // Scheduled-task proposals the scheduling tools made, stored with the
    // answer so the confirmation card is still there when the chat reopens.
    const scheduledTaskProposals = [];
    // Files the turn's tools generated (a PDF from `create_pdf`), with their
    // bytes, stored with the answer as `document` artifacts of the chat so the
    // download card is still there when the chat reopens.
    const generatedFiles = [];
    // Pictures the turn's tools returned (an MCP server's `image` block); they
    // join the pictures the model generated.
    const generatedImages = [];
    // How full the model's context window is, reported live and with the end of the run.
    // It starts from the context stored with the previous answer, unless the
    // turn continues a stored transcript (an approval or a connect), which that
    // context does not describe.
    // A continued transcript's first count holds the tool calls and results of
    // before the pause, which no later turn resends: no next turn starts from it.
    const continuesTranscript = Boolean(toolApproval?.resume || connectResume);
    const contextTracker = createContextTracker(model, {
      prior: continuesTranscript ? null : priorContext,
      resent: promptResent && !continuesTranscript
    });
    const turnSeam = chatTurnSeam({
      chatId,
      buildLogData: log,
      streaming,
      telemetry: svc.telemetry,
      contextTracker
    });
    const outputSeam =
      typeof structuredOutput?.validate === 'function'
        ? structuredOutputSeam({
            validate: structuredOutput.validate,
            maxRetries: Number.isInteger(structuredOutput.maxRetries)
              ? structuredOutput.maxRetries
              : 1,
            onAttemptRejected: structuredOutput.onAttemptRejected
          })
        : null;
    // The approval gate (#2945) takes a call over before anything announces
    // or runs it: a gated call never shows as started. A scheduled run brings
    // its own (it pauses for the task owner); a chat turn asks the person in
    // the chat, or — headless, or a client that cannot draw the card — refuses
    // the call with APPROVAL_REQUIRED_NO_USER.
    const resume = toolApproval?.resume || null;
    const gate =
      approvalGate ||
      approvalSeam(
        chatApprovalOptions({
          chatId,
          app,
          platform: configCache.getPlatform?.() || null,
          // A turn that is not stored cannot be continued after the answer.
          headless: headless || canApproveTools === false || !persist,
          grants: toolApproval?.grants || [],
          approvedCall:
            resume?.outcome === 'approved' && resume.call?.id
              ? { callId: resume.call.id, args: resume.args }
              : null,
          buildLogData: log,
          logInteraction: svc.logInteraction,
          interactionService: svc.interactionService,
          runLog: svc.runLog
        })
      );
    // knowledgeSourceSeam runs before chatToolSeam so its `outcome.knowledgeSource`
    // is on the outcome when chatToolSeam projects the tool result to `tool/completed`.
    const seams = [
      gate,
      knowledgeSourceSeam,
      chatToolSeam({
        chatId,
        buildLogData: log,
        logInteraction: svc.logInteraction,
        // Live progress is for a client that watches the stream.
        streamProgress: Boolean(streaming),
        mcpAppViews,
        authPrompts,
        connectCalls,
        scheduledTaskProposals,
        generatedFiles,
        generatedImages,
        // A stored chat keeps a generated file as an artifact when the tool
        // finishes: the client is sent the card, never the bytes.
        // A chat that could not be stored keeps the bytes on the card instead.
        artifactStore: chatStored ? (persist.repository.artifactStore?.() ?? null) : null
      }),
      ...(Array.isArray(extraSeams) ? extraSeams.filter(Boolean) : []),
      questionSeam(
        chatQuestionOptions({
          chatId,
          appId: app?.id,
          buildLogData: log,
          logInteraction: svc.logInteraction,
          headless,
          getCount: () => svc.getClarificationCount(chatId),
          incrementCount: () => svc.incrementClarificationCount(chatId),
          interactionService: svc.interactionService
        })
      ),
      passthroughSeam(
        chatPassthroughOptions({
          chatId,
          chatStored: Boolean(persist),
          user,
          app,
          integrationScopes,
          userFileData,
          streaming,
          buildLogData: log,
          logInteraction: svc.logInteraction,
          toolRunner: svc.toolRunner
        })
      ),
      imageLiftSeam,
      ...(outputSeam ? [outputSeam] : []),
      turnSeam,
      // A message the person sent into the answer, read at a step: told and stored.
      chatSteerSeam({
        chatId,
        runId,
        stream,
        repository: chatStored ? persist.repository : null
      })
    ];

    const pageReads = createPageReadGate(resolveMaxPageReads(app));
    // The skills the model loads in this turn: a tool whose skill carries rules
    // (`create_dashboard`) checks that it did (`activate_skill` writes to it).
    const turnSkills = createTurnSkillLog();

    // A continuation of a turn that paused on an approval: the stored part of
    // that turn replaces the decision message. An approved call is run by the
    // loop itself (`resume`), with the arguments that were approved; a
    // rejected or expired one gets its refusal as the tool result.
    let loopMessages = llmMessages;
    let loopResume = null;
    if (resume?.call?.id && Array.isArray(resume.transcript) && resume.transcript.length) {
      loopMessages = continuationMessages(llmMessages, resume.transcript, {
        question: resume.question
      });
      const toolName = String(resume.call.name || resume.call.toolId || 'tool');
      if (resume.outcome === 'approved') {
        loopResume = {
          toolCall: {
            id: resume.call.id,
            type: 'function',
            function: { name: resume.call.name, arguments: JSON.stringify(resume.args || {}) }
          },
          args: resume.args || {}
        };
      } else {
        const payload = approvalRefusalPayload(resume.outcome, toolName);
        replaceToolResult(loopMessages, resume.call.id, payload);
        stream.emit(SSE_V2_EVENTS.TOOL_COMPLETED, {
          step: 0,
          callId: String(resume.call.id),
          toolId: String(resume.call.toolId || toolName),
          name: toolName,
          resultPreview: payload,
          error: { code: payload.code, message: payload.message }
        });
      }
    }
    // A resume after a connect (#3752): the stored step replaces nothing in
    // the history (it has no decision message); the calls that failed run
    // again through the seams, with no approval carried over.
    let continuation = resume;
    if (connectResume?.calls?.length && Array.isArray(connectResume.transcript)) {
      loopMessages = connectResumeMessages(llmMessages, connectResume.transcript, {
        question: connectResume.question
      });
      loopResume = loopResumeOf(connectResume.calls);
      continuation = connectResume;
    }
    // The last message before what this turn's loop adds (a continuation
    // starts after the stored transcript's predecessor), found by identity.
    const turnStartMessage =
      loopMessages === llmMessages
        ? llmMessages[llmMessages.length - 1]
        : loopMessages[loopMessages.length - continuation.transcript.length - 1];

    // From here the answered approval is used: a caller must not put it back.
    if (toolApproval && typeof toolApproval === 'object') toolApproval.started = true;
    if (connectResume && typeof connectResume === 'object') connectResume.started = true;

    // Until this turn's wrap-up is done (answer stored, chat released, stream
    // unbound — the `finally` below), a continuation of its run waits: a
    // pause shows its card before that, and a quick answer must not race it.
    const releaseRunHold =
      typeof svc.runLog.hold === 'function' ? svc.runLog.hold(runId) : () => {};
    let outcome;
    try {
      const result = await svc.agentLoop.run({
        runId,
        kind: 'chat',
        model,
        messages: loopMessages,
        ...(loopResume ? { resume: loopResume } : {}),
        tools: loopTools,
        toolSearch,
        toolExecution: 'server',
        policies: {
          budgets: {
            maxToolRounds: CHAT_MAX_TOOL_ROUNDS,
            // Only for a turn that can outlive its client; see the constant.
            ...(persist
              ? {
                  maxWallClockMs:
                    Number.isFinite(maxWallClockMs) && maxWallClockMs > 0
                      ? Math.min(maxWallClockMs, DURABLE_TURN_WALL_CLOCK_MS)
                      : DURABLE_TURN_WALL_CLOCK_MS
                }
              : {})
          },
          // Chat tools have side effects — one call at a time, except the
          // trusted reads of a step when the feature is on (`chatToolPolicies`).
          tools: chatToolPolicies({ app, model }),
          context: chatContextPolicies(model)
        },
        summaryModel: chatCompactionModel({ model, user }),
        ...(archiveRunIds.length ? { archiveRunIds } : {}),
        options: { maxTokens, responseFormat, responseSchema, ...llmOptions },
        language,
        signal: controller.signal,
        timeoutMs,
        refs: { ...refs, userId: user?.id },
        meta: { stream },
        seams,
        channel,
        // The tool runner (`services/run/ToolRunner.js`) builds the tool's
        // parameters: `language` is a default the model's arguments may
        // override, while the chat, the user, the app and the scopes the user
        // picked for the chat (`integrationScopes`, #3050) never can. Page
        // reads are capped per turn by the gate (`websearch.maxPageReads`).
        //
        // An MCP tool of a server with MCP Apps enabled hands back its raw
        // result on the shared `info` object, where `chatToolSeam` builds the
        // view from it (declared, or embedded in the result).
        executeTool: (call, { toolId, toolDef, args, info, signal }) =>
          svc.toolRunner.execute(call, {
            toolId,
            toolDef,
            args,
            signal,
            toolContext: {
              origin: 'chat',
              // The approval seam is the first seam of the turn.
              approval: 'seam',
              principal: user,
              chatId,
              appConfig: app,
              language,
              integrationScopes,
              turnSkills,
              clientTimezone,
              chatStored: Boolean(persist),
              pageReads,
              onMcpAppResult: result => {
                if (info) info.mcpAppResult = result;
              }
            }
          })
      });
      // Paused on a chat approval: keep what the continuation needs with the
      // chat, and only then show the card (`interaction/raised`), so even an
      // immediate answer finds it. One that could not be kept is cancelled
      // and never shown as answerable.
      if (
        !approvalGate &&
        persist &&
        result.status === 'paused' &&
        result.pendingInteraction?.kind === 'approval'
      ) {
        const stored = await svc._storePendingApproval({
          repository: persist.repository,
          chatId,
          runId,
          grants: toolApproval?.grants || [],
          interaction: result.pendingInteraction,
          messages: result.messages,
          startMessage: turnStartMessage,
          // What this turn found so far: the answer after the approval rests on it too.
          basis: carriedBasis({ prior: resume?.basis || connectResume?.basis, result })
        });
        if (stored) {
          stream.emit(SSE_V2_EVENTS.INTERACTION_RAISED, { interaction: result.pendingInteraction });
        } else {
          const toolCallId = result.pendingInteraction.source?.toolCallId;
          stream.emit(SSE_V2_EVENTS.TOOL_COMPLETED, {
            step: result.pendingInteraction.step || 0,
            callId: String(toolCallId || '0'),
            toolId: String(result.pendingInteraction.source?.toolId || 'tool'),
            name: String(result.pendingInteraction.source?.toolId || 'tool'),
            resultPreview: {
              error: true,
              code: 'APPROVAL_NOT_STORED',
              message: 'The approval could not be kept with the chat; the call was not run.'
            },
            error: {
              code: 'APPROVAL_NOT_STORED',
              message: 'The approval could not be kept with the chat; the call was not run.'
            }
          });
        }
      }
      // The calls that stopped on a missing connection stay with the chat, so
      // the connect can run them once (#3752). Before the answer is stored:
      // a client that reopens the chat at once finds the record.
      // Not for a headless turn (the inference API, a scheduled run) nor a
      // temporary chat: nobody can come back to continue them.
      if (
        !approvalGate &&
        !headless &&
        persist &&
        persist.temporary !== true &&
        result.status === 'completed' &&
        connectCalls.length > 0
      ) {
        await svc._storePendingConnect({
          repository: persist.repository,
          chatId,
          runId,
          user,
          calls: connectCalls,
          messages: result.messages,
          startMessage: turnStartMessage,
          continues: connectResume?.answerRunIds || [],
          basis: carriedBasis({ prior: resume?.basis || connectResume?.basis, result })
        });
      }
      // The terminal frames (`stream/error`, `run/ended`) are held back until
      // the answer is stored (below), and then sent in the order they were
      // made: the client stops reading at either of them.
      const terminalFrames = [];
      const finishStream = {
        emit: (type, data) => {
          if (type === SSE_V2_EVENTS.STREAM_ERROR || type === SSE_V2_EVENTS.RUN_ENDED) {
            terminalFrames.push([type, data]);
            return null;
          }
          return stream.emit(type, data);
        }
      };
      outcome = await this._finishTurn({
        result,
        outputId,
        user,
        runId,
        chatId,
        streaming,
        stream: finishStream,
        buildLogData: log,
        model,
        timeoutMs,
        getLocalizedError,
        language,
        channel,
        mcpAppViews,
        authPrompts,
        scheduledTaskProposals,
        generatedFiles,
        generatedImages,
        promptSources,
        knowledgeScope,
        // What the turn this one continues had used (an approval paused it).
        priorBasis: resume?.basis || connectResume?.basis || null,
        contextTracker,
        signal: controller.signal,
        structured: outputSeam
          ? {
              validate: structuredOutput.validate,
              attempts: () => outputSeam.attempts(),
              verdictFor: answer => outputSeam.verdictFor(answer)
            }
          : null
      });
      // The ledger's terminal frame first, then the chat document.
      //
      // A client reopening a chat asks the document whether a turn is running
      // and, if it is, replays the run's ledger to catch up. Materializing
      // first opens a window between the answer being appended and the run
      // being released — `materializeAssistantTurn` takes the chat lock for
      // each separately — in which the document still says `running` and the
      // ledger holds no `run/ended`. A client reopening inside it attaches to
      // a run that is already over: nothing further arrives, so the placeholder
      // spins and the composer stays behind a Stop button until the user
      // presses it. Ending the ledger first means the replay always carries the
      // terminal frame, and the reattach settles instead of latching.
      //
      // The reverse window — a released document while the ledger has not
      // ended — costs nothing: a document that is not `running` is never
      // reattached to in the first place.
      svc._endLedgerRun(runId, {
        status: outcome.status,
        finishReason: outcome.finishReason,
        // A continued run's end counts what it used before the pause too.
        usage: carriedUsage ? addUsage(carriedUsage, outcome.usage) : outcome.usage,
        error: outcome.error || (outcome.errorInfo ? outcome.errorInfo : undefined),
        knowledgeSources: outcome.knowledgeSources,
        answerBasis: outcome.answerBasis,
        limitReachedIn: outcome.limitReachedIn,
        provenance: outcome.provenance,
        cause: outcome.abortCause,
        startedAt
      });
      // The single choke point: every terminal shape `_finishTurn` produces —
      // normal, aborted, error, passthrough answer, malformed response —
      // passes through here with the same summary.
      //
      // The answer is stored BEFORE the client is told the turn is over. A
      // client that has seen `run/ended` re-reads the stored chat (a reattached
      // turn does at once, `useAppChat`'s `rereadStoredChat`; a user reloads):
      // told first, it can read the chat in the window before the append and
      // replace the answer on screen with a transcript that lacks it. The
      // stored activity does not need the frame: the materializer settles a
      // run that is still open in its recording (`runActivity.js`).
      try {
        if (persist) {
          await materializeAssistantTurn({
            repository: persist.repository,
            chatId,
            runId,
            summary: outcome,
            clientConnected: clientConnectedOf(persist, chatId),
            message: persist.assistant,
            runLog: svc.runLog,
            takeLeftover: leftover.takerFor(outcome.status, outcome.abortCause?.kind)
          });
        }
      } finally {
        for (const [type, data] of terminalFrames) stream.emit(type, data);
      }
      if (persist) {
        // A named chat is easier to find again. After the answer is stored and
        // not awaited: the title never delays the turn, and it works the same
        // when the client has long gone, because the user is a closure value.
        if (outcome.status === 'completed' && !outcome.error) {
          scheduleChatTitle({
            repository: persist.repository,
            chatId,
            user,
            chatModel: model,
            appId: app?.id,
            language,
            firstAnswerOnly: true
          });
        }
      }
      // A leftover the caller starts as the next turn (`chatTurnStart.js`).
      const next = leftover.finish(persist ? 'superseded' : 'run_ended');
      if (next) outcome.leftover = next;
      return outcome;
    } catch (error) {
      // The loop never throws for model or tool failures; this is a bug path.
      logger.error('Chat turn crashed', { component: COMPONENT, chatId, runId, error });
      // Ledger first here too, for the reason above; `stream/error` and
      // `run/ended` after the chat is settled, as on the ordinary path.
      svc._endLedgerRun(runId, {
        status: 'error',
        finishReason: 'error',
        error,
        usage: carriedUsage,
        startedAt
      });
      // `_finishTurn` never ran, so nothing else releases the chat: without
      // this it stays `running` with a live `activeRunId` forever.
      try {
        if (persist) {
          await materializeAssistantTurn({
            repository: persist.repository,
            chatId,
            runId,
            summary: {
              status: 'error',
              content: '',
              finishReason: 'error',
              errorInfo: { code: 'INTERNAL_ERROR', message: error.message || 'Internal error' }
            },
            clientConnected: clientConnectedOf(persist, chatId),
            runLog: svc.runLog,
            takeLeftover: leftover.takerFor('error')
          });
        }
      } finally {
        stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Internal error'
        });
        stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
          status: 'error',
          finishReason: 'error',
          error: { code: 'INTERNAL_ERROR', message: error.message || 'Internal error' }
        });
      }
      throw error;
    } finally {
      // Whatever the turn did not settle above is dropped: a run that no
      // longer held its chat was replaced by a newer message.
      leftover.finish(persist ? 'superseded' : 'run_ended');
      if (stream !== NO_STREAM) unbindStreamRun(chatId, runId);
      if (trackRequest && activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
      releaseRunHold();
    }
  }

  /**
   * Project the loop result onto the terminal frames (`stream/error`,
   * `run/paused`, `run/ended`) and the interaction log.
   * @private
   */
  async _finishTurn({
    result,
    outputId,
    user = null,
    runId,
    chatId,
    streaming,
    stream,
    buildLogData,
    model,
    timeoutMs,
    getLocalizedError,
    language,
    channel,
    mcpAppViews = [],
    authPrompts = [],
    scheduledTaskProposals = [],
    generatedFiles = [],
    generatedImages = [],
    promptSources = [],
    knowledgeScope = null,
    priorBasis = null,
    contextTracker = null,
    structured = null,
    signal = null
  }) {
    const svc = this.svc;
    // A continuation after an approval starts a new loop run: what the turn used
    // before it paused is added, so the answer's basis is the whole turn's.
    const loopSources = [
      ...new Set([...(priorBasis?.knowledgeSources || []), ...(result.knowledgeSources || [])])
    ];
    const integrations = [
      ...new Set([...(priorBasis?.integrations || []), ...(result.integrations || [])])
    ];
    const content = result.content || '';
    const usage = wireUsage(result.usage);
    const summary = {
      runId,
      status: result.status,
      content,
      finishReason: result.finishReason,
      usage: result.usage,
      messages: result.messages,
      // On the summary rather than only on the stream: a generated image is
      // part of what the turn produced, and the materializer stores it beside
      // the transcript so reopening the chat still shows it. Every terminal
      // branch below spreads this object, so an aborted turn keeps the
      // pictures it had already emitted.
      images: [...(result.images || []), ...generatedImages],
      // Same reasoning for MCP App views: part of the answer, restored on reopen.
      mcpApps: mcpAppViews,
      integrationAuthRequired: authPrompts,
      scheduledTaskProposals,
      generatedFiles,
      // Everything the turn found — web pages, documents, records — and the
      // passages they back, which the sources panel draws again on reopen.
      sources: result.sources || null
      // `knowledgeSources` is set by the branches that name the answer's
      // sources on `run/ended` — the ledger records the summary's list, so it
      // must be exactly what the stream reported.
    };
    const translate = async (key, params) => {
      if (typeof getLocalizedError !== 'function') return null;
      try {
        return await getLocalizedError(key, params || {}, language);
      } catch {
        return null;
      }
    };
    // The window as the turn left it (tool results included), sent with the
    // end of the run and stored with the answer, so a reopened chat shows it.
    // What the next turn sends: the prompt this turn started from plus its
    // answer. Tool calls and results are not replayed (later prompts are built
    // from the stored messages), so they are in the live frames only.
    const context = contextTracker?.replay(content) || contextTracker?.last() || undefined;
    if (context) summary.context = context;
    // `runTurn` passes a stream that holds the terminal frames back until the
    // answer is stored, so the client is told the turn is over only then.
    const endRun = data => {
      stream.emit(SSE_V2_EVENTS.RUN_ENDED, {
        ...(usage ? { usage } : {}),
        ...(context ? { context } : {}),
        ...data
      });
    };
    // The provenance object of the answer (EU AI Act Art. 50(2)): hashed from
    // the text the caller receives, so it runs after structured-output
    // validation and before citation markers. A store failure never fails the
    // turn. Set on the summary so every terminal branch below carries it onto
    // the stored message, and on `run/ended` so a ledger replay keeps it.
    const attachProvenance = async () => {
      const provenance = await recordTextOutput({
        outputId,
        text: summary.content,
        finalText: result.answerText,
        model: { id: model?.id },
        modelConfig: model,
        marking: result.marking?.text,
        user
      });
      if (provenance) summary.provenance = provenance;
      return provenance;
    };
    const provenanceOf = () => (summary.provenance ? { provenance: summary.provenance } : {});
    // What the answer is based on, from the sources the turn used and the
    // connected systems that informed it: the kinds the footer's chip shows.
    const answerBasisFor = (sources, { byModel = true } = {}) => {
      const basis = answerBasisOf({ knowledgeSources: sources, integrations, byModel });
      // Counted once per answer: how many kinds it names, and whether the sources
      // name an origin the basis leaves out.
      recordAnswerOriginMetrics(basis, result?.sources);
      return basis;
    };
    // The knowledge scope is reported when the turn starts, with what went into
    // the prompt. A project a search of the turn then returned contributed too:
    // said again, with that settled, just before the turn ends.
    const reportSettledScope = () => {
      const settled = settleKnowledgeScope(
        knowledgeScope,
        result.sources,
        priorBasis?.projectsRead
      );
      if (!settled || settled === knowledgeScope) return;
      stream.emit(SSE_V2_EVENTS.KNOWLEDGE_SCOPE, settled);
      svc.runLog.append(runId, RUN_LOG_EVENTS.KNOWLEDGE_SCOPE, settled);
    };
    // Whether the turn wrote any answer — text or a picture — the user sees.
    const producedOutput = channel
      ? channel.state.answerOutput
      : content.length > 0 || (result.images?.length ?? 0) > 0;

    if (result.status === 'aborted') {
      // Stop button, client disconnect or a superseding turn: no error bubble.
      await svc.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        outcome: 'aborted'
      });
      // A stopped turn keeps what it had already written, and that answer is
      // based on what the turn used until then. One that wrote nothing has no
      // answer to name a source for.
      const knowledgeSources = producedOutput
        ? svc.resolveAnswerSources(loopSources, promptSources)
        : undefined;
      const answerBasis = knowledgeSources ? answerBasisFor(knowledgeSources) : undefined;
      // Who stopped it: the reason the turn's controller was aborted with.
      const cause = causeOfSignal(signal);
      // What was generated and shown is recorded; no text, no record.
      await attachProvenance();
      if (answerBasis) reportSettledScope();
      endRun({
        status: 'aborted',
        finishReason: 'connection_closed',
        cause,
        ...(knowledgeSources ? { knowledgeSources } : {}),
        ...(answerBasis ? { answerBasis } : {}),
        ...provenanceOf()
      });
      return {
        ...summary,
        status: 'aborted',
        finishReason: 'connection_closed',
        abortCause: cause,
        ...(knowledgeSources ? { knowledgeSources } : {}),
        ...(answerBasis ? { answerBasis } : {})
      };
    }

    if (result.status === 'error') {
      const err = result.error;
      const errorInfo = await describeChatError(err, {
        model,
        language,
        getLocalizedError,
        timeoutMs
      });
      await svc.telemetry.recordChatCallEnd({
        baseLog: buildLogData(streaming),
        model,
        outcome: 'error',
        error: err
      });
      logger.error('Chat turn failed', {
        component: COMPONENT,
        chatId,
        runId,
        modelId: model?.id,
        provider: model?.provider,
        code: errorInfo.code,
        error: err?.message
      });
      if (errorInfo.isContextWindowError) {
        logger.warn('Context window exceeded', {
          component: COMPONENT,
          chatId,
          modelId: model?.id,
          contextWindow: model?.contextWindow
        });
      }
      await svc.logInteraction(
        'chat_error',
        buildLogData(streaming, {
          responseType: 'error',
          error: {
            message: errorInfo.message,
            code: errorInfo.code,
            details: errorInfo.details,
            isContextWindowError: errorInfo.isContextWindowError
          },
          response: content
        })
      );
      stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
        code: String(errorInfo.code || 'ERROR'),
        message: errorInfo.message,
        ...(errorInfo.details !== undefined ? { details: errorInfo.details } : {}),
        retryable: false,
        isContextWindowError: !!errorInfo.isContextWindowError
      });
      endRun({
        status: 'error',
        finishReason: 'error',
        error: { code: String(errorInfo.code || 'ERROR'), message: errorInfo.message }
      });
      return { ...summary, status: 'error', finishReason: 'error', error: err, errorInfo };
    }

    if (result.status === 'paused') {
      // The turn pauses for the user's answer: the question or approval seam
      // already sent `interaction/raised`; no badge.
      const pendingInteraction = result.pendingInteraction;
      stream.emit(SSE_V2_EVENTS.RUN_PAUSED, {
        reason: 'interaction',
        ...(pendingInteraction?.id ? { interactionId: String(pendingInteraction.id) } : {})
      });
      return {
        ...summary,
        finishReason: result.finishReason === 'approval' ? 'approval' : 'clarification',
        pendingInteraction
      };
    }

    // The output contract, checked on the answer the run ended with. A
    // passthrough answer never went through the seam, so this is its only
    // check; a model answer the seam already judged keeps that verdict (a
    // second run of the time-bounded pattern checks could disagree), and one
    // it never saw is checked here. Either way it is the answer alone that is
    // checked — the final step's text, or the passthrough tool's output — not
    // prose written before a tool call. Returns the terminal summary of a
    // failed check, or null.
    let structuredOutput;
    const checkStructuredOutput = async ({ passthrough = false } = {}) => {
      if (!structured) return null;
      const answer =
        passthrough && typeof result.terminate?.content === 'string'
          ? result.terminate.content
          : typeof result.answerText === 'string'
            ? result.answerText
            : content;
      let verdict = passthrough ? null : structured.verdictFor?.(answer) || null;
      if (!verdict) {
        try {
          verdict = structured.validate(answer);
        } catch (error) {
          verdict = { valid: false, errors: [{ path: '', message: error.message }] };
        }
      }
      const attempts = Math.max(1, structured.attempts?.() || 0);
      if (!verdict.valid) {
        const errors = Array.isArray(verdict.errors) ? verdict.errors : [];
        const message =
          (await translate('outputValidationFailed')) ||
          `The answer did not match the output schema after ${attempts} attempt${
            attempts === 1 ? '' : 's'
          }.`;
        logger.warn('Structured output failed validation', {
          component: COMPONENT,
          chatId,
          runId,
          modelId: model?.id,
          attempts,
          errorCount: errors.length
        });
        await svc.logInteraction(
          'chat_error',
          buildLogData(streaming, {
            responseType: 'error',
            error: { message, code: 'OUTPUT_VALIDATION_FAILED', details: errors },
            response: content
          })
        );
        stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
          code: 'OUTPUT_VALIDATION_FAILED',
          message,
          details: errors,
          retryable: true
        });
        endRun({
          status: 'error',
          finishReason: 'error',
          error: { code: 'OUTPUT_VALIDATION_FAILED', message }
        });
        return {
          ...summary,
          status: 'error',
          finishReason: 'error',
          errorInfo: { message, code: 'OUTPUT_VALIDATION_FAILED', details: errors },
          structuredOutput: { valid: false, errors, attempts }
        };
      }
      structuredOutput = { valid: true, value: verdict.value, attempts };
      // What the caller and the stored history get is the validated JSON,
      // without the fences or prose a model may have wrapped it in.
      if (typeof verdict.text === 'string') summary.content = verdict.text;
      return null;
    };

    if (result.finishReason === 'tool_passthrough_complete') {
      const rejected = await checkStructuredOutput({ passthrough: true });
      if (rejected) return rejected;
      const toolName = result.terminate?.toolName;
      await svc.logInteraction(
        'chat_response',
        buildLogData(streaming, {
          responseType: 'success',
          response: content.substring(0, 1000),
          source: 'passthrough_tool',
          toolName
        })
      );
      const knowledgeSources = svc.resolveAnswerSources(loopSources, promptSources, {
        byModel: false
      });
      // The tool's output has a basis only when it used something.
      const passthroughBasis = answerBasisFor(knowledgeSources, { byModel: false });
      const answerBasis = passthroughBasis.length > 0 ? passthroughBasis : undefined;
      // A passthrough answer is tool output, but the user sees it as the AI
      // app's answer, so it is recorded with the turn's model.
      await attachProvenance();
      reportSettledScope();
      endRun({
        status: 'completed',
        finishReason: 'tool_passthrough_complete',
        ...(toolName ? { toolName: String(toolName) } : {}),
        knowledgeSources,
        ...(answerBasis ? { answerBasis } : {}),
        ...provenanceOf()
      });
      return {
        ...summary,
        status: 'completed',
        toolName,
        knowledgeSources,
        ...(answerBasis ? { answerBasis } : {}),
        ...(structuredOutput ? { structuredOutput } : {})
      };
    }

    // Degenerate completion: a failure finish reason (e.g. Gemini's
    // MALFORMED_FUNCTION_CALL) with no answer output would reach the client as
    // a clean end with an empty bubble — surface an error instead.
    if (!producedOutput && isFailureFinishReason(result.finishReason)) {
      const message =
        (await translate('malformedModelResponse')) ||
        'The model returned a malformed response. Please try again.';
      logger.warn('Model completed with failure finish reason and no output', {
        component: COMPONENT,
        chatId,
        runId,
        provider: model?.provider,
        modelId: model?.id,
        finishReason: result.finishReason
      });
      await svc.logInteraction(
        'chat_error',
        buildLogData(streaming, {
          responseType: 'error',
          error: {
            message,
            code: 'MALFORMED_RESPONSE',
            details: { finishReason: result.finishReason }
          },
          response: content
        })
      );
      stream.emit(SSE_V2_EVENTS.STREAM_ERROR, {
        code: 'MALFORMED_RESPONSE',
        message,
        details: { finishReason: result.finishReason },
        retryable: true
      });
      endRun({
        status: 'error',
        finishReason: 'error',
        error: { code: 'MALFORMED_RESPONSE', message }
      });
      return {
        ...summary,
        status: 'error',
        finishReason: 'error',
        errorInfo: { message, code: 'MALFORMED_RESPONSE' }
      };
    }

    const rejected = await checkStructuredOutput();
    if (rejected) return rejected;

    const finishReason = result.finishReason || 'stop';
    const knowledgeSources = svc.resolveAnswerSources(loopSources, promptSources);
    const answerBasis = answerBasisFor(knowledgeSources);
    // Hit the output limit: thinking it all away reads differently from an
    // answer cut off mid-sentence (see outputLimit.js).
    const limitReached = limitReachedIn({
      finishReason,
      answerText: result.answerText,
      stepUsage: result.stepUsage
    });
    if (limitReached) summary.limitReachedIn = limitReached;
    await attachProvenance();
    reportSettledScope();
    endRun({
      status: result.status || 'completed',
      finishReason,
      ...(limitReached ? { limitReachedIn: limitReached } : {}),
      knowledgeSources,
      answerBasis,
      ...provenanceOf()
    });
    await svc.logInteraction(
      'chat_response',
      buildLogData(streaming, {
        responseType: 'success',
        response: summary.content.substring(0, 1000)
      })
    );
    return {
      ...summary,
      finishReason,
      knowledgeSources,
      answerBasis,
      ...(structuredOutput ? { structuredOutput } : {})
    };
  }
}

export default ChatHost;
