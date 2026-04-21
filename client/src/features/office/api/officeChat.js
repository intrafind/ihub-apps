import { authenticatedFetch } from './officeAuth';

const CHAT_ID_PREFIX = 'chat-';

export function createChatId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${CHAT_ID_PREFIX}${crypto.randomUUID()}`;
  }
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return `${CHAT_ID_PREFIX}${hex}`;
}

function chatUrl(config, appId, chatId) {
  const a = encodeURIComponent(appId);
  const c = encodeURIComponent(chatId);
  return `${config.baseUrl}/api/apps/${a}/chat/${c}`;
}

function chatStopUrl(config, appId, chatId) {
  return `${chatUrl(config, appId, chatId)}/stop`;
}

export async function postChatStop(config, { appId, chatId, signal }) {
  const res = await authenticatedFetch(config, chatStopUrl(config, appId, chatId), {
    method: 'POST',
    headers: { Accept: 'application/json, text/plain, */*' },
    signal
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const err = new Error((json && json.message) || text || `Chat stop failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json ?? { raw: text };
}

export async function openChatSseResponse(config, { appId, chatId, signal }) {
  const res = await authenticatedFetch(config, chatUrl(config, appId, chatId), {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal
  });

  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {}
    const err = new Error((body && body.message) || `SSE open failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  if (!res.body) {
    throw new Error('SSE response has no body');
  }

  return res;
}

export function readChatSseStream(body, onEvent, signal, onConnectionClosed) {
  return parseSseStream(body, onEvent, signal).finally(() => {
    onConnectionClosed?.();
  });
}

async function parseSseStream(body, onEvent, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  const dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      currentEvent = '';
      return;
    }
    const raw = dataLines.join('\n');
    dataLines.length = 0;
    let payload = raw;
    try {
      payload = JSON.parse(raw);
    } catch {}
    const name =
      currentEvent ||
      (payload && typeof payload === 'object' && typeof payload.event === 'string'
        ? payload.event
        : '');
    if (name) {
      onEvent(name, typeof payload === 'object' && payload !== null ? payload : { raw });
    }
    currentEvent = '';
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) {
      flushEvent();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (let line of parts) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line === '') {
        flushEvent();
      }
    }
  }
}

function extractTextFromGeminiCandidates(o) {
  if (!o || typeof o !== 'object') return null;
  const tryBlock = root => {
    const candidates = root?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    const texts = [];
    let sawText = false;
    for (const part of parts) {
      if (!part || typeof part.text !== 'string') continue;
      sawText = true;
      if (part.thought === true) continue;
      texts.push(part.text);
    }
    if (texts.length) return texts.join('\n\n');
    if (sawText) return '';
    return null;
  };
  const a = tryBlock(o);
  if (a !== null && a !== undefined) return a;
  if (o.data) return tryBlock(o.data);
  return null;
}

export function extractChatReply(json) {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (typeof json !== 'object') return String(json);

  const geminiText = extractTextFromGeminiCandidates(json);
  if (geminiText !== null) return geminiText;

  const o = json;
  if (typeof o.content === 'string') return o.content;
  if (typeof o.message === 'string') return o.message;
  if (typeof o.text === 'string') return o.text;
  if (typeof o.response === 'string') return o.response;
  if (typeof o.answer === 'string') return o.answer;

  if (o.data && typeof o.data === 'object') {
    const d = o.data;
    if (typeof d.content === 'string') return d.content;
    if (typeof d.message === 'string') return d.message;
    if (typeof d.text === 'string') return d.text;
  }

  if (Array.isArray(o.messages) && o.messages.length) {
    const last = o.messages[o.messages.length - 1];
    if (last && typeof last.content === 'string') return last.content;
  }

  if (Array.isArray(o.choices) && o.choices[0]) {
    const c0 = o.choices[0];
    if (typeof c0 === 'string') return c0;
    if (c0.message && typeof c0.message.content === 'string') {
      return c0.message.content;
    }
    if (typeof c0.text === 'string') return c0.text;
  }

  try {
    return JSON.stringify(o);
  } catch {
    return '';
  }
}

export async function postChatMessage(config, { appId, chatId, body, signal }) {
  const res = await authenticatedFetch(config, chatUrl(config, appId, chatId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const err = new Error((json && json.message) || text || `Chat POST failed (${res.status})`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json ?? { raw: text };
}
