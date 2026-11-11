// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin side of the Website Corpus' internal hosts.
 *
 * The SSRF guard refuses company-internal addresses. A user whose crawl was
 * refused asks for the host (the `website_corpus_request_domain` tool); an admin
 * works the queue here, or adds a host directly (a wildcard such as
 * `*.corp.example` is allowed for an admin):
 *
 *   GET    /api/admin/website-corpus/domains                  { items, nextCursor, openCount }
 *   POST   /api/admin/website-corpus/domains                  { host, note? } → 201, the host approved
 *   POST   /api/admin/website-corpus/domains/{id}/_approve    { note? }
 *   POST   /api/admin/website-corpus/domains/{id}/_decline    { note? }
 *   DELETE /api/admin/website-corpus/domains/{id}             → 204, an approval withdrawn or a decision forgotten
 *
 * An approval lets the Website Corpus reach that host's company-internal
 * address; it does not touch `ssrf.allowedHosts`, so `read_url` and the
 * workflows keep the public-addresses-only rule. Every change is audited.
 *
 * @module routes/admin/websiteCorpusDomains
 */
import { buildServerPath } from '../../utils/basePath.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { logAudit } from '../../services/AuditLogService.js';
import {
  DOMAIN_STATUSES,
  DomainError,
  getDomainStore,
  isDomainId
} from '../../services/websiteCorpus/DomainStore.js';

const BASE = '/api/admin/website-corpus/domains';

/** A store error as the API's error: a registry code, never a new one. */
function asServiceError(error) {
  if (!(error instanceof DomainError)) return error;
  const code = {
    NOT_FOUND: 'NOT_FOUND',
    STORAGE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
  }[error.code];
  return new ServiceError(code || 'VALIDATION_FAILED', error.message);
}

/** Run a store call, answering its failures as API errors. */
async function guarded(call) {
  try {
    return await call();
  } catch (error) {
    throw asServiceError(error);
  }
}

function idOf(req) {
  if (!isDomainId(req.params.id)) throw new ServiceError('NOT_FOUND', 'No such website');
  return req.params.id;
}

/** `note` of the body: optional text; the store bounds its length. */
function noteOf(req) {
  const note = req.body?.note;
  if (note === undefined || note === null) return undefined;
  if (typeof note !== 'string') throw new ServiceError('VALIDATION_FAILED', 'note must be text');
  return note;
}

function audit(req, action, entry, verb) {
  logAudit({
    req,
    action,
    resource: 'websiteCorpusDomain',
    resourceId: entry.id,
    summary: `${verb} "${entry.host}" for the Website Corpus`
  });
}

export default function registerAdminWebsiteCorpusDomainRoutes(app) {
  /**
   * @swagger
   * /api/admin/website-corpus/domains:
   *   get:
   *     summary: Internal websites users asked for, and the ones approved or declined
   *     tags:
   *       - Admin - Integrations
   *     parameters:
   *       - { in: query, name: limit, schema: { type: integer, maximum: 200 } }
   *       - { in: query, name: cursor, schema: { type: string } }
   *     responses:
   *       200: { description: "{ items, nextCursor, openCount }; open requests first" }
   */
  app.get(buildServerPath(BASE), adminAuth, async (req, res) => {
    const store = getDomainStore();
    const page = await guarded(() =>
      store.list({
        limit: Number.parseInt(req.query.limit, 10) || undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null
      })
    );
    const openCount = await guarded(() => store.openCount());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: page.items, nextCursor: page.nextCursor, openCount });
  });

  /**
   * @swagger
   * /api/admin/website-corpus/domains:
   *   post:
   *     summary: Allow an internal website without a request
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       201: { description: The host, approved }
   *       400: { description: The host is not valid }
   */
  app.post(buildServerPath(BASE), adminAuth, async (req, res) => {
    const host = req.body?.host;
    if (typeof host !== 'string') throw new ServiceError('VALIDATION_FAILED', 'host must be text');
    const entry = await guarded(() =>
      getDomainStore().addApproved({ host, admin: req.user, note: noteOf(req) })
    );
    audit(req, 'create', entry, 'Allowed');
    res
      .status(201)
      .set('Location', buildServerPath(`${BASE}/${entry.id}`))
      .json(entry);
  });

  /**
   * @swagger
   * /api/admin/website-corpus/domains/{id}/_approve:
   *   post:
   *     summary: Approve a request; the Website Corpus may reach the host
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200: { description: The entry }
   *       404: { description: No such request }
   */
  app.post(buildServerPath(`${BASE}/:id/_approve`), adminAuth, async (req, res) => {
    const id = idOf(req);
    const entry = await guarded(() =>
      getDomainStore().decide(id, {
        decision: DOMAIN_STATUSES.APPROVED,
        admin: req.user,
        note: noteOf(req)
      })
    );
    audit(req, 'requestDecision', entry, 'Approved');
    res.json(entry);
  });

  /**
   * @swagger
   * /api/admin/website-corpus/domains/{id}/_decline:
   *   post:
   *     summary: Decline a request, or withdraw an approval
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       200: { description: The entry }
   *       404: { description: No such request }
   */
  app.post(buildServerPath(`${BASE}/:id/_decline`), adminAuth, async (req, res) => {
    const id = idOf(req);
    const entry = await guarded(() =>
      getDomainStore().decide(id, {
        decision: DOMAIN_STATUSES.DECLINED,
        admin: req.user,
        note: noteOf(req)
      })
    );
    audit(req, 'requestDecision', entry, 'Declined');
    res.json(entry);
  });

  /**
   * @swagger
   * /api/admin/website-corpus/domains/{id}:
   *   delete:
   *     summary: Remove an entry; an approval is withdrawn, a decision forgotten
   *     tags:
   *       - Admin - Integrations
   *     responses:
   *       204: { description: Removed }
   *       404: { description: No such entry }
   */
  app.delete(buildServerPath(`${BASE}/:id`), adminAuth, async (req, res) => {
    const id = idOf(req);
    const store = getDomainStore();
    const entry = await guarded(() => store.get(id));
    if (!entry) throw new ServiceError('NOT_FOUND', 'No such website');
    await guarded(() => store.remove(id));
    audit(req, 'delete', entry, 'Removed');
    res.status(204).end();
  });
}
