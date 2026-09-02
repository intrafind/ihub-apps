/**
 * InteractionService — the one model for every human touchpoint
 * (concept §5.5): `question` (ask_user, human-node input), `approval`
 * (human-node approve/reject, per-tool-call gate), `review`, `notify`.
 *
 * Responsibilities:
 *  - raise(): validate, persist as pending, append `interaction/raised` to the
 *    run's ledger, notify listeners (channels decide how to deliver).
 *  - answer(): validate the answer (options, approver groups, expiry), persist,
 *    append `interaction/answered`, resolve any awaiting promise.
 *  - Durable pending store (`contents/data/run-log/interactions.json`,
 *    debounced atomic writes) so a paused run survives a restart. Persistence
 *    follows the RunLog flag; in-memory behavior is identical either way.
 *  - Cascade: deleting a run removes its interactions (registered as a RunLog
 *    delete hook).
 *
 * C0 ships the skeleton (store + lifecycle + one answer path). C5 moves the
 * chat clarification, workflow `human` node and agent approvals onto it.
 *
 * @module services/loop/InteractionService
 */
import { EventEmitter } from 'events';
import path from 'path';
import crypto from 'crypto';
import { createDebouncedJsonStore } from '../../utils/debouncedJsonStore.js';
import logger from '../../utils/logger.js';
import { RUN_LOG_EVENTS } from '../../../shared/runEvents.js';
import { interactionSchema, interactionAnswerSchema } from './contracts/interaction.js';
import defaultRunLog from './RunLog.js';

export class InteractionError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'InteractionError';
    this.code = code;
    this.status = status;
  }
}

export class InteractionService extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {import('./RunLog.js').RunLog} [opts.runLog]
   * @param {string} [opts.storePath] - override pending-store file (tests)
   * @param {boolean} [opts.persist] - override persistence (defaults to runLog.isEnabled())
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this.runLog = opts.runLog || defaultRunLog;
    this._persistOverride = opts.persist ?? null;
    this._now = opts.now || (() => Date.now());
    this._storePath = opts.storePath || path.join(this.runLog.baseDir, 'interactions.json');
    this._store = createDebouncedJsonStore({
      filePath: this._storePath,
      createDefault: () => ({ version: 1, interactions: {} }),
      saveIntervalMs: opts.saveIntervalMs ?? 500,
      component: 'InteractionService'
    });
    /** @type {Map<string, Object>} in-memory mirror (id → interaction) */
    this._byId = new Map();
    /** @type {Map<string, {resolve:Function, reject:Function}>} awaiting answers */
    this._waiters = new Map();
    /**
     * Answer handlers: consulted before an answer is accepted (e.g. resume the
     * paused workflow). A handler that throws rejects the answer and the
     * interaction stays pending. @type {Set<Function>}
     */
    this._answerHandlers = new Set();
    this._loaded = false;
    this._unhookDelete = this.runLog.onDelete(runId => this._deleteForRun(runId));
  }

  _persist() {
    return this._persistOverride ?? this.runLog.isEnabled();
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this._persist()) return;
    try {
      const data = await this._store.load();
      for (const [id, it] of Object.entries(data.interactions || {})) {
        if (!this._byId.has(id)) this._byId.set(id, it);
      }
    } catch (err) {
      logger.warn('InteractionService: failed to load pending store', {
        component: 'InteractionService',
        error: err.message
      });
    }
  }

  async _save(interaction) {
    this._byId.set(interaction.id, interaction);
    if (!this._persist()) return;
    const data = await this._store.load();
    if (interaction.status === 'pending') {
      data.interactions[interaction.id] = interaction;
    } else {
      // Only pending interactions need to survive a restart; answered ones are
      // on the run's ledger.
      delete data.interactions[interaction.id];
    }
    this._store.markDirty();
  }

  async _deleteForRun(runId) {
    await this._ensureLoaded();
    let n = 0;
    for (const [id, it] of this._byId) {
      if (it.runId === runId) {
        this._byId.delete(id);
        const w = this._waiters.get(id);
        if (w) {
          this._waiters.delete(id);
          w.reject(new InteractionError('Run deleted', 'RUN_DELETED', 410));
        }
        n++;
      }
    }
    if (this._persist()) {
      const data = await this._store.load();
      for (const [id, it] of Object.entries(data.interactions || {})) {
        if (it.runId === runId) delete data.interactions[id];
      }
      this._store.markDirty();
      await this._store.flush();
    }
    return n > 0 ? `interactions:${n}` : null;
  }

  /**
   * Register a handler that runs when an interaction is answered, BEFORE the
   * answer is persisted: `handler(interaction, { user, channel })` where
   * `interaction` already carries `status: 'answered'` and `answer`. Throwing
   * rejects the answer (the caller sees the error, the interaction stays
   * pending) — this is how a paused workflow takes the answer atomically.
   *
   * @param {(interaction: Object, ctx: {user: Object|null, channel: string}) => Promise<void>|void} handler
   * @returns {() => void} unregister
   */
  onAnswer(handler) {
    this._answerHandlers.add(handler);
    return () => this._answerHandlers.delete(handler);
  }

  /**
   * Raise a new interaction.
   *
   * @param {Object} params
   * @param {string} params.runId
   * @param {'question'|'approval'|'review'|'notify'} params.kind
   * @param {'tool'|'node'|'policy'|'system'} params.origin
   * @param {Object} params.prompt - see interactionPromptSchema
   * @param {Object} [params.policy]
   * @param {Object} [params.source]
   * @param {number} [params.step]
   * @param {string} [params.id]
   * @param {number} [params.ordinal] - caller-tracked sequence (default: n-th of this kind on the run)
   * @returns {Promise<Object>} the persisted interaction
   */
  async raise(params) {
    await this._ensureLoaded();
    const nowIso = new Date(this._now()).toISOString();
    const policy = { ...(params.policy || {}) };
    if (!policy.expiresAt && policy.timeoutMs) {
      policy.expiresAt = new Date(this._now() + policy.timeoutMs).toISOString();
    }
    const ordinal =
      Number.isInteger(params.ordinal) && params.ordinal > 0
        ? params.ordinal
        : 1 +
          [...this._byId.values()].filter(i => i.runId === params.runId && i.kind === params.kind)
            .length;
    const interaction = interactionSchema.parse({
      id: params.id || `int-${crypto.randomUUID()}`,
      runId: params.runId,
      step: params.step ?? 0,
      kind: params.kind,
      origin: params.origin,
      prompt: params.prompt,
      policy,
      status: 'pending',
      source: params.source || {},
      createdAt: nowIso,
      ordinal
    });
    await this._save(interaction);
    try {
      this.runLog.append(params.runId, RUN_LOG_EVENTS.INTERACTION_RAISED, { interaction });
    } catch (err) {
      logger.warn('InteractionService: ledger append failed', {
        component: 'InteractionService',
        error: err.message
      });
    }
    this.emit('raised', interaction);
    return interaction;
  }

  /** Get an interaction by id (pending or recently resolved in this process). */
  async get(id) {
    await this._ensureLoaded();
    return this._byId.get(id) || null;
  }

  /** List pending interactions, optionally filtered. */
  async listPending({ runId, kind, approverGroups, principalId, chatId } = {}) {
    await this._ensureLoaded();
    let items = [...this._byId.values()].filter(i => i.status === 'pending');
    if (runId) items = items.filter(i => i.runId === runId);
    if (kind) items = items.filter(i => i.kind === kind);
    if (chatId) items = items.filter(i => i.source?.chatId === chatId);
    if (Array.isArray(approverGroups)) {
      items = items.filter(i => {
        const groups = i.policy?.approverGroups;
        if (!Array.isArray(groups) || groups.length === 0) return true;
        return groups.some(g => approverGroups.includes(g));
      });
    }
    if (principalId) items = items.filter(i => i.source?.principalId === principalId);
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return items;
  }

  /**
   * Validate that `user` may answer `interaction` (approver groups).
   * Agents (isAgent) never count as approvers for approvals.
   */
  assertCanAnswer(interaction, user) {
    const groups = interaction.policy?.approverGroups;
    if (!Array.isArray(groups) || groups.length === 0) return;
    if (!user || user.isAgent === true) {
      throw new InteractionError('An approver is required', 'APPROVER_REQUIRED', 403);
    }
    const userGroups = user.groups || [];
    if (!groups.some(g => userGroups.includes(g))) {
      throw new InteractionError(
        `User ${user.id} is not a member of any approver group (${groups.join(', ')})`,
        'UNAUTHORIZED_APPROVER',
        403
      );
    }
  }

  /**
   * Validate an answer against the prompt: options, inputSchema (required
   * keys / basic types), skip permission.
   */
  validateAnswer(interaction, answer) {
    const { prompt } = interaction;
    if (answer.skipped) {
      if (!prompt.allowSkip) {
        throw new InteractionError('This question cannot be skipped', 'SKIP_NOT_ALLOWED');
      }
      return;
    }
    if (interaction.kind === 'approval') {
      const d = answer.decision || (answer.value ? undefined : 'approve');
      const allowed = ['approve', 'edit', 'reject', 'respond'];
      if (d && !allowed.includes(d)) {
        throw new InteractionError(`Invalid decision '${d}'`, 'INVALID_DECISION');
      }
      if (d === 'reject' && !answer.reason && !answer.value) {
        throw new InteractionError('A reason is required to reject', 'REASON_REQUIRED');
      }
    }
    if (Array.isArray(prompt.options) && prompt.options.length > 0 && !prompt.allowOther) {
      const valid = prompt.options.map(o => o.value);
      const values = Array.isArray(answer.value) ? answer.value : [answer.value];
      const isDecisionOnly =
        interaction.kind === 'approval' && answer.decision && answer.value == null;
      if (!isDecisionOnly) {
        for (const v of values) {
          if (!valid.includes(v)) {
            throw new InteractionError(
              `Invalid response '${v}'. Valid options: ${valid.join(', ')}`,
              'INVALID_OPTION'
            );
          }
        }
      }
    }
    if (prompt.inputSchema && typeof prompt.inputSchema === 'object') {
      const data = answer.data || {};
      const required = Array.isArray(prompt.inputSchema.required)
        ? prompt.inputSchema.required
        : [];
      for (const key of required) {
        if (data[key] === undefined || data[key] === null || data[key] === '') {
          throw new InteractionError(`Missing required field '${key}'`, 'INVALID_INPUT');
        }
      }
      const props = prompt.inputSchema.properties || {};
      for (const [key, def] of Object.entries(props)) {
        if (data[key] === undefined || !def || !def.type) continue;
        const t = def.type;
        const v = data[key];
        const ok =
          (t === 'string' && typeof v === 'string') ||
          (t === 'number' && typeof v === 'number') ||
          (t === 'integer' && Number.isInteger(v)) ||
          (t === 'boolean' && typeof v === 'boolean') ||
          (t === 'array' && Array.isArray(v)) ||
          (t === 'object' && v && typeof v === 'object' && !Array.isArray(v));
        if (!ok) {
          throw new InteractionError(`Field '${key}' must be of type ${t}`, 'INVALID_INPUT');
        }
      }
    }
  }

  /**
   * Answer a pending interaction.
   *
   * @param {string} id
   * @param {Object} answer - { value?, data?, decision?, reason?, skipped? }
   * @param {Object} [ctx] - { user, channel }
   * @returns {Promise<Object>} the answered interaction
   */
  async answer(id, answer = {}, { user = null, channel = 'api' } = {}) {
    await this._ensureLoaded();
    const interaction = this._byId.get(id);
    if (!interaction) throw new InteractionError('Interaction not found', 'NOT_FOUND', 404);
    if (interaction.status !== 'pending') {
      throw new InteractionError(`Interaction is ${interaction.status}`, 'NOT_PENDING', 409);
    }
    if (
      interaction.policy?.expiresAt &&
      new Date(interaction.policy.expiresAt).getTime() <= this._now()
    ) {
      await this.expire(id);
      throw new InteractionError('Interaction expired', 'EXPIRED', 410);
    }
    this.assertCanAnswer(interaction, user);
    this.validateAnswer(interaction, answer);
    const full = interactionAnswerSchema.parse({
      value: answer.value ?? answer.decision ?? (answer.skipped ? null : undefined),
      data: answer.data,
      decision: answer.decision,
      reason: answer.reason,
      skipped: answer.skipped,
      by: user?.id || 'anonymous',
      at: new Date(this._now()).toISOString(),
      channel
    });
    const answered = {
      ...interaction,
      status: 'answered',
      answer: full,
      updatedAt: full.at
    };
    // Let the owner of the paused run take the answer first; a throwing handler
    // leaves the interaction pending so the human can try again.
    for (const handler of this._answerHandlers) {
      await handler(answered, { user, channel });
    }
    await this._save(answered);
    try {
      this.runLog.append(interaction.runId, RUN_LOG_EVENTS.INTERACTION_ANSWERED, {
        interactionId: id,
        kind: interaction.kind,
        answer: full
      });
    } catch (err) {
      logger.warn('InteractionService: ledger append failed', {
        component: 'InteractionService',
        error: err.message
      });
    }
    const w = this._waiters.get(id);
    if (w) {
      this._waiters.delete(id);
      w.resolve(answered);
    }
    this.emit('answered', answered, { user, channel });
    return answered;
  }

  async cancel(id, reason = 'cancelled') {
    await this._ensureLoaded();
    const it = this._byId.get(id);
    if (!it || it.status !== 'pending') return it || null;
    const cancelled = {
      ...it,
      status: 'cancelled',
      updatedAt: new Date(this._now()).toISOString()
    };
    await this._save(cancelled);
    const w = this._waiters.get(id);
    if (w) {
      this._waiters.delete(id);
      w.reject(new InteractionError(reason, 'CANCELLED', 409));
    }
    this.emit('cancelled', cancelled);
    return cancelled;
  }

  async expire(id) {
    await this._ensureLoaded();
    const it = this._byId.get(id);
    if (!it || it.status !== 'pending') return it || null;
    const expired = { ...it, status: 'expired', updatedAt: new Date(this._now()).toISOString() };
    await this._save(expired);
    const w = this._waiters.get(id);
    if (w) {
      this._waiters.delete(id);
      w.reject(new InteractionError('Interaction expired', 'EXPIRED', 410));
    }
    this.emit('expired', expired);
    return expired;
  }

  /** Expire every pending interaction whose policy.expiresAt has passed. */
  async expireOverdue() {
    await this._ensureLoaded();
    const now = this._now();
    const out = [];
    for (const it of [...this._byId.values()]) {
      if (
        it.status === 'pending' &&
        it.policy?.expiresAt &&
        new Date(it.policy.expiresAt).getTime() <= now
      ) {
        out.push(await this.expire(it.id));
      }
    }
    return out;
  }

  /**
   * Wait for an interaction to be answered (in-process). Rejects on cancel /
   * expiry / run deletion. Runs that pause durably do NOT use this — they
   * persist loop state and resume from the answer event instead.
   */
  waitForAnswer(id, { timeoutMs } = {}) {
    const existing = this._byId.get(id);
    if (existing && existing.status === 'answered') return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        resolve: v => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          if (timer) clearTimeout(timer);
          reject(e);
        }
      };
      this._waiters.set(id, entry);
      if (timeoutMs) {
        timer = setTimeout(() => {
          this._waiters.delete(id);
          this.expire(id).catch(() => {});
          reject(new InteractionError('Interaction expired', 'EXPIRED', 410));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  /**
   * Start the periodic expiry sweep: overdue pending interactions transition to
   * `expired` (listeners apply the `onTimeout` policy). Idempotent; the timer
   * never keeps the process alive.
   *
   * @param {Object} [opts]
   * @param {number} [opts.intervalMs=60000]
   */
  startExpirySweep({ intervalMs = 60 * 1000 } = {}) {
    if (this._expiryTimer) return;
    const run = () => {
      this.expireOverdue().catch(err =>
        logger.warn('InteractionService: expiry sweep failed', {
          component: 'InteractionService',
          error: err.message
        })
      );
    };
    this._expiryTimer = setInterval(run, intervalMs);
    if (typeof this._expiryTimer.unref === 'function') this._expiryTimer.unref();
  }

  stopExpirySweep() {
    if (this._expiryTimer) clearInterval(this._expiryTimer);
    this._expiryTimer = null;
  }

  async flush() {
    if (this._persist()) await this._store.flush();
  }

  async stop() {
    this.stopExpirySweep();
    this._unhookDelete?.();
    if (this._persist()) {
      await this._store.flush();
      this._store.stop?.();
    }
  }
}

const interactionService = new InteractionService();
export default interactionService;
