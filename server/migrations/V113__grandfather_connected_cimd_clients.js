/**
 * Migration V113 — Approve the CIMD clients people are already connected through
 *
 * V112 turns the approval gate on by default. Without this migration, the
 * release that ships it would refuse every client an installation's users are
 * already using, because none of them has a policy record — an upgrade would
 * disconnect everyone at once.
 *
 * So: read the consent store, and write an approved, active policy record for
 * every distinct client-metadata `client_id` that already has at least one
 * live connection. `approvedBy: 'migration'` and a `firstSeenAt` derived from
 * the earliest grant say plainly where the decision came from.
 *
 * Clients nobody has connected through are deliberately **not** created. They
 * are exactly the ones that should have to be approved, and an administrator's
 * first visit to the Clients page should show the clients their users actually
 * use — not a list seeded with software nobody asked for.
 *
 * Only identity-free policy is written: no `client_name`, no `redirect_uris`,
 * no `grant_types`. Those keep coming from the document on every request, which
 * is the property that makes CIMD "nothing stored" in the first place. The one
 * exception is `metadata.displayName`, a display snapshot for the admin list,
 * which no authorization decision reads.
 */

export const version = '113';
export const description = 'Approve client-metadata clients that already have connections';

const CONSENT_PATH = 'data/oauth-consent.json';
const CLIENTS_PATH = 'config/oauth-clients.json';

export async function precondition(ctx) {
  // No consent store means nobody has connected anything: there is nothing to
  // grandfather, and the gate starts clean.
  return (await ctx.fileExists(CONSENT_PATH)) && (await ctx.fileExists(CLIENTS_PATH));
}

export async function up(ctx) {
  const consentStore = await ctx.readJson(CONSENT_PATH);
  const clientsConfig = await ctx.readJson(CLIENTS_PATH);

  if (!clientsConfig.clients || typeof clientsConfig.clients !== 'object') {
    clientsConfig.clients = {};
  }

  const now = new Date().toISOString();
  const seen = new Map();

  for (const entry of Object.values(consentStore.consents || {})) {
    if (!entry || entry.clientKind !== 'cimd' || !entry.clientId) continue;
    // An expired grant is not a connection, and the admin list does not show
    // it either.
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) continue;

    const existing = seen.get(entry.clientId);
    if (!existing) {
      seen.set(entry.clientId, {
        name: entry.clientName || '',
        host: entry.clientHost || hostOf(entry.clientId),
        firstGrantedAt: entry.grantedAt || null
      });
      continue;
    }
    if (
      entry.grantedAt &&
      (!existing.firstGrantedAt || entry.grantedAt < existing.firstGrantedAt)
    ) {
      existing.firstGrantedAt = entry.grantedAt;
    }
    if (!existing.name && entry.clientName) existing.name = entry.clientName;
  }

  const approved = [];
  for (const [clientId, info] of seen) {
    // A record that already exists carries a decision somebody made. Never
    // overwrite it — an administrator who blocked a client before upgrading
    // must not find it approved afterwards.
    if (Object.hasOwn(clientsConfig.clients, clientId)) continue;

    clientsConfig.clients[clientId] = {
      id: clientId,
      clientId,
      description: `Client metadata document at ${info.host}`,
      clientSecret: null,
      active: true,
      approvalState: 'approved',
      createdAt: info.firstGrantedAt || now,
      createdBy: 'migration',
      lastUsed: null,
      lastRotated: null,
      metadata: {
        cimd: true,
        host: info.host,
        displayName: info.name || info.host,
        firstSeenAt: info.firstGrantedAt || now,
        approvedBy: 'migration',
        approvedAt: now
      },
      clientType: 'public',
      // Locked for every CIMD record: an approved client is not a trusted one,
      // and every user still signs in and consents.
      consentRequired: true,
      trusted: false,
      personal: false
    };
    approved.push(clientId);
  }

  if (approved.length === 0) {
    ctx.log('No connected client-metadata clients to approve');
    return;
  }

  await ctx.writeJson(CLIENTS_PATH, clientsConfig);
  ctx.log(`Approved ${approved.length} already-connected client-metadata client(s)`);
}

/**
 * Hostname of a client id URL, for a consent entry written before the host
 * snapshot existed.
 *
 * @param {string} clientId - CIMD client identifier
 * @returns {string} Hostname, or '' when the value does not parse
 */
function hostOf(clientId) {
  try {
    return new URL(clientId).hostname;
  } catch {
    return '';
  }
}
