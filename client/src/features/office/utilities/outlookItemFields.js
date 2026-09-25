/* global Office */

/**
 * Shared readers for Office.js item fields that come in two flavours: plain
 * values in read mode (MessageRead / AppointmentRead) and async accessor
 * objects with `getAsync` in compose mode. The mail and the calendar context
 * readers both normalize through these helpers so the model always sees the
 * same `{ name, email }` identity shape and ISO timestamps.
 */

export function toIso(value) {
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

/** `EmailAddressDetails` → `{ name, email }`, or null when both are missing. */
export function normalizeRecipient(r) {
  if (!r) return null;
  const name = typeof r.displayName === 'string' ? r.displayName : null;
  const email = typeof r.emailAddress === 'string' ? r.emailAddress : null;
  if (!name && !email) return null;
  return { name: name || email, email };
}

export function normalizeRecipientList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRecipient).filter(Boolean);
}

/**
 * In read mode most fields are plain values. In compose mode the same fields
 * are `Recipients` / async objects and need `getAsync`. We feature-detect and
 * resolve in both.
 */
export function getAsyncOrValue(maybeAsync) {
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

/**
 * Recipient collections: `Array<EmailAddressDetails>` in read mode, a
 * `Recipients` object with `getAsync` in compose mode.
 */
export async function readRecipients(recipients) {
  if (!recipients) return [];
  if (Array.isArray(recipients)) return normalizeRecipientList(recipients);
  if (typeof recipients.getAsync === 'function') {
    const val = await getAsyncOrValue(recipients);
    return normalizeRecipientList(val);
  }
  return [];
}

async function settle(read, fallback = null) {
  try {
    const value = await read();
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * The signed-in Outlook user (`Office.context.mailbox.userProfile`), or null
 * when the profile is unavailable (some embed scenarios, non-Office hosts).
 * Lets the model tell the user's own contributions in a quoted thread apart
 * from everyone else's — the thread may well contain two people with the
 * same first name.
 */
export function readMailboxUserProfile() {
  try {
    const profile = Office.context?.mailbox?.userProfile;
    if (!profile) return null;
    return normalizeRecipient({
      displayName: profile.displayName,
      emailAddress: profile.emailAddress
    });
  } catch {
    return null;
  }
}

/**
 * Sender, recipients and creation time of a message item — read mode, compose
 * mode (Mailbox 1.7+ exposes `from` as an async accessor there) or a loaded
 * multi-select item. Every field degrades to null / [] on its own so one
 * unsupported accessor never hides the others.
 *
 * @returns {Promise<{ from: {name: string, email: string|null}|null,
 *                     to: Array<{name: string, email: string|null}>,
 *                     cc: Array<{name: string, email: string|null}>,
 *                     dateTimeCreated: string|null }>}
 */
export async function readMessageHeaders(item) {
  const empty = { from: null, to: [], cc: [], dateTimeCreated: null };
  if (!item) return empty;

  const [fromVal, to, cc, dateVal] = await Promise.all([
    settle(() => getAsyncOrValue(item.from)),
    settle(() => readRecipients(item.to), []),
    settle(() => readRecipients(item.cc), []),
    settle(() => getAsyncOrValue(item.dateTimeCreated))
  ]);

  // `sender` only differs from `from` for delegate / on-behalf mail; the
  // name people reply to is `from`, so `sender` is just the fallback.
  let from = normalizeRecipient(fromVal);
  if (!from) {
    from = normalizeRecipient(await settle(() => getAsyncOrValue(item.sender)));
  }

  return { from, to, cc, dateTimeCreated: toIso(dateVal) };
}
