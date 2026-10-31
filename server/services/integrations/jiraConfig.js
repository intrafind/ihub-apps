// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The Jira connection as the built-in installed integration `jira`
 * (`com.intrafind/jira`) holds it: the OAuth app's client id and secret, the
 * redirect URI and the site URL. Every user connects their own Atlassian
 * account; those tokens live in the token store under the service `jira`.
 *
 * Kept free of service imports so `JiraService`, the routes and the connector
 * can all read the installation without an import cycle.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import configCache from '../../configCache.js';
import tokenStorage from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import { buildPublicBaseUrl, getForwardedHost } from '../../utils/publicBaseUrl.js';

export const JIRA_INSTANCE_ID = 'jira';
export const JIRA_DEFINITION_ID = 'com.intrafind/jira';
/** The token store service name every user's Jira tokens are filed under. */
export const JIRA_TOKEN_SERVICE = 'jira';
/** Where Atlassian sends the browser back to, below the deployment's base URL. */
export const JIRA_CALLBACK_PATH = '/api/integrations/jira/callback';

/** The installed `jira` instance, or null. */
export function getJiraInstallation() {
  try {
    const installed = configCache.getIntegrations?.()?.data?.installed || [];
    return installed.find(instance => instance?.id === JIRA_INSTANCE_ID) || null;
  } catch {
    return null;
  }
}

/**
 * The Jira settings in the shape `JiraService` reads.
 * @param {object|null} [instance]
 * @returns {{ enabled: boolean, clientId: string, clientSecretRef: string, redirectUri: string, baseUrl: string }}
 */
export function jiraConfigFromInstance(instance) {
  const values = instance?.values || {};
  return {
    enabled: Boolean(instance) && instance.enabled !== false,
    clientId: typeof values.clientId === 'string' ? values.clientId.trim() : '',
    clientSecretRef: typeof values.clientSecretRef === 'string' ? values.clientSecretRef : '',
    redirectUri: typeof values.redirectUri === 'string' ? values.redirectUri.trim() : '',
    baseUrl: typeof values.siteUrl === 'string' ? values.siteUrl.trim() : ''
  };
}

export function getJiraConfig() {
  return jiraConfigFromInstance(getJiraInstallation());
}

/**
 * The redirect URI of one OAuth flow: the configured value, or — when the
 * installation leaves it empty — derived from the request the way the browser
 * sees it: scheme and host from the `X-Forwarded-Proto` / `X-Forwarded-Host`
 * headers of a trusted proxy (else the request's own), the base path
 * (`X-Forwarded-Prefix`), then `/api/integrations/jira/callback`. The
 * authorize redirect and the token exchange must send the same value, so both
 * go through here; the callback arrives at the URL that was derived for the
 * authorize step, so deriving it again from that request gives the same URL.
 *
 * @param {import('express').Request|null|undefined} req
 * @param {{ redirectUri: string }} [cfg]
 * @returns {string}
 */
export function resolveJiraRedirectUri(req, cfg = getJiraConfig()) {
  if (cfg.redirectUri) return cfg.redirectUri;
  if (!req || !getForwardedHost(req)) {
    throw new Error(
      'No Jira redirect URI configured and none can be derived from the request (no host)'
    );
  }
  return `${buildPublicBaseUrl(req)}${JIRA_CALLBACK_PATH}`;
}

/** Enabled, with an OAuth client id and a client secret reference. */
export function isJiraConfigured(cfg = getJiraConfig()) {
  return Boolean(cfg.enabled && cfg.clientId && cfg.clientSecretRef);
}

/**
 * The users who connected their Atlassian account: one token file per user
 * under `<contents>/integrations/jira/<userId>.json`.
 * @returns {Promise<Array<{ userId: string, createdAt: string|null, expiresAt: string|null, expired: boolean }>>}
 */
export async function listJiraConnections() {
  const dir = path.join(tokenStorage.storageBasePath, JIRA_TOKEN_SERVICE);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const userId = file.slice(0, -'.json'.length);
    if (!userId) continue;
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch (error) {
      logger.warn('Unreadable Jira token file skipped', {
        component: 'JiraConfig',
        file,
        error: error.message
      });
      continue;
    }
    const expiresAt = raw?.expiresAt || null;
    let hasRefreshToken = true;
    try {
      hasRefreshToken = Boolean(
        tokenStorage.decryptTokens(raw, userId, JIRA_TOKEN_SERVICE)?.refreshToken
      );
    } catch {
      /* unreadable payload: report the connection as the file describes it */
    }
    out.push({
      userId,
      createdAt: raw?.createdAt || null,
      expiresAt,
      // Access tokens are refreshed on use; a connection counts as expired
      // only when no refresh token can renew it.
      expired: Boolean(expiresAt && new Date(expiresAt) <= new Date() && !hasRefreshToken)
    });
  }
  return out.sort((a, b) => a.userId.localeCompare(b.userId));
}
