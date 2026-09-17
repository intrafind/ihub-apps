/**
 * The start page heading.
 *
 * By default it is the time-based greeting with the viewer's name — "Good
 * morning, Ada!". Installations whose directory has no presentable names (an
 * id, an email local part, an empty field) can turn the name off or replace
 * the whole heading with a fixed message, via `ui.json → startPage`:
 *
 * - `showUserName` — include the viewer's name (default `true`).
 * - `title`        — localized heading that replaces the built-in greeting.
 *                    `{{greeting}}` is the time-based greeting, `{{name}}` the
 *                    viewer's name.
 *
 * With no name to show, a `{{name}}` placeholder is dropped along with the
 * separator in front of it, so "Good morning, {{name}}!" reads "Good morning!"
 * rather than "Good morning, !".
 */

import { getLocalizedContent } from './localizeContent';

const GREETING_PLACEHOLDER = /\{\{\s*greeting\s*\}\}/g;
const NAME_PLACEHOLDER = /\{\{\s*name\s*\}\}/g;
/** A `{{name}}` placeholder together with any separator leading into it. */
const NAME_WITH_SEPARATOR = /[,;:–—-]?[ \t]*\{\{\s*name\s*\}\}/g;

/** The greeting for the current time of day, localized. */
export function timeBasedGreeting(t, now = new Date()) {
  const h = now.getHours();
  if (h < 12) return t('startPage.greetingMorning', 'Good morning');
  if (h < 18) return t('startPage.greetingAfternoon', 'Good afternoon');
  return t('startPage.greetingEvening', 'Good evening');
}

/**
 * The name to greet the viewer with — an empty string when there is none to
 * show. Anonymous visitors carry a synthetic "Anonymous" name, so they are
 * greeted without one whatever the configuration says.
 *
 * @param {object} user - The viewer (`useAuth().user`).
 * @param {boolean} showUserName - Whether the name may be shown at all.
 * @returns {string} The name, or '' when none should be shown.
 */
export function resolveGreetingName(user, showUserName = true) {
  if (showUserName === false) return '';
  if (!user || user.id === 'anonymous') return '';
  const name = user.name || user.email?.split('@')[0] || '';
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * Fill a custom heading template.
 *
 * @param {string} template - The admin-configured heading.
 * @param {{ greeting?: string, name?: string }} values - Placeholder values.
 * @returns {string} The heading, or '' when the template yields nothing.
 */
export function renderGreetingTemplate(template, { greeting = '', name = '' } = {}) {
  if (typeof template !== 'string') return '';
  // Replacer functions, so a `$&` in a name or greeting stays literal.
  const filled = template
    .replace(GREETING_PLACEHOLDER, () => greeting)
    .replace(name ? NAME_PLACEHOLDER : NAME_WITH_SEPARATOR, () => name);
  // Removing a placeholder can leave a double space behind.
  return filled.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * The heading the start page shows.
 *
 * @param {object} options
 * @param {object} options.startPage - `uiConfig.startPage`.
 * @param {object} options.user - The viewer (`useAuth().user`).
 * @param {string} options.language - The active UI language.
 * @param {Function} options.t - The i18n translate function.
 * @param {Date} [options.now] - Injectable clock, for tests.
 * @returns {string} The heading text.
 */
export function buildStartPageGreeting({ startPage, user, language, t, now } = {}) {
  const greeting = timeBasedGreeting(t, now);
  const name = resolveGreetingName(user, startPage?.showUserName !== false);

  // A configured title replaces the greeting entirely — unless it renders
  // empty (a blank field, or only a `{{name}}` nobody has), which would leave
  // the page with no heading at all.
  const custom = renderGreetingTemplate(getLocalizedContent(startPage?.title, language), {
    greeting,
    name
  });
  if (custom) return custom;

  // Punctuation and name placement are locale-specific — keep them translatable.
  return name
    ? t('startPage.greetingWithName', '{{greeting}}, {{name}}!', { greeting, name })
    : t('startPage.greetingNoName', '{{greeting}}!', { greeting });
}
