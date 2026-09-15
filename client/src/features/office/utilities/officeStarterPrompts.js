import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * The quick-action prompts the task pane offers before the first message —
 * on the start page under the default app's input, and in the chat panel's
 * empty state.
 *
 * An app's own `starterPrompts` win. Without them the admin's Outlook
 * defaults apply (`officeIntegration.starterPrompts`, or the calendar set
 * when the open item is an appointment so nobody sees "Summarize this email"
 * inside a meeting). Default prompts fire on click; an app prompt only when
 * it says `autoSend`.
 *
 * @param {object} options
 * @param {object|null} options.app - The app the prompt will be sent to.
 * @param {object} options.officeConfig - The add-in config (`useOfficeConfig()`).
 * @param {boolean} [options.isAppointment] - Whether the open Outlook item is a meeting.
 * @param {string} options.language - The pane's language.
 * @returns {Array<{ key: string, label: string, subtitle?: string, message: string, autoSend: boolean, raw?: object }>}
 */
export function buildOfficeStarterPrompts({ app, officeConfig, isAppointment = false, language }) {
  if (Array.isArray(app?.starterPrompts) && app.starterPrompts.length > 0) {
    return app.starterPrompts.map((p, idx) => ({
      key: p?.id ?? `${idx}`,
      label: getLocalizedContent(p?.title, language),
      subtitle: getLocalizedContent(p?.description, language),
      message: getLocalizedContent(p?.message, language),
      autoSend: p?.autoSend === true,
      raw: p
    }));
  }

  const configured = isAppointment
    ? officeConfig?.calendarStarterPrompts
    : officeConfig?.starterPrompts;
  const defaults = Array.isArray(configured) ? configured : [];
  return defaults.map((p, idx) => ({
    key: `office-${idx}`,
    label: getLocalizedContent(p?.title, language),
    message: getLocalizedContent(p?.message, language),
    // Default Outlook prompts fire directly on click per product requirements.
    autoSend: true
  }));
}
