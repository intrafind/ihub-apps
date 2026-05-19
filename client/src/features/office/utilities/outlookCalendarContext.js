/* global Office */

/**
 * Calendar / appointment counterpart to outlookMailContext.js.
 *
 * Office.context.mailbox.item exposes Appointment items via the same root
 * but with a different property surface than Message items. The key
 * differences this module handles:
 *
 *   - `subject`, `location`, `start`, `end`, `body` are direct properties
 *     in read mode (AppointmentRead) but are async (`getAsync`) in compose
 *     mode (AppointmentCompose) because both the user and the add-in can
 *     mutate them concurrently.
 *   - `organizer` (an `EmailAddressDetails`) is read-only and only exposes
 *     a sender's name + email — there's no callback flavour needed.
 *   - Attendees are split into `requiredAttendees` and `optionalAttendees`,
 *     both `Array<EmailAddressDetails>` in read mode and `Recipients`
 *     (with `getAsync`) in compose mode.
 *
 * We normalize all of this to a single shape:
 *
 *   {
 *     available: boolean,
 *     itemKind: 'appointment',
 *     mode: 'read' | 'compose',
 *     isOrganizer: boolean,
 *     subject: string|null,
 *     itemId: string|null,
 *     location: string|null,
 *     start: string|null,        // ISO timestamp
 *     end: string|null,          // ISO timestamp
 *     organizer: { name, email } | null,
 *     requiredAttendees: Array<{ name, email }>,
 *     optionalAttendees: Array<{ name, email }>,
 *     bodyText: string|null,
 *     attachments: Array<...>   // kept empty for now; meeting items rarely
 *                                  carry attachments worth round-tripping.
 *   }
 *
 * Shape intentionally extends the mail-context shape (bodyText + attachments)
 * so downstream consumers — useOutlookMailContextSnapshot, the chat adapter
 * — can treat both kinds uniformly when they don't need the calendar fields.
 */

const APPOINTMENT_ITEM_TYPE = 'appointment';

export function isOutlookAppointmentItemAvailable() {
  try {
    if (typeof Office === 'undefined') return false;
    const item = Office.context?.mailbox?.item;
    if (!item) return false;
    const itemType = String(item.itemType || '').toLowerCase();
    return itemType === APPOINTMENT_ITEM_TYPE;
  } catch {
    return false;
  }
}

function toIso(value) {
  if (!value) return null;
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    }
    if (typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeRecipient(r) {
  if (!r) return null;
  const name = typeof r.displayName === 'string' ? r.displayName : null;
  const email = typeof r.emailAddress === 'string' ? r.emailAddress : null;
  if (!name && !email) return null;
  return { name: name || email, email };
}

function normalizeRecipientList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRecipient).filter(Boolean);
}

/**
 * In read mode (AppointmentRead) most fields are plain values. In compose
 * mode (AppointmentCompose) the same fields are `Recipients` / async
 * objects and need `getAsync`. We feature-detect and resolve in both.
 */
function getAsyncOrValue(maybeAsync) {
  return new Promise(resolve => {
    if (maybeAsync == null) {
      resolve(null);
      return;
    }
    if (typeof maybeAsync === 'string' || typeof maybeAsync === 'number') {
      resolve(maybeAsync);
      return;
    }
    if (maybeAsync instanceof Date) {
      resolve(maybeAsync);
      return;
    }
    if (typeof maybeAsync.getAsync === 'function') {
      try {
        maybeAsync.getAsync(result => {
          if (result && result.status === Office.AsyncResultStatus.Succeeded) {
            resolve(result.value);
          } else {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
      return;
    }
    resolve(maybeAsync);
  });
}

function getBodyTextAsync() {
  return new Promise(resolve => {
    const item = Office.context.mailbox.item;
    if (!item || !item.body || typeof item.body.getAsync !== 'function') {
      resolve(null);
      return;
    }
    try {
      item.body.getAsync(Office.CoercionType.Text, result => {
        resolve(
          result?.status === Office.AsyncResultStatus.Succeeded ? (result.value ?? null) : null
        );
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Returns true when the current Outlook session belongs to the meeting
 * organizer. We detect this two ways:
 *   1. The item exposes `appointment.organizer` and that email matches the
 *      user's mailbox profile.
 *   2. We're running in AppointmentCompose mode — only the organizer can
 *      compose a meeting (attendees see read mode).
 */
async function detectIsOrganizer(item, organizer) {
  // Compose mode → user is the organizer.
  if (item && typeof item.requiredAttendees?.setAsync === 'function') return true;

  try {
    const me = Office.context?.mailbox?.userProfile?.emailAddress;
    if (me && organizer?.email) {
      return String(me).toLowerCase() === String(organizer.email).toLowerCase();
    }
  } catch {
    // userProfile can be unavailable in some embed scenarios.
  }
  return false;
}

async function readOrganizer(item) {
  // Read mode: item.organizer is an EmailAddressDetails (plain object).
  // There's no compose-mode flavour — the organizer is whoever is composing.
  if (!item?.organizer) {
    // Compose mode fallback: the current user is the organizer.
    try {
      const profile = Office.context?.mailbox?.userProfile;
      if (profile?.emailAddress) {
        return { name: profile.displayName || profile.emailAddress, email: profile.emailAddress };
      }
    } catch {
      // ignore
    }
    return null;
  }
  return normalizeRecipient(item.organizer);
}

async function readRecipients(recipients) {
  if (!recipients) return [];
  // Read mode: already an Array<EmailAddressDetails>.
  if (Array.isArray(recipients)) return normalizeRecipientList(recipients);
  // Compose mode: Recipients object with getAsync.
  if (typeof recipients.getAsync === 'function') {
    const val = await getAsyncOrValue(recipients);
    return normalizeRecipientList(val);
  }
  return [];
}

export async function fetchCurrentAppointmentContext() {
  if (!isOutlookAppointmentItemAvailable()) {
    return {
      available: false,
      itemKind: 'appointment',
      reason:
        'Not running in Outlook with an appointment item (Office.js item missing or not appointment).',
      attachments: []
    };
  }

  const item = Office.context.mailbox.item;
  // Compose-mode items expose setAsync on their recipient collections; read
  // mode does not. That's the cheapest mode discriminator.
  const isCompose = typeof item.requiredAttendees?.setAsync === 'function';
  const mode = isCompose ? 'compose' : 'read';

  const [
    subjectVal,
    locationVal,
    startVal,
    endVal,
    bodyText,
    organizer,
    requiredAttendees,
    optionalAttendees
  ] = await Promise.all([
    getAsyncOrValue(item.subject),
    getAsyncOrValue(item.location),
    getAsyncOrValue(item.start),
    getAsyncOrValue(item.end),
    getBodyTextAsync(),
    readOrganizer(item),
    readRecipients(item.requiredAttendees),
    readRecipients(item.optionalAttendees)
  ]);

  const isOrganizer = await detectIsOrganizer(item, organizer);

  return {
    available: true,
    itemKind: 'appointment',
    mode,
    isOrganizer,
    subject: typeof subjectVal === 'string' ? subjectVal : null,
    itemId: item.itemId ?? null,
    location: typeof locationVal === 'string' ? locationVal : null,
    start: toIso(startVal),
    end: toIso(endVal),
    organizer,
    requiredAttendees,
    optionalAttendees,
    bodyText,
    // Calendar items can technically carry attachments (e.g. agenda
    // attached to invite). We surface descriptors only — pulling
    // binary content for a meeting prep flow would explode token
    // budgets and the prompts in the meeting-* apps never reference
    // them. Future enhancement if needed.
    attachments: []
  };
}
