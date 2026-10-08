/**
 * Message protocol between the Outlook task pane and the chat it popped out
 * into an Office dialog (`Office.context.ui.displayDialogAsync`).
 *
 * The dialog is a separate window with almost no Office.js of its own: it can
 * call `Office.context.ui.messageParent` and nothing that reaches the mailbox.
 * So the pane stays open behind it as its gateway to Outlook — the dialog asks
 * the pane for the open email, to run an answer action, for a fresh token —
 * and the pane tells the dialog when the user selects a different item.
 *
 * Both directions carry plain strings (`messageParent` / `messageChild`), so
 * this module is transport-agnostic: an endpoint gets a `send(string)` and is
 * fed every incoming string through `receive(string)`. That keeps it testable
 * without Office.js — two endpoints wired to each other are the whole system.
 *
 * Three kinds of envelope, all tagged `ihub: 'popout'` so stray messages (a
 * sign-in callback, another add-in's) are ignored:
 *
 *   req  { id, m, p }        a call the other side answers
 *   res  { id, ok, p | e }   its answer: a payload, or an error message
 *   evt  { m, p }            a one-way notification
 *
 * Office documents no size limit for these messages, and an email with a few
 * attachments is megabytes of base64. Anything longer than `chunkSize` is
 * therefore split into `part` envelopes (`{ cid, i, n, d }`) and reassembled
 * on arrival, in whatever order the parts come in.
 */

const TAG = 'popout';
const VERSION = 1;

/** Characters per message. Conservative: no host documents its limit. */
export const DEFAULT_CHUNK_SIZE = 32 * 1024;

/** How long a call waits for its answer before failing. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;

/** Error message of a call the other side did not answer in time. */
export const BRIDGE_TIMEOUT_MESSAGE = 'The Outlook pane did not answer.';

/** A chunked message whose parts stop arriving is dropped after this long. */
export const PARTIAL_TTL_MS = 2 * 60 * 1000;

/** Error message of a call made after the endpoint was disposed. */
export const BRIDGE_CLOSED_MESSAGE = 'The connection to the Outlook pane is closed.';

let idCounter = 0;
const nextId = prefix => `${prefix}${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function parseEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const envelope = JSON.parse(raw);
    return envelope && envelope.ihub === TAG && envelope.v === VERSION ? envelope : null;
  } catch {
    return null;
  }
}

/**
 * Create one side of the bridge.
 *
 * @param {object} options
 * @param {(message: string) => void} options.send - Hands a string to the transport.
 * @param {Record<string, (payload: any) => any>} [options.handlers] - Answers the
 *   other side's calls, by method name. May return a promise; a throw or a
 *   rejection is answered as an error.
 * @param {(name: string, payload: any) => void} [options.onEvent] - Receives the
 *   other side's notifications.
 * @param {number} [options.chunkSize] - Longest string handed to `send`.
 * @param {number} [options.timeoutMs] - Default time a call waits for its answer.
 * @returns {{
 *   receive: (raw: string) => void,
 *   request: (method: string, payload?: any, options?: { timeoutMs?: number }) => Promise<any>,
 *   emit: (name: string, payload?: any) => void,
 *   dispose: () => void
 * }}
 */
export function createPopoutEndpoint({
  send,
  handlers = {},
  onEvent,
  chunkSize = DEFAULT_CHUNK_SIZE,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
}) {
  const pending = new Map();
  const partials = new Map();
  let disposed = false;

  function transmit(envelope) {
    if (disposed) return;
    const raw = JSON.stringify({ ihub: TAG, v: VERSION, ...envelope });
    if (raw.length <= chunkSize) {
      send(raw);
      return;
    }
    // Leave room for the part envelope around each slice.
    const size = Math.max(1024, chunkSize - 200);
    const total = Math.ceil(raw.length / size);
    const cid = nextId('c');
    for (let i = 0; i < total; i++) {
      send(
        JSON.stringify({
          ihub: TAG,
          v: VERSION,
          t: 'part',
          cid,
          i,
          n: total,
          d: raw.slice(i * size, (i + 1) * size)
        })
      );
    }
  }

  async function answer(envelope) {
    const handler = Object.hasOwn(handlers, envelope.m) ? handlers[envelope.m] : null;
    if (typeof handler !== 'function') {
      transmit({ t: 'res', id: envelope.id, ok: false, e: `Unknown method: ${envelope.m}` });
      return;
    }
    try {
      const result = await handler(envelope.p);
      transmit({ t: 'res', id: envelope.id, ok: true, p: result === undefined ? null : result });
    } catch (error) {
      transmit({
        t: 'res',
        id: envelope.id,
        ok: false,
        e: error?.message ? String(error.message) : String(error)
      });
    }
  }

  function dispatch(envelope) {
    switch (envelope.t) {
      case 'req':
        void answer(envelope);
        break;
      case 'res': {
        const call = pending.get(envelope.id);
        if (!call) return;
        pending.delete(envelope.id);
        clearTimeout(call.timer);
        if (envelope.ok) call.resolve(envelope.p);
        else call.reject(new Error(envelope.e || 'Request failed'));
        break;
      }
      case 'evt':
        try {
          onEvent?.(envelope.m, envelope.p);
        } catch (error) {
          console.error('[popout] event handler failed', envelope.m, error);
        }
        break;
      default:
        break;
    }
  }

  function receive(raw) {
    if (disposed) return;
    const envelope = parseEnvelope(raw);
    if (!envelope) return;
    if (envelope.t !== 'part') {
      dispatch(envelope);
      return;
    }
    const { cid, i, n, d } = envelope;
    if (typeof cid !== 'string' || !Number.isInteger(i) || !Number.isInteger(n) || n < 1) return;
    // Parts of a message whose sender went away never complete; drop them.
    const now = Date.now();
    for (const [id, pending] of partials) {
      if (now - pending.startedAt > PARTIAL_TTL_MS) partials.delete(id);
    }
    let entry = partials.get(cid);
    if (!entry) {
      entry = { parts: new Array(n), received: 0, startedAt: now };
      partials.set(cid, entry);
    }
    if (i < 0 || i >= entry.parts.length || entry.parts[i] !== undefined) return;
    entry.parts[i] = typeof d === 'string' ? d : '';
    entry.received += 1;
    if (entry.received < entry.parts.length) return;
    partials.delete(cid);
    const whole = parseEnvelope(entry.parts.join(''));
    if (whole && whole.t !== 'part') dispatch(whole);
  }

  function request(method, payload, options = {}) {
    if (disposed) return Promise.reject(new Error(BRIDGE_CLOSED_MESSAGE));
    const id = nextId('r');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(BRIDGE_TIMEOUT_MESSAGE));
      }, options.timeoutMs ?? timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        transmit({ t: 'req', id, m: method, p: payload === undefined ? null : payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function emit(name, payload) {
    transmit({ t: 'evt', m: name, p: payload === undefined ? null : payload });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(BRIDGE_CLOSED_MESSAGE));
    }
    pending.clear();
    partials.clear();
  }

  return { receive, request, emit, dispose };
}
