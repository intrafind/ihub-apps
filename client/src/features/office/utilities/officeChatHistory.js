/**
 * The task pane's view of the user's stored chats (durable chats).
 *
 * `GET /api/chats` returns the chat documents and nothing else, so everything
 * the pane shows about a chat's app — name, colour, icon — is joined here from
 * the apps the pane offers. That join is also the filter: a chat can only be
 * continued in the pane through its own app, so a chat whose app the pane does
 * not offer (the add-in's app list is restricted, access was revoked, the app
 * was deleted) is left out rather than listed as a dead end. It is still in the
 * web app's history.
 *
 * Pure functions, so the list the start page and the history page render can
 * be tested without either of them.
 */

import { getLocalizedContent } from '../../../utils/localizeContent';
import { CHAT_GROUPS, chatRecencyGroup } from '../../../utils/chatGroups';

/** How many recent chats the start page lists; "All chats" covers the rest. */
export const OFFICE_START_PAGE_CHATS_COUNT = 3;

/**
 * Key of the pane user's list in the shared chat store (`chatListStore`). The
 * pane has no web session, so the key is built from the user it signed in —
 * the OAuth userinfo, whose user id is `sub`.
 *
 * @param {object|null} user - The pane's signed-in user.
 * @returns {string}
 */
export const officeChatsKey = user => `office:${user?.sub ?? user?.id ?? ''}`;

/**
 * Join stored chats with the apps the pane offers, dropping the ones whose app
 * is not among them.
 *
 * @param {object[]} chats - Chat documents, newest activity first.
 * @param {object[]} apps - Apps the pane offers.
 * @param {string} language - Language to localize app names in.
 * @returns {{ id: string, chat: object, app: object, title: string, appName: string }[]}
 *   In the order of `chats`. `title` is empty for a chat that has none yet.
 */
export function resolveOfficeChats(chats, apps, language) {
  const appsById = new Map((Array.isArray(apps) ? apps : []).map(app => [app?.id, app]));
  const rows = [];
  for (const chat of Array.isArray(chats) ? chats : []) {
    const app = chat?.appId ? appsById.get(chat.appId) : null;
    if (!chat?.id || !app) continue;
    rows.push({
      id: chat.id,
      chat,
      app,
      title: typeof chat.title === 'string' ? chat.title.trim() : '',
      appName: getLocalizedContent(app.name, language) || app.id
    });
  }
  return rows;
}

/**
 * Rows whose title or app name contains the query, ignoring case.
 *
 * @param {object[]} rows - Rows from {@link resolveOfficeChats}.
 * @param {string} query - What the user typed.
 * @returns {object[]}
 */
export function filterOfficeChats(rows, query) {
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    row => row.title.toLowerCase().includes(needle) || row.appName.toLowerCase().includes(needle)
  );
}

/**
 * Rows bucketed by recency — Today / Yesterday / Last 7 days / Older — in
 * that order, empty buckets left out. Each bucket keeps the input order.
 *
 * @param {object[]} rows - Rows from {@link resolveOfficeChats}.
 * @param {Date} [now] - Injectable clock.
 * @returns {{ group: string, rows: object[] }[]}
 */
export function groupOfficeChats(rows, now = new Date()) {
  const buckets = new Map(CHAT_GROUPS.map(group => [group, []]));
  for (const row of rows) buckets.get(chatRecencyGroup(row.chat.lastMessageAt, now)).push(row);
  return CHAT_GROUPS.filter(group => buckets.get(group).length > 0).map(group => ({
    group,
    rows: buckets.get(group)
  }));
}

/**
 * Short label for when a chat last moved: the time for a chat from today, the
 * day and month otherwise. Empty when the timestamp is unusable.
 *
 * @param {string} timestamp - Usually `chat.lastMessageAt`.
 * @param {string} language - Locale to format in.
 * @param {Date} [now] - Injectable clock.
 * @returns {string}
 */
export function formatOfficeChatTime(timestamp, language, now = new Date()) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const locale = language || undefined;
  try {
    return chatRecencyGroup(date, now) === 'today'
      ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  } catch {
    return date.toLocaleDateString();
  }
}

/**
 * The web app's address for a stored chat — the route its own history opens,
 * `/apps/:appId/c/:chatId`, so a chat from the pane continues there like any
 * chat started in the browser.
 *
 * `baseUrl` is the deployment's public URL including any base path (the one the
 * add-in signs in against), so a subpath deployment needs no special case.
 *
 * @param {string} baseUrl - Public base URL, e.g. `https://ihub.example.com/ihub`.
 * @param {string} appId - App the chat belongs to.
 * @param {string} chatId - Stored chat id.
 * @returns {string|null} Absolute URL, or null when any part is missing.
 */
export function buildWebChatUrl(baseUrl, appId, chatId) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || !appId || !chatId) return null;
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/apps/${encodeURIComponent(appId)}/c/${encodeURIComponent(chatId)}`;
}

/**
 * The transcript a chat that is not stored hands to the web app ("Open in web
 * app", see `server/routes/chatHandoffs.js`): the user's and the assistant's
 * words, in order, without what only the pane can show — the greeting, a
 * transcript still being recorded, an answer still being written, attachment
 * bytes.
 *
 * The email the chat is about goes along as the first user message's host
 * context, exactly as the pane would send it with the next message — the
 * email body is not part of the transcript (it goes to the model per turn),
 * so without it the browser would continue a discussion of an email it never
 * saw.
 *
 * @param {object[]} messages - The chat's messages, as `useAppChat` holds them.
 * @param {object|null} [hostContext] - `buildHostContext(...)` for the open email.
 * @returns {{ role: 'user'|'assistant', content: string, hostContext?: object }[]}
 */
export function buildHandoffMessages(messages, hostContext = null) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.isGreeting || message.isLiveTranscript || message.loading) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) continue;
    out.push({ role: message.role, content });
  }
  if (hostContext && typeof hostContext === 'object') {
    const first = out.find(message => message.role === 'user');
    if (first) first.hostContext = hostContext;
  }
  return out;
}

/**
 * The web app's address that continues a handed-off chat: the app's own page,
 * which claims the hand-off and opens it as a new chat.
 *
 * @param {string} baseUrl - Public base URL, e.g. `https://ihub.example.com/ihub`.
 * @param {string} appId - App the chat belongs to.
 * @param {string} token - From `createChatHandoff`.
 * @returns {string|null} Absolute URL, or null when any part is missing.
 */
export function buildWebHandoffUrl(baseUrl, appId, token) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim() || !appId || !token) return null;
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/apps/${encodeURIComponent(appId)}?handoff=${encodeURIComponent(token)}`;
}
