// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import { updatePlatform } from '../../utils/platformConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { reconfigureOidcProviders } from '../../middleware/oidcAuth.js';
import { issueAzureSpeechToken } from '../../services/azureSpeechToken.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { isValidLanguageCode } from '../../utils/pathSecurity.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { sharedSecretHeaderProblem } from '../../utils/proxyAuthTrust.js';
import { toolApprovalConfigProblem } from '../../utils/toolApproval.js';
import { platformConfigSchema } from '../../validators/platformConfigSchema.js';
import { assertPlatformChangeKeepsAccess } from '../../utils/adminGuards.js';
import {
  PLATFORM_SECRET_PATHS,
  SECRET_MARKER,
  assertNoMarkers,
  isEnvVarPlaceholder,
  redactForRead,
  restoreRedacted
} from '../../utils/redactedSecrets.js';
import { assertIfMatch, revisionOf, setRevisionHeaders } from '../../utils/configRevision.js';
import {
  describeSettingsChange,
  mergeSettingsForSave
} from '../../services/aiAcknowledgement/aiAcknowledgementService.js';
import {
  describeProvenanceChange,
  mergeProvenanceForSave
} from '../../services/provenance/provenanceSettingsAdmin.js';

/** The platform configuration, as a path relative to `contents/`. */
const PLATFORM_FILE = 'config/platform.json';

/**
 * The top-level sections `PATCH /api/admin/configs/platform` may change:
 * exactly the sections the POST writes. Every other key of platform.json is
 * either edited through its own validated route (see
 * {@link DEDICATED_SECTION_ROUTES}) or not editable from the admin API, and the
 * POST cannot change it either (it spreads the stored file under the named
 * keys), so a PATCH must not open it.
 */
export const PATCHABLE_PLATFORM_SECTIONS = Object.freeze([
  'defaultLanguage',
  'setup',
  'aiDisclosure',
  'aiAcknowledgement',
  'provenance',
  'auth',
  'anonymousAuth',
  'proxyAuth',
  'localAuth',
  'oidcAuth',
  'ldapAuth',
  'ntlmAuth',
  'authorization',
  'oauth',
  'mcpServer',
  'telemetry',
  'speech',
  'globalPromptVariables',
  'cookieSettings',
  'toolApproval'
]);

/**
 * Fields of `features` a PATCH may change, all booleans. The `features` block
 * holds the platform feature switches, which a full-body `POST` never writes
 * (a stale page posting them back must not revert a switch); a scoped PATCH of
 * one named switch is safe. `feedbackTracking` is Admin → Feedback → "Store
 * feedback".
 */
export const PATCHABLE_FEATURE_FLAGS = Object.freeze(['feedbackTracking']);

/** Sections with their own route and validation, named in the PATCH refusal. */
const DEDICATED_SECTION_ROUTES = Object.freeze({
  ssl: '/api/admin/ssl/config',
  ssrf: '/api/admin/ssrf/config',
  cors: '/api/admin/cors/config',
  rateLimit: '/api/admin/rate-limits',
  proxy: '/api/admin/proxy/config',
  logging: '/api/admin/logging/config'
});

/** Top-level sections whose `null` has a meaning in the POST (it removes the block). */
const NULLABLE_SECTIONS = new Set(['toolApproval']);

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The secret paths without array markers, as segment lists (`[]` dropped). */
const SECRET_SEGMENTS = PLATFORM_SECRET_PATHS.map(({ path }) =>
  path.split('.').map(segment => segment.replace(/\[\]$/, ''))
);

/** Whether `path` is exactly a secret leaf reachable through objects only. */
function isSecretLeaf(path) {
  return PLATFORM_SECRET_PATHS.some(
    ({ path: secretPath }, index) =>
      !secretPath.includes('[]') &&
      SECRET_SEGMENTS[index].length === path.length &&
      SECRET_SEGMENTS[index].every((segment, i) => segment === path[i])
  );
}

/** Whether `path` encloses a secret (a `null` there would delete the secret with it). */
function enclosesSecret(path) {
  return SECRET_SEGMENTS.some(
    segments => segments.length > path.length && path.every((segment, i) => segment === segments[i])
  );
}

/**
 * What is wrong with the `features` member of a PATCH: it must be an object
 * that sets only {@link PATCHABLE_FEATURE_FLAGS}, each to a boolean.
 *
 * @param {unknown} value
 * @returns {Array<{path: string[], code: string, message: string}>}
 */
function featureFlagPatchIssues(value) {
  if (!isPlainObject(value)) {
    return [{ path: ['features'], code: 'invalid_type', message: '"features" must be an object' }];
  }
  const issues = [];
  for (const [flag, flagValue] of Object.entries(value)) {
    if (!PATCHABLE_FEATURE_FLAGS.includes(flag)) {
      issues.push({
        path: ['features', flag],
        code: 'not_patchable',
        message: `"features.${flag}" cannot be changed through this endpoint`
      });
    } else if (typeof flagValue !== 'boolean') {
      issues.push({
        path: ['features', flag],
        code: 'invalid_type',
        message: `"features.${flag}" must be a boolean`
      });
    }
  }
  return issues;
}

/**
 * Check a PATCH body before it is applied: an object, only patchable sections,
 * and no `null` where it would remove a whole section or the object a secret
 * lives in (clearing a secret is `null` on the secret itself).
 *
 * @param {unknown} patch - The request body
 * @throws {ServiceError} `BAD_REQUEST` for a body that is not an object,
 *   `VALIDATION_FAILED` (400, `errors[].pointer`) for the rest
 */
function assertPatchShape(patch) {
  if (!isPlainObject(patch)) {
    throw new ServiceError('BAD_REQUEST', 'The body must be a JSON Merge Patch object');
  }
  const issues = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'features') {
      issues.push(...featureFlagPatchIssues(value));
      continue;
    }
    if (!PATCHABLE_PLATFORM_SECTIONS.includes(key)) {
      const route = DEDICATED_SECTION_ROUTES[key];
      issues.push({
        path: [key],
        code: 'not_patchable',
        message: route
          ? `"${key}" has its own validated route (${route}) and cannot be changed here`
          : `"${key}" cannot be changed through this endpoint`
      });
      continue;
    }
    if (value === null && !NULLABLE_SECTIONS.has(key)) {
      issues.push({
        path: [key],
        code: 'null_not_allowed',
        message: `"${key}" cannot be removed; send the fields to change instead`
      });
    }
  }
  const findEnclosingNulls = (value, path) => {
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (child === null && enclosesSecret(childPath)) {
        issues.push({
          path: childPath,
          code: 'null_not_allowed',
          message: `"${childPath.join('.')}" holds a secret and cannot be removed as a whole; set the secret itself to null to clear it`
        });
      } else {
        findEnclosingNulls(child, childPath);
      }
    }
  };
  for (const [key, value] of Object.entries(patch)) {
    if (PATCHABLE_PLATFORM_SECTIONS.includes(key)) findEnclosingNulls(value, [key]);
  }
  if (issues.length > 0) {
    throw new ServiceError(
      'VALIDATION_FAILED',
      issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      { details: issues }
    );
  }
}

/** Keys a merge must never assign: they reach the prototype, not a member. */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * RFC 7396 JSON Merge Patch of `patch` onto `target`, except that `null` on a
 * secret leaf stays `null`: {@link restoreRedacted} reads it as "clear the
 * secret", where a removed key would read as "keep the stored one".
 *
 * @param {unknown} target - The stored value (not modified)
 * @param {unknown} patch
 * @param {string[]} path - Where `target` sits in platform.json
 * @returns {unknown} The patched value
 */
function mergePatch(target, patch, path) {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const result = isPlainObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    // `result[key] = …` with `__proto__` would replace the section object's
    // prototype, and every validator that reads a property the section does
    // not set itself would then read the attacker's. No config key has these
    // names, so they are dropped.
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    const childPath = [...path, key];
    if (value === null) {
      if (isSecretLeaf(childPath)) result[key] = null;
      else delete result[key];
    } else {
      result[key] = mergePatch(result[key], value, childPath);
    }
  }
  return result;
}

/**
 * Sections whose POST merge is already a partial deep merge with its own `null`
 * rule (`provenance`: `null` on a watermark tunable means "default"). A PATCH
 * hands their value to that merge as it is; patching it onto the stored block
 * first would drop the `null` and the merge would then keep the stored value.
 */
const SELF_MERGING_SECTIONS = new Set(['provenance']);

/**
 * The sections a PATCH submits, each one patched onto its stored value, in the
 * shape the POST receives (whole sections) so both run the same merge.
 *
 * @param {Object} stored - The stored platform.json
 * @param {Object} patch - A body accepted by {@link assertPatchShape}
 * @returns {Object}
 */
function sectionsFromPatch(stored, patch) {
  const sections = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || SELF_MERGING_SECTIONS.has(key)) sections[key] = structuredClone(value);
    else sections[key] = mergePatch(stored?.[key], value, [key]);
  }
  return sections;
}

/**
 * The checks every submitted platform section passes before it is stored, for
 * POST and PATCH alike.
 *
 * @param {Object} newConfig - The submitted sections
 * @throws {ServiceError} `BAD_REQUEST`
 */
function validatePlatformSections(newConfig) {
  // A bad default language is not cosmetic: every localized lookup that
  // falls back to it, and every web search that has no request language of
  // its own, would take the bad value.
  if (newConfig.defaultLanguage !== undefined && !isValidLanguageCode(newConfig.defaultLanguage)) {
    throw new ServiceError(
      'BAD_REQUEST',
      'defaultLanguage must be a valid language code, e.g. "en"'
    );
  }

  // The AI disclosure block is read straight from the file at run time (a string where a
  // boolean belongs would be read as "on"), so it is checked before it is stored.
  if (newConfig.aiDisclosure !== undefined) {
    const checked = platformConfigSchema.shape.aiDisclosure.safeParse(newConfig.aiDisclosure);
    if (!checked.success) {
      throw new ServiceError(
        'BAD_REQUEST',
        `aiDisclosure is invalid: ${checked.error.issues
          .map(issue => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`
      );
    }
  }

  // The shared secret header is removed from every request, so it must not
  // be one that sign-in or request handling reads.
  const secretHeaderProblem = newConfig.proxyAuth && sharedSecretHeaderProblem(newConfig.proxyAuth);
  if (secretHeaderProblem) {
    throw new ServiceError('BAD_REQUEST', `proxyAuth.sharedSecretHeader ${secretHeaderProblem}`);
  }

  // A secret is restored (kept when omitted or redacted) by walking the
  // objects on its path. A container of another type (`speech.azure: []`)
  // cannot be walked, so saving it would delete the stored secret without the
  // explicit `null` that clearing one takes. `null` keeps its meaning.
  for (const [index, segments] of SECRET_SEGMENTS.entries()) {
    if (PLATFORM_SECRET_PATHS[index].path.includes('[]')) continue;
    let container = newConfig;
    for (let depth = 0; depth < segments.length - 1; depth++) {
      container = container[segments[depth]];
      if (container === undefined || container === null) break;
      if (!isPlainObject(container)) {
        throw new ServiceError(
          'BAD_REQUEST',
          `${segments.slice(0, depth + 1).join('.')} must be an object`
        );
      }
    }
  }

  if (
    newConfig.cookieSettings !== undefined &&
    (newConfig.cookieSettings === null ||
      typeof newConfig.cookieSettings !== 'object' ||
      Array.isArray(newConfig.cookieSettings) ||
      (newConfig.cookieSettings.disableSecure !== undefined &&
        typeof newConfig.cookieSettings.disableSecure !== 'boolean'))
  ) {
    throw new ServiceError(
      'BAD_REQUEST',
      'cookieSettings must be an object with a boolean disableSecure'
    );
  }

  if (newConfig.toolApproval !== undefined && newConfig.toolApproval !== null) {
    const approvalProblem = toolApprovalConfigProblem(newConfig.toolApproval);
    if (approvalProblem) throw new ServiceError('BAD_REQUEST', approvalProblem);
  }
}

/**
 * The stored platform.json with the submitted sections applied: the POST's
 * section allowlist. Sections not named here keep their stored value, whatever
 * the body says.
 *
 * @param {Object} existingConfig - The stored body
 * @param {Object} newConfig - The submitted sections
 * @param {Object} [options]
 * @param {'replace'|'merge'} [options.mode='replace'] - `merge` (PATCH): the
 *   submitted sections are already the stored ones with the patch applied, so
 *   a field missing from them was deleted by the patch and stays deleted
 * @returns {Object} The body to store (secrets not yet restored)
 */
function mergePlatformSections(existingConfig, newConfig, { mode = 'replace' } = {}) {
  const mergedConfig = {
    ...existingConfig,
    // Listed explicitly for the same reason as `mcpServer` below: this merge
    // emits only the named keys, so an unnamed one is silently reverted by
    // the spread of existingConfig on save.
    defaultLanguage:
      newConfig.defaultLanguage !== undefined
        ? newConfig.defaultLanguage
        : existingConfig.defaultLanguage,
    // First-run onboarding toggle (Admin → Advanced); same reason as above.
    setup: newConfig.setup !== undefined ? newConfig.setup : existingConfig.setup,
    // First-turn AI notice (Admin → Advanced); same reason as above.
    aiDisclosure:
      newConfig.aiDisclosure !== undefined ? newConfig.aiDisclosure : existingConfig.aiDisclosure,
    // AI-use acknowledgement (#3326): the form owns enabled/enforce/text/
    // policyUrl; `requiredVersion` and `resetAt` always come from the stored
    // block, so a stale form cannot re-validate everyone.
    aiAcknowledgement: mergeSettingsForSave(
      newConfig.aiAcknowledgement,
      existingConfig.aiAcknowledgement,
      { complete: mode === 'merge' }
    ),
    // Provenance records (#3327): retention, store switch, verify access, media and
    // watermark tunables. Validated and deep-merged, so keys a form does not own survive.
    provenance: mergeProvenanceForSave(newConfig.provenance, existingConfig.provenance),
    auth: newConfig.auth || existingConfig.auth,
    anonymousAuth: newConfig.anonymousAuth || existingConfig.anonymousAuth,
    proxyAuth: newConfig.proxyAuth || existingConfig.proxyAuth,
    localAuth: newConfig.localAuth || existingConfig.localAuth,
    oidcAuth: newConfig.oidcAuth || existingConfig.oidcAuth,
    ldapAuth: newConfig.ldapAuth || existingConfig.ldapAuth,
    ntlmAuth: newConfig.ntlmAuth || existingConfig.ntlmAuth,
    authorization: newConfig.authorization || existingConfig.authorization,
    oauth: newConfig.oauth || existingConfig.oauth,
    // MCP gateway (Admin → MCP gateway) is edited through this generic
    // endpoint rather than a dedicated route, so it must be listed here —
    // otherwise the spread of existingConfig silently wins and the saved
    // toggles revert on the next load.
    mcpServer: newConfig.mcpServer !== undefined ? newConfig.mcpServer : existingConfig.mcpServer,
    telemetry: newConfig.telemetry !== undefined ? newConfig.telemetry : existingConfig.telemetry,
    speech: newConfig.speech !== undefined ? newConfig.speech : existingConfig.speech,
    // Admin → Prompts → Variables (global context and custom variables).
    globalPromptVariables:
      newConfig.globalPromptVariables !== undefined
        ? newConfig.globalPromptVariables
        : existingConfig.globalPromptVariables,
    // Admin → System → Cookie settings (`disableSecure`); same reason as above.
    cookieSettings:
      newConfig.cookieSettings !== undefined
        ? newConfig.cookieSettings
        : existingConfig.cookieSettings,
    // Admin → Security → Tool approval (#2945).
    toolApproval:
      newConfig.toolApproval !== undefined ? newConfig.toolApproval : existingConfig.toolApproval
  };
  if (mode === 'merge' && newConfig.features !== undefined) {
    // Only a PATCH writes `features`, and only the switches it may change
    // (see PATCHABLE_FEATURE_FLAGS); `newConfig.features` is the stored block
    // with the patch applied.
    mergedConfig.features = newConfig.features;
  }
  if (newConfig.toolApproval === null) {
    // `null` turns approval off: the block is removed, never stored as
    // null (the platform schema has it as an optional object).
    delete mergedConfig.toolApproval;
  }
  return mergedConfig;
}

/**
 * The one writer of `POST` and `PATCH /api/admin/configs/platform`.
 *
 * Both requests run the same steps, so a PATCH can never become a way around
 * a check the POST makes:
 * 1. under the platform update lock: the optional `If-Match` (412), the
 *    submitted sections (the POST body, or the PATCH merged onto the stored
 *    sections), the section validators, the section merge, the restore of
 *    redacted and omitted secrets, the refusal of any marker left over, and the
 *    lockout invariant (409 `AUTH_LOCKOUT`);
 * 2. after the write: cache refresh, runtime reconfiguration, snapshot and audit.
 *
 * Secrets are encrypted by `updatePlatform` on the way to disk.
 *
 * @param {import('express').Request} req - The admin request (`req.user`, `If-Match`)
 * @param {Object} body - The POST body (whole sections) or the PATCH body (merge patch)
 * @param {Object} options
 * @param {'replace'|'merge'} options.mode - `replace` for POST, `merge` for PATCH
 * @returns {Promise<{stored: Object, revision: string, reconfiguration: Object}>}
 *   The body now stored (secrets encrypted), its revision and what was reconfigured
 */
async function applyPlatformChange(req, body, { mode }) {
  // Set by the mutator, which may run more than once (a conflicting write by
  // another worker re-runs it on a fresh read): it derives everything from the
  // stored body it is handed and only assigns these.
  let existingConfig;
  let mergedConfig;
  let newConfig;
  let firstRun = false;
  // Strict, because this is a read-modify-write: the merge emits only the
  // named keys, so treating an unparseable platform.json as a first run would
  // answer 200 while replacing `features`, `cors`, `storage`, `chats`,
  // `runLog`, `rateLimit` and the rest with nothing.
  const { data: stored } = await updatePlatform(
    async (current, { exists = true } = {}) => {
      // A missing file is handed over as `{}`; the precondition is checked
      // against "missing" (`If-Match: *` fails, the read's ETag of a missing
      // file matches), never against an empty file.
      assertIfMatch(req, exists ? current : null, 'platform');
      firstRun = current === null || Object.keys(current).length === 0;
      existingConfig = structuredClone(current);
      newConfig =
        mode === 'merge' ? sectionsFromPatch(existingConfig, body) : structuredClone(body);

      validatePlatformSections(newConfig);
      mergedConfig = mergePlatformSections(existingConfig, newConfig, { mode });

      // Put back what the admin read redacted or left out (JWT secrets, the
      // speech key, masked JWKS URLs): omitted keeps, null clears.
      restoreRedacted(mergedConfig, existingConfig, PLATFORM_SECRET_PATHS);
      // A marker that is still there stands for nothing stored; saving it would
      // replace a secret with the word "REDACTED". Only the sections this
      // request can change are checked, and only the values it changes: a
      // full-body page also sends `features`, `cors`, … back, which the merge
      // ignores, and a value already stored is not this request's doing.
      for (const key of Object.keys(newConfig)) {
        if (!PATCHABLE_PLATFORM_SECTIONS.includes(key)) continue;
        assertNoMarkers(mergedConfig[key], [key], { stored: existingConfig?.[key] });
      }

      // No save may lock the caller, or every administrator, out (409
      // AUTH_LOCKOUT, no override): evaluated on the stored body and the
      // merged one, under the platform lock.
      await assertPlatformChangeKeepsAccess(req.user, existingConfig, mergedConfig);
      return mergedConfig;
    },
    { create: true }
  );
  if (firstRun) {
    logger.info('Creating new platform config file', { component: 'AdminConfigs' });
  }

  await configCache.refreshCacheEntry(PLATFORM_FILE);

  const acknowledgementChange = describeSettingsChange(
    existingConfig.aiAcknowledgement,
    mergedConfig.aiAcknowledgement
  );
  if (acknowledgementChange) {
    logAudit({
      req,
      action: 'update',
      resource: 'aiAcknowledgement',
      resourceId: 'settings',
      summary: `AI-use acknowledgement settings changed: ${acknowledgementChange.changed.join(', ')}`,
      details: acknowledgementChange
    });
  }

  const provenanceChange = describeProvenanceChange(
    existingConfig.provenance,
    mergedConfig.provenance
  );
  if (provenanceChange) {
    await logAudit({
      req,
      action: 'update',
      resource: 'provenanceSettings',
      resourceId: 'settings',
      summary: `Provenance settings changed: ${provenanceChange.changed.map(c => c.key).join(', ')}`,
      details: provenanceChange
    });
  }

  // Apply runtime-mutable telemetry settings without server restart
  try {
    const telemetryChanged =
      JSON.stringify(existingConfig.telemetry) !== JSON.stringify(newConfig.telemetry);
    if (telemetryChanged && newConfig.telemetry) {
      const { reloadTelemetryConfig } = await import('../../telemetry.js');
      const { default: activityTracker } = await import('../../telemetry/ActivityTracker.js');
      reloadTelemetryConfig(newConfig.telemetry);
      activityTracker.configure(newConfig.telemetry.activitySummary || {});
      logger.info('Telemetry runtime configuration updated', { component: 'AdminConfigs' });
    }
  } catch (telemetryError) {
    logger.warn('Failed to apply runtime telemetry config update', {
      component: 'AdminConfigs',
      error: telemetryError.message
    });
  }

  // A changed OIDC provider (token URL, client) invalidates the iFinder
  // tokens exchanged through it. The iFinder installation itself lives in
  // integrations.json and resets its caches from there.
  // Compared with the merged body (what was written), not `newConfig`: a
  // PATCH or a partial POST names only some sections, and a section it leaves
  // out is unchanged, not removed.
  if (JSON.stringify(existingConfig.oidcAuth) !== JSON.stringify(mergedConfig.oidcAuth)) {
    try {
      const { clearExchangedTokenCache } =
        await import('../../services/integrations/iFinderTokenProvider.js');
      clearExchangedTokenCache();
    } catch (error) {
      logger.warn('Could not clear the iFinder token cache', {
        component: 'AdminConfigs',
        error
      });
    }
  }

  // Reconfigure authentication methods dynamically where possible; against
  // the merged body for the same reason as above.
  const reconfigResults = reconfigureAuthenticationMethods(existingConfig, mergedConfig);

  if (reconfigResults.reconfigured.length > 0) {
    logger.info('Reconfigured authentication methods', {
      component: 'AdminConfigs',
      reconfigured: reconfigResults.reconfigured.join(', ')
    });
  }
  if (reconfigResults.requiresRestart.length > 0) {
    logger.info('Authentication methods require restart', {
      component: 'AdminConfigs',
      requiresRestart: reconfigResults.requiresRestart.join(', ')
    });
  }
  reconfigResults.notes.forEach(note =>
    logger.info('Authentication reconfiguration note', { component: 'AdminConfigs', note })
  );

  logger.info('Platform authentication configuration updated', { component: 'AdminConfigs' });

  // Both sides as stored (secrets encrypted where the file encrypts them); the
  // snapshot read redacts them.
  await saveSnapshot({
    resource: 'platform',
    id: 'platform',
    before: existingConfig,
    after: stored,
    admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
  });
  await logAudit({
    req,
    action: 'update',
    resource: 'platform',
    resourceId: 'platform',
    summary:
      mode === 'merge'
        ? `Updated platform configuration (${Object.keys(body).join(', ') || 'no sections'})`
        : 'Updated platform configuration'
  });

  return {
    stored,
    revision: revisionOf(stored),
    reconfiguration: {
      reconfigured: reconfigResults.reconfigured,
      requiresRestart: reconfigResults.requiresRestart,
      notes: reconfigResults.notes
    }
  };
}

/**
 * Reconfigure authentication methods when platform configuration changes
 * @param {Object} oldConfig - Previous configuration
 * @param {Object} newConfig - New configuration
 * @returns {Object} Reconfiguration results
 */
function reconfigureAuthenticationMethods(oldConfig = {}, newConfig = {}) {
  const results = {
    reconfigured: [],
    requiresRestart: [],
    notes: []
  };

  // Check what authentication methods changed
  const oidcChanged = JSON.stringify(oldConfig.oidcAuth) !== JSON.stringify(newConfig.oidcAuth);
  const ntlmChanged = JSON.stringify(oldConfig.ntlmAuth) !== JSON.stringify(newConfig.ntlmAuth);
  const ldapChanged = JSON.stringify(oldConfig.ldapAuth) !== JSON.stringify(newConfig.ldapAuth);
  const localChanged = JSON.stringify(oldConfig.localAuth) !== JSON.stringify(newConfig.localAuth);
  const proxyChanged = JSON.stringify(oldConfig.proxyAuth) !== JSON.stringify(newConfig.proxyAuth);
  const anonymousChanged =
    JSON.stringify(oldConfig.anonymousAuth) !== JSON.stringify(newConfig.anonymousAuth);

  // OIDC - Can be reconfigured dynamically
  if (oidcChanged) {
    try {
      reconfigureOidcProviders();
      results.reconfigured.push('OIDC providers');
      results.notes.push('OIDC providers reconfigured successfully');
    } catch (error) {
      logger.error('Failed to reconfigure OIDC providers', { component: 'AdminConfigs', error });
      results.notes.push(`OIDC reconfiguration failed: ${error.message}`);
    }
  }

  // NTLM - Requires server restart (middleware cannot be dynamically removed)
  if (ntlmChanged) {
    results.requiresRestart.push('NTLM authentication');
    results.notes.push(
      'NTLM authentication changes require server restart (middleware limitation)'
    );
  }

  // LDAP - No reconfiguration needed (loads config dynamically)
  if (ldapChanged) {
    results.notes.push('LDAP configuration updated (applied automatically on next authentication)');
  }

  // Local Auth - No reconfiguration needed (loads config dynamically)
  if (localChanged) {
    results.notes.push('Local authentication configuration updated (applied automatically)');
  }

  // Proxy Auth - No reconfiguration needed (loads config dynamically)
  if (proxyChanged) {
    results.notes.push('Proxy authentication configuration updated (applied automatically)');
  }

  // Anonymous Auth - No reconfiguration needed (loads config dynamically)
  if (anonymousChanged) {
    results.notes.push('Anonymous authentication configuration updated (applied automatically)');
  }

  return results;
}

export default function registerAdminConfigRoutes(app) {
  /**
   * @swagger
   * /admin/configs/platform:
   *   get:
   *     summary: Get platform configuration
   *     description: Retrieves the current platform configuration (admin access required)
   *     tags:
   *       - Admin - Configuration
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: Platform configuration
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 auth:
   *                   type: object
   *                   description: Authentication configuration
   *                 anonymousAuth:
   *                   type: object
   *                   description: Anonymous authentication settings
   *                 features:
   *                   type: object
   *                   description: Feature flags
   *                 swagger:
   *                   type: object
   *                   description: Swagger documentation settings
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    // Strict, for the reason the save below is: defaults rendered over a
    // platform.json that merely cannot be parsed read as "nothing is
    // configured", which is the one thing that is not true.
    const stored = await configStore.readJsonStrict(PLATFORM_FILE);
    let platformConfig = stored;
    if (!platformConfig) {
      logger.info('Platform config not found, returning default config', {
        component: 'AdminConfigs'
      });
      platformConfig = {
        auth: {
          mode: 'local',
          authenticatedGroup: 'authenticated'
        },
        anonymousAuth: {
          enabled: true,
          defaultGroups: ['anonymous']
        },
        proxyAuth: {
          enabled: false,
          userHeader: 'X-Forwarded-User',
          groupsHeader: 'X-Forwarded-Groups',
          jwtProviders: []
        },
        localAuth: {
          enabled: false,
          sessionTimeoutMinutes: 480
        },
        oidcAuth: {
          enabled: false,
          providers: []
        }
      };
    }

    // JWT secrets and the speech key read as ***REDACTED*** (`${ENV}`
    // placeholders as they are); JWKS URLs are shown with credentials masked,
    // so a save of this body restores them instead of deleting them.
    // Integration secrets (oidc/ldap/ntlm) live in the credential store.
    setRevisionHeaders(res, revisionOf(stored));
    res.json(redactForRead(platformConfig, PLATFORM_SECRET_PATHS));
  });

  /**
   * @swagger
   * /admin/configs/platform:
   *   post:
   *     summary: Save platform configuration sections
   *     description: |
   *       Replaces each section the body names (from a fixed list: auth blocks,
   *       defaultLanguage, setup, aiDisclosure, aiAcknowledgement, provenance,
   *       oauth, mcpServer, telemetry, speech, globalPromptVariables,
   *       cookieSettings, toolApproval); every other key keeps its stored value.
   *       Redacted secrets (`***REDACTED***`, masked JWKS URLs) and omitted
   *       secret fields keep the stored value; `null` on a secret clears it. A
   *       value that is still a redaction marker is refused.
   *     tags:
   *       - Admin - Configuration
   *     parameters:
   *       - in: header
   *         name: If-Match
   *         required: false
   *         schema: { type: string }
   *         description: The ETag of the read the change is based on. Optional.
   *     responses:
   *       200:
   *         description: Saved; `ETag` header carries the new revision
   *       400:
   *         description: Invalid section or a redaction marker as a value
   *       409:
   *         description: AUTH_LOCKOUT
   *       412:
   *         description: PRECONDITION_FAILED, the configuration changed since that read
   */
  app.post(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    const submittedConfig = req.body;
    if (!submittedConfig || typeof submittedConfig !== 'object') {
      throw new ServiceError('BAD_REQUEST', 'Invalid configuration data');
    }

    const { stored, revision, reconfiguration } = await applyPlatformChange(req, submittedConfig, {
      mode: 'replace'
    });

    setRevisionHeaders(res, revision);
    res.json({
      config: redactForRead(stored, PLATFORM_SECRET_PATHS),
      reconfiguration
    });
  });

  /**
   * @swagger
   * /admin/configs/platform:
   *   patch:
   *     summary: Change platform configuration sections (JSON Merge Patch)
   *     description: |
   *       RFC 7396 JSON Merge Patch over the sections the POST may change. A
   *       section with its own route (ssl, ssrf, cors, rateLimit, proxy,
   *       logging) or any other key is refused with 400 and `errors[].pointer`.
   *       `null` removes a member; on a secret it clears the secret; on a whole
   *       section, or on an object that holds a secret, it is refused (except
   *       `toolApproval: null`, which turns approval off as in the POST). Runs
   *       the same validators, secret restore, lockout check, snapshot and
   *       audit as the POST.
   *     tags:
   *       - Admin - Configuration
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema: { type: object }
   *     parameters:
   *       - in: header
   *         name: If-Match
   *         required: false
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The configuration as the GET shows it; `ETag` header carries the new revision
   *       400:
   *         description: VALIDATION_FAILED (section not patchable, null not allowed, redaction marker) or BAD_REQUEST
   *       409:
   *         description: AUTH_LOCKOUT
   *       412:
   *         description: PRECONDITION_FAILED
   */
  app.patch(buildServerPath('/api/admin/configs/platform'), adminAuth, async (req, res) => {
    const patch = req.body;
    assertPatchShape(patch);

    const { stored, revision } = await applyPlatformChange(req, patch, { mode: 'merge' });

    setRevisionHeaders(res, revision);
    res.json(redactForRead(stored, PLATFORM_SECRET_PATHS));
  });

  /**
   * Test the Azure Speech credentials by exchanging the subscription key for a
   * token — the same exchange /api/voice/azure/token performs per session.
   * Accepts optional { region, subscriptionKey, host } to test unsaved form
   * values. A redacted or ${ENV} key means the saved (decrypted) key, so the
   * secret never reaches the browser; an empty key means keyless mode, which is
   * only verifiable from the browser (the live dictation test).
   */
  app.post(buildServerPath('/api/admin/voice/azure/_test'), adminAuth, async (req, res) => {
    const body = req.body || {};
    const saved = (configCache.getPlatform() || {}).speech?.azure || {};

    const region = String(body.region ?? saved.region ?? '').trim();
    const host = String(body.host ?? saved.host ?? '').trim();
    let subscriptionKey = body.subscriptionKey ?? saved.subscriptionKey ?? '';
    if (subscriptionKey === SECRET_MARKER || isEnvVarPlaceholder(subscriptionKey)) {
      subscriptionKey = saved.subscriptionKey || ''; // already decrypted by configCache
    }

    // `code` is stable for the admin UI to translate; `message` is the
    // English text for API callers and logs.
    if (!subscriptionKey) {
      return res.json(
        host
          ? {
              ok: true,
              code: 'keyless',
              message:
                'No subscription key: keyless mode. Browsers connect straight to the host, so verify it with the live dictation test below.'
            }
          : {
              ok: false,
              code: 'not-configured',
              message:
                'Neither a subscription key nor a host is set. Azure cloud needs a key and region; an on-prem container needs a host.'
            }
      );
    }

    const result = await issueAzureSpeechToken({ subscriptionKey, region });
    if (!result.ok) {
      return res.json(
        /HTTP 401/.test(result.error)
          ? {
              ok: false,
              code: 'invalid-key',
              message: `${result.error}: the key is invalid or belongs to a different region`
            }
          : { ok: false, code: 'token-failed', message: result.error }
      );
    }
    // api-guidelines-ignore: a key test answers 200 with its outcome (`ok`): that it failed is the result
    return res.json({
      ok: true,
      code: 'token-issued',
      region: result.region,
      message: `Key accepted: Azure issued a token for region "${result.region}".`
    });
  });
}
