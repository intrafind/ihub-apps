// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat surface, recorded through its HTTP route: `POST` and `GET
 * /api/apps/{appId}/chat/{chatId}` and `POST .../stop`, as
 * `routes/chat/sessionRoutes.js` registers them.
 *
 * Every scenario is recorded twice, once for each position of the feature
 * `chatPostStream`. The server does not read that flag: it tells the browser
 * how to ask, and the route answers by the `Accept` header.
 *
 * - off (`<case>.json`): the browser holds a `GET` stream on the chat and
 *   posts the message; the `POST` answers with JSON and the frames of the turn
 *   arrive on the `GET` stream.
 * - on (`<case>-post-stream.json`): the browser posts with
 *   `Accept: text/event-stream` and the frames arrive on that response.
 *
 * `httpResponse` holds every request with its status and body or stream;
 * `storedMessage` and `evidence` hold what the chat stores afterwards.
 *
 * @module tests/golden/surfaces/chat
 */
import { defineCase } from '../harness.js';
import { mergeStepDeltas, orderParallelGroups } from '../normalise.js';
import { turn } from '../../helpers/scriptedModel.js';
import registerSessionRoutes from '../../../routes/chat/sessionRoutes.js';
import { getLocalizedError } from '../../../serverHelpers.js';
import { setEnvelopeDelivery } from '../../../services/loop/RunStream.js';
import { routeEnvelope } from '../../../sse.js';
import { app, goldenUser, readStoredChat, surfaceConfig, usage } from './fixtures.js';
import { openRequest, startRouteServer } from './http.js';

const SSE = 'text/event-stream';
const CHAT_ID = '0c0ffee0-0000-4000-8000-00000000c4a7';

const POSITIONS = Object.freeze([
  {
    key: 'get',
    suffix: '',
    label: 'chatPostStream off: the POST answers with JSON, the frames arrive on the GET stream'
  },
  {
    key: 'post',
    suffix: '-post-stream',
    label: 'chatPostStream on: the frames arrive on the POST response'
  }
]);

const APPS = [
  app('desk', {
    integrations: {
      lookup: {},
      archive: {},
      dangerous: {},
      tracker: {},
      ihub: { actions: ['ask_user'] }
    }
  }),
  app('form', {
    system: { en: 'You fill in the record form.' },
    preferredOutputFormat: 'json',
    outputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        open: { type: 'boolean' }
      },
      required: ['key', 'open'],
      additionalProperties: false
    }
  })
];

const chatConfig = (extra = {}) => surfaceConfig({ apps: APPS, extra });

/** Frames of a response as a golden holds them: no counters, deltas merged, parallel groups ordered. */
export function recordedFrames(frames) {
  const envelopes = frames
    .map(frame => frame.data)
    .filter(envelope => envelope && typeof envelope === 'object')
    // `stream/connected` stays: it is the first thing the route says to a browser.
    .filter(envelope => envelope.type !== 'heartbeat')
    .map(envelope => {
      const data = envelope.data && typeof envelope.data === 'object' ? { ...envelope.data } : null;
      // How many frames the stream had sent before depends on how deltas were cut.
      if (data && envelope.type === 'stream/connected') delete data.lastSeq;
      return {
        type: envelope.type,
        ...(envelope.runId ? { runId: envelope.runId } : {}),
        data: data ?? envelope.data ?? null
      };
    });
  return orderParallelGroups(mergeStepDeltas(envelopes));
}

const typeOf = frame => frame?.data?.type;

/**
 * The frames of a GET stream that the server sent through its delivery function: every envelope
 * but `stream/connected`, which the route writes straight to the connection when the stream
 * opens (`writeStreamStart` in `server/sse.js`). Their number is compared with the number of
 * envelopes the delivery function handed to the stream, so the two must count the same things.
 *
 * @param {Array<{data?: any}>} frames - Parsed SSE frames (`parseSse`).
 * @returns {Object[]}
 */
export function deliveredFrames(frames) {
  return frames.filter(frame => {
    const type = typeOf(frame);
    return typeof type === 'string' && type !== 'stream/connected' && type !== 'heartbeat';
  });
}

/**
 * One chat as a browser drives it, in one position of `chatPostStream`.
 */
class ChatSession {
  constructor({ env, port, position, appId, chatId }) {
    this.env = env;
    this.port = port;
    this.position = position;
    this.path = `/api/apps/${appId}/chat/${chatId}`;
    this.chatId = chatId;
    this.exchanges = [];
    this.get = null;
    this.delivered = 0;
    this.messages = 0;
  }

  /** The browser opens the chat: with `chatPostStream` off it attaches the GET stream. */
  async open() {
    if (this.position.key !== 'get') return;
    this.get = openRequest({
      port: this.port,
      method: 'GET',
      path: this.path,
      headers: { accept: SSE }
    });
    await this.get.until(frame => typeOf(frame) === 'stream/connected', 'stream/connected');
  }

  /**
   * Resolves when the browser has read every frame the server sent on the GET stream so far.
   *
   * The POST and the GET are two sockets, and nothing orders what arrives on them: the JSON
   * answer of a POST can be read before the last frame of its turn.
   */
  async allFramesRead() {
    const sent = this.delivered;
    await this.get.until(
      () => deliveredFrames(this.get.frames).length >= sent,
      `the ${sent} frames the server sent on the GET stream`
    );
  }

  /**
   * Post one message without waiting for the turn.
   *
   * @param {Object} message - Fields of the message beside `role` and `messageId`.
   * @param {Object} [body] - Further fields of the request body.
   * @returns {{exchange: Object, ended: Promise<Object[]>}} `ended` resolves with the frames of the turn.
   */
  post(message, body = {}) {
    const request = {
      messages: [{ role: 'user', messageId: `msg-${++this.messages}`, ...message }],
      modelId: 'golden-model',
      language: 'en',
      toolApprovalCapable: true,
      ...body
    };
    const stream = this.position.key === 'post';
    const from = this.get ? this.get.frames.length : 0;
    const exchange = openRequest({
      port: this.port,
      method: 'POST',
      path: this.path,
      body: request,
      headers: stream ? { accept: SSE } : {}
    });
    const entry = {
      request: {
        method: 'POST',
        path: this.path,
        ...(stream ? { accept: SSE } : {}),
        body: request
      }
    };
    this.exchanges.push(entry);
    const ended = exchange.done.then(async response => {
      entry.response = response.stream
        ? { ...response, stream: recordedFrames(response.stream) }
        : response;
      if (stream) return response.stream ?? [];
      // The JSON answer came after the turn ended, and the frames of the turn were written to
      // the GET stream before that. Written is not read: wait for them.
      await this.allFramesRead();
      return this.get.frames.slice(from);
    });
    return { exchange, ended };
  }

  /** Post one message and wait for the end of its turn; resolves with the frames of the turn. */
  async send(message, body) {
    return this.post(message, body).ended;
  }

  /** The stop button. */
  async stop() {
    const path = `${this.path}/stop`;
    const body = { source: 'stop-button' };
    const response = await openRequest({ port: this.port, method: 'POST', path, body }).done;
    this.exchanges.push({ request: { method: 'POST', path, body }, response });
  }

  /** Close the chat and return what the browser saw. */
  async close() {
    const record = { position: this.position.label, exchanges: this.exchanges };
    if (this.get) {
      // Whatever was sent after the last turn (a stop, the end of a superseded turn) is read
      // before the browser leaves, or the record would lack a frame on a slow machine.
      await this.allFramesRead();
      const read = deliveredFrames(this.get.frames).length;
      if (read !== this.delivered) {
        throw new Error(
          `the GET stream holds ${read} frames, but the server sent ${this.delivered}: the two ` +
            'counts no longer count the same frames (deliveredFrames in surfaces/chat.js)'
        );
      }
      this.get.abort();
      const response = await this.get.done;
      record.getStream = {
        request: { method: 'GET', path: this.path, accept: SSE },
        response: {
          status: response.status,
          headers: response.headers,
          stream: recordedFrames(response.stream ?? [])
        }
      };
    }
    return record;
  }
}

/**
 * The harness records every envelope; with this they also travel on, to the responses of the
 * route, as they do in the product (`routeEnvelope` in `server/sse.js`). The harness puts the
 * delivery of the product back when the recording ends.
 *
 * @param {Object} env - The environment of the recording.
 * @param {(streamId: string, delivered: boolean) => void} [onDelivered] - Called for every envelope.
 */
export function recordAndRoute(env, onDelivered = () => {}) {
  const counters = new Map();
  setEnvelopeDelivery((streamId, envelope) => {
    const seq = (counters.get(streamId) ?? 0) + 1;
    counters.set(streamId, seq);
    env.envelopes.push({ streamId, envelope: { ...envelope, seq } });
    const delivered = routeEnvelope(streamId, envelope);
    onDelivered(streamId, delivered);
    return delivered;
  });
}

/** The id of the interaction a turn raised, from its frames. */
function raisedInteraction(frames, kind) {
  const frame = frames.find(
    f => typeOf(f) === 'interaction/raised' && (!kind || f.data.data?.interaction?.kind === kind)
  );
  if (!frame) {
    throw new Error(
      `no interaction/raised${kind ? ` of kind ${kind}` : ''} among: ${frames.map(typeOf).join(', ')}`
    );
  }
  return frame.data.data.interaction;
}

/**
 * Run a scenario in one position: a server with the chat routes, the chat
 * opened as a browser opens it, and the scenario's steps.
 */
async function runScenario(env, scenario, position) {
  const user = goldenUser(env);
  const chatId = CHAT_ID;
  const session = new ChatSession({
    env,
    port: null,
    position,
    appId: scenario.appId ?? 'desk',
    chatId
  });
  recordAndRoute(env, (streamId, delivered) => {
    if (streamId === chatId && delivered) session.delivered++;
  });
  const server = await startRouteServer({
    user: () => user,
    register: expressApp =>
      registerSessionRoutes(expressApp, { getLocalizedError, DEFAULT_TIMEOUT: 60_000 })
  });
  session.port = server.port;
  try {
    await session.open();
    await scenario.drive(session);
    await env.settle();
    const httpResponse = await session.close();
    return { httpResponse, ...(await readStoredChat(chatId)) };
  } finally {
    await server.close();
  }
}

const SCENARIOS = [
  {
    name: 'plain',
    title: 'A turn without tools: the answer streams and is stored.',
    script: () => [turn.text(['Record ', 'A-1 ', 'is ', 'open.'], { usage: usage(40, 6) })],
    drive: session => session.send({ content: 'What about record A-1?' })
  },
  {
    name: 'one-tool',
    title: 'One tool call: the tool runs on the server and the model answers from its result.',
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text(['Record A-1 ', 'is open.'], { usage: usage(62, 5) })
    ],
    drive: session => session.send({ content: 'Look up record A-1.' })
  },
  {
    name: 'two-tools',
    title: 'Two tool calls in one model answer: both run before the model is asked again.',
    script: () => [
      turn.toolCalls(
        [
          { name: 'lookup', args: { key: 'A-1' } },
          { name: 'lookup', args: { key: 'B-2' } }
        ],
        { usage: usage(44, 16) }
      ),
      turn.text('A-1 and B-2 are open.', { usage: usage(90, 7) })
    ],
    drive: session => session.send({ content: 'Look up records A-1 and B-2.' })
  },
  {
    name: 'approval-approve',
    title:
      'A call that needs approval pauses the turn; the approval runs the call and the model continues.',
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('Record A-1 is closed.', { usage: usage(64, 5) })
    ],
    drive: async session => {
      const paused = await session.send({ content: 'Close record A-1.' });
      const { id: interactionId } = raisedInteraction(paused, 'approval');
      await session.send({
        content: '',
        approvalResponse: { interactionId, decision: 'approve' }
      });
    }
  },
  {
    name: 'approval-deny',
    title: 'A refused approval: the call does not run and the model is told so.',
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.text('I left record A-1 open.', { usage: usage(64, 6) })
    ],
    drive: async session => {
      const paused = await session.send({ content: 'Close record A-1.' });
      const { id: interactionId } = raisedInteraction(paused, 'approval');
      await session.send({
        content: '',
        approvalResponse: { interactionId, decision: 'reject' }
      });
    }
  },
  {
    name: 'approval-pause-continue',
    title:
      'A paused turn is continued as the same run; "allow for this chat" lets the next call of the tool run without a pause.',
    script: () => [
      turn.toolCalls([{ name: 'dangerous', args: { key: 'A-1' } }], { usage: usage(40, 8) }),
      turn.toolCalls([{ name: 'dangerous', args: { key: 'B-2' } }], { usage: usage(64, 8) }),
      turn.text('Records A-1 and B-2 are closed.', { usage: usage(88, 8) })
    ],
    drive: async session => {
      const paused = await session.send({ content: 'Close records A-1 and B-2.' });
      const { id: interactionId } = raisedInteraction(paused, 'approval');
      await session.send({
        content: '',
        approvalResponse: { interactionId, decision: 'approve', grant: 'chat' }
      });
    }
  },
  {
    name: 'connect-resume',
    title:
      'A call stops on a missing connection; after the connect the stored call runs again without a new message.',
    script: () => [
      turn.toolCalls([{ name: 'tracker', args: { query: 'printer' } }], { usage: usage(40, 8) }),
      turn.text('Connect the tracker and I will search it.', { usage: usage(70, 9) }),
      turn.text('TRK-7: the printer is on fire.', { usage: usage(80, 8) })
    ],
    drive: async session => {
      await session.send({ content: 'Search the tracker for the printer.' });
      await session.env.settle();
      const { storedMessage } = await readStoredChat(session.chatId);
      const id = storedMessage.chat?.pendingConnect?.id;
      if (!id) throw new Error('the chat holds no call that waits for a connection');
      await session.send({ content: '', connectResume: { id } });
    }
  },
  {
    name: 'question-pause-resume',
    title: 'The model asks the user a question; the answer continues the paused run.',
    script: () => [
      turn.toolCalls(
        [
          {
            name: 'ask_user',
            args: {
              question: 'Which record do you mean?',
              input_type: 'select',
              options: [
                { label: 'A-1', value: 'A-1' },
                { label: 'B-2', value: 'B-2' }
              ]
            }
          }
        ],
        { usage: usage(40, 12) }
      ),
      turn.text('Record B-2 is open.', { usage: usage(70, 6) })
    ],
    drive: async session => {
      const paused = await session.send({ content: 'Is the record open?' });
      const { id: interactionId } = raisedInteraction(paused, 'question');
      await session.send({
        content: 'B-2',
        clarificationResponse: { interactionId, value: 'B-2' }
      });
    }
  },
  {
    name: 'structured-output',
    appId: 'form',
    title: 'An app with an output schema: the model is asked for JSON of that schema.',
    script: () => [turn.text('{"key":"A-1","open":true}', { usage: usage(52, 9) })],
    drive: session => session.send({ content: 'Fill in the form for record A-1.' })
  },
  {
    name: 'compaction',
    title:
      'A long tool loop passes the compaction threshold: older tool results are condensed into notes and the turn goes on.',
    script: () => [
      turn.toolCalls([{ name: 'archive', args: { volume: '1' } }], { usage: usage(900, 10) }),
      turn.toolCalls([{ name: 'archive', args: { volume: '2' } }], { usage: usage(9_000, 10) }),
      turn.toolCalls([{ name: 'archive', args: { volume: '3' } }], { usage: usage(17_500, 10) }),
      // The notes for the oldest result: one summary call.
      turn.text('FACT | r1 | Volume 1: lists record A-1; owner; day opened; changes in order', {
        usage: usage(8_000, 20)
      }),
      turn.text('Three volumes list record A-1.', { usage: usage(9_500, 8) })
    ],
    drive: session => session.send({ content: 'Read volumes 1 to 3 of the archive.' })
  },
  {
    name: 'model-error',
    title: 'The provider answers with an error: the run ends as failed and the error is stored.',
    script: () => [turn.error(400, { error: { message: 'The request was refused', code: 'bad' } })],
    drive: session => session.send({ content: 'What about record A-1?' })
  },
  {
    name: 'user-stop',
    title: 'The user stops the turn while the model is answering.',
    script: () => [turn.hang()],
    drive: async session => {
      const { ended } = session.post({ content: 'What about record A-1?' });
      await session.env.model.waitForCall(1);
      await session.stop();
      await ended;
    }
  },
  {
    name: 'temporary-chat',
    title: 'A temporary chat: the turn is answered and stored as a chat that is not kept.',
    script: () => [turn.text('Record A-1 is open.', { usage: usage(40, 6) })],
    drive: session => session.send({ content: 'What about record A-1?' }, { ephemeral: true })
  },
  {
    name: 'superseded-turn',
    title: 'A second message while the first is being answered: the first turn is replaced.',
    script: () => [turn.hang(), turn.text('Record B-2 is open.', { usage: usage(46, 6) })],
    drive: async session => {
      const first = session.post({ content: 'What about record A-1?' });
      await session.env.model.waitForCall(1);
      await session.send({ content: 'No, record B-2.' });
      await first.ended;
    }
  }
];

/** The chat cases: every scenario in both positions of `chatPostStream`. */
export const chatCases = SCENARIOS.flatMap(scenario =>
  POSITIONS.map(position =>
    defineCase({
      surface: 'chat',
      name: `${scenario.name}${position.suffix}`,
      title: `${scenario.title} (${position.key === 'post' ? 'POST stream' : 'GET stream'})`,
      config: () => chatConfig(scenario.config),
      script: scenario.script,
      run: env => runScenario(env, scenario, position)
    })
  )
);
