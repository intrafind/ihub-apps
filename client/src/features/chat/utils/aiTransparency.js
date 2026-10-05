/**
 * EU AI Act Art. 50 transparency rules for the chat surfaces — pure functions,
 * no React, no network, so every decision the chat UI makes about the AI
 * disclosure is unit-testable in one place
 * (`tests/unit/client/chat-ai-transparency.test.jsx`).
 *
 * Inputs are the two views the server hands the browser (see
 * `server/services/provenance/clientConfig.js`):
 *
 * - `aiConfig` — `platformConfig.aiTransparency` from `GET /api/configs/platform`:
 *   `{ enabled, interactionDisclosure: { enabled, firstTurnNotice, persistentBadge,
 *   reminderInterval }, labels: { messageBadge, outbound, … }, provider: { legalEntity } }`.
 *   Every switch in it is already resolved server-side (feature flag, platform
 *   setting), so the client only reads booleans and never re-derives defaults.
 * - `app.aiTransparency` — the effective per-app view from `GET /api/apps/:id`:
 *   `{ disclosure: boolean, sensitive?, reminderInterval?, firstTurnNotice?, … }`.
 *   `disclosure` is false only when an admin of THIS installation opted out.
 *
 * Concept: `concepts/2026-09-27 EU AI Act Content Marking.md` §2.3, §6 (1–2, 9).
 *
 * @module features/chat/utils/aiTransparency
 */
import { SENSITIVE_CATEGORIES } from '../../../../../shared/aiTransparency.js';

/**
 * The link target of every "Verify content" action. The detection page is
 * served by the web app; surfaces without the app's router (the Office task
 * pane) open it in a new tab.
 */
export const VERIFY_PATH = '/verify';

/**
 * Which parts of the Art. 50(1) interaction disclosure apply to one app.
 *
 * The disclosure applies when the platform has it on and the app has not been
 * opted out (`app.aiTransparency.disclosure === false`). Without a loaded
 * platform config nothing is shown: the chat renders after the config has
 * arrived, so this only affects surfaces that have no config at all.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @param {Object|null|undefined} app - App as the chat client receives it
 * @returns {{ active: boolean, firstTurnNotice: boolean, persistentBadge: boolean }}
 * @example
 * getInteractionDisclosure(
 *   { interactionDisclosure: { enabled: true, firstTurnNotice: true, persistentBadge: false } },
 *   { aiTransparency: { disclosure: true } }
 * ); // → { active: true, firstTurnNotice: true, persistentBadge: false }
 */
export function getInteractionDisclosure(aiConfig, app) {
  const disclosure = aiConfig?.interactionDisclosure;
  const appOptedOut = app?.aiTransparency?.disclosure === false;
  const active = disclosure?.enabled === true && !appOptedOut;
  return {
    active,
    firstTurnNotice: active && Boolean(disclosure.firstTurnNotice),
    persistentBadge: active && Boolean(disclosure.persistentBadge)
  };
}

/**
 * Whether assistant messages carry the "AI generated" chip.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @returns {boolean}
 */
export function isMessageBadgeEnabled(aiConfig) {
  return aiConfig?.labels?.messageBadge === true;
}

/**
 * Whether a page should show its top-level AI label (public shared chats).
 * Fail-safe on purpose: while the config is unknown the label is shown, and
 * only an installation that has the transparency features switched off
 * (`enabled: false`) hides it.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @returns {boolean}
 */
export function isAiLabelShownByDefault(aiConfig) {
  return aiConfig?.enabled !== false;
}

/**
 * The legal entity that operates this installation, for the " operated by X"
 * suffix of the first-turn notice.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @returns {string} Trimmed name, or '' when none is configured
 */
export function getProviderLegalEntity(aiConfig) {
  const name = aiConfig?.provider?.legalEntity;
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * The periodic-reminder settings of a sensitive app (guidelines ¶40), or null
 * when the app gets no reminders.
 *
 * Reminders are part of the Art. 50(1) disclosure: an app whose disclosure is
 * off (platform-wide or opted out) gets none. The interval comes from the app
 * (`app.aiTransparency.reminderInterval`) and falls back to the platform
 * default; `0` disables reminders.
 *
 * @param {Object|null|undefined} aiConfig - `platformConfig.aiTransparency`
 * @param {Object|null|undefined} app - App as the chat client receives it
 * @returns {{ category: string, interval: number }|null}
 * @example
 * getReminderSettings(
 *   { interactionDisclosure: { enabled: true, reminderInterval: 5 } },
 *   { aiTransparency: { disclosure: true, sensitive: 'health', reminderInterval: 3 } }
 * ); // → { category: 'health', interval: 3 }
 */
export function getReminderSettings(aiConfig, app) {
  const block = app?.aiTransparency;
  const category = block?.sensitive;
  if (!category || !SENSITIVE_CATEGORIES.includes(category)) return null;
  if (!getInteractionDisclosure(aiConfig, app).active) return null;
  const raw = block.reminderInterval ?? aiConfig?.interactionDisclosure?.reminderInterval;
  const interval = Number(raw);
  if (!Number.isInteger(interval) || interval <= 0) return null;
  return { category, interval };
}

/**
 * Whether a message is an answer of the AI system for counting purposes:
 * assistant messages that are not errors and not the app's greeting.
 *
 * @param {Object} message - Chat message
 * @returns {boolean}
 */
function isCountedAnswer(message) {
  return message?.role === 'assistant' && message.error !== true && !message.isGreeting;
}

/**
 * The ids of the assistant messages that get a reminder below them: every
 * `interval`-th answer. A message still streaming is counted (so the rhythm
 * does not shift once it finishes) but gets its reminder only when it is done.
 *
 * Derived from the rendered list on every render — never stored with the
 * messages, so changing the interval re-flows the reminders of an open chat.
 *
 * @param {Array<Object>} messages - Messages in display order
 * @param {number} interval - Show a reminder after every Nth answer (>= 1)
 * @returns {Set<string>} Message ids
 * @example
 * getReminderMessageIds([{ id: 'a', role: 'assistant' }, { id: 'b', role: 'assistant' }], 2);
 * // → Set { 'b' }
 */
export function getReminderMessageIds(messages, interval) {
  const ids = new Set();
  if (!Array.isArray(messages) || !Number.isInteger(interval) || interval <= 0) return ids;
  let ordinal = 0;
  for (const message of messages) {
    if (!isCountedAnswer(message)) continue;
    ordinal += 1;
    if (ordinal % interval === 0 && !message.loading && message.id !== undefined) {
      ids.add(message.id);
    }
  }
  return ids;
}

/**
 * The marking status of an answer, from its public provenance record, reduced
 * to what the second layer of the "AI generated" chip explains.
 *
 * @param {Object|null|undefined} provenance - `message.provenance`
 * @returns {{ status: 'marked-vllm'|'marked-upstream'|'marked'|'unmarked'|'not-required'|'exempt'|'unknown',
 *   vendor: string|null, tokens: number|null, reason: string|null }}
 * @example
 * describeTextMarking({ marking: { status: 'marked', technique: 'upstream:google' } });
 * // → { status: 'marked-upstream', vendor: 'google', tokens: null, reason: null }
 */
export function describeTextMarking(provenance) {
  const marking = provenance?.marking;
  const tokens = Number.isFinite(marking?.tokens) ? marking.tokens : null;
  const reason = typeof marking?.reason === 'string' ? marking.reason : null;
  const base = { vendor: null, tokens, reason };
  if (!marking || typeof marking !== 'object') return { ...base, status: 'unknown' };
  const technique = typeof marking.technique === 'string' ? marking.technique : '';
  switch (marking.status) {
    case 'marked':
      if (technique === 'vllm-gumbel') return { ...base, status: 'marked-vllm' };
      if (technique.startsWith('upstream:')) {
        return { ...base, status: 'marked-upstream', vendor: technique.slice('upstream:'.length) };
      }
      return { ...base, status: 'marked' };
    case 'unmarked':
      return { ...base, status: 'unmarked' };
    case 'not-required':
      return { ...base, status: 'not-required' };
    case 'exempt':
      return { ...base, status: 'exempt' };
    default:
      return { ...base, status: 'unknown' };
  }
}

/**
 * The provenance of one generated image. The image itself carries it (live
 * SSE payload and stored artifact descriptor); for older transcripts the
 * answer's record lists its images, matched by hash, content id or position.
 *
 * @param {Object} image - Image as the message carries it
 * @param {Object|null|undefined} messageProvenance - `message.provenance`
 * @param {number} index - Position of the image in the message
 * @returns {Object|null} `{ contentId?, sha256?, markings: string[], conforming? }` or null
 */
export function findImageProvenance(image, messageProvenance, index) {
  if (image?.provenance && typeof image.provenance === 'object') return image.provenance;
  const list = Array.isArray(messageProvenance?.images) ? messageProvenance.images : [];
  if (list.length === 0) return null;
  const byHash = image?.sha256 ? list.find(entry => entry?.sha256 === image.sha256) : null;
  if (byHash) return byHash;
  const byContentId = image?.contentId
    ? list.find(entry => entry?.contentId === image.contentId)
    : null;
  if (byContentId) return byContentId;
  return list[index] || null;
}

/**
 * The markings of a generated image, normalised for the "AI generated" label.
 *
 * @param {Object|null|undefined} provenance - Image provenance
 * @returns {{ markings: string[], contentCredentials: boolean }}
 */
export function describeImageMarkings(provenance) {
  const markings = Array.isArray(provenance?.markings)
    ? provenance.markings.filter(m => typeof m === 'string' && m)
    : [];
  return { markings, contentCredentials: markings.includes('c2pa') };
}
