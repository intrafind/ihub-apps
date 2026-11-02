// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import Badge from '../../../shared/components/Badge';
import { useConnectResult } from './useConnectResult';
import { normalizeAuthPrompts } from './authPrompts';
import {
  invalidateIntegrationInfo,
  loadIntegrationInfo,
  permissionsByEffect,
  startIntegrationConnect
} from './integrationInfo';

/** Badge tone per side effect (see Badge's suggested mappings). */
const EFFECT_TONES = { read: 'info', write: 'warning', destructive: 'danger', unknown: 'neutral' };

/** Icon per integration type when the definition has no logo. */
function fallbackIcon(info) {
  if (info?.type === 'storage' || info?.capabilities?.includes('files')) return 'cloud';
  if (info?.protocol === 'mcp') return 'server';
  return 'link';
}

/**
 * The integration's logo, or a neutral icon in its place. Decorative: the
 * card's title names the integration.
 */
function IntegrationLogo({ info }) {
  if (info?.icon) {
    return (
      <img
        src={info.icon}
        alt=""
        aria-hidden="true"
        className="h-8 w-8 shrink-0 rounded-sm object-contain"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
    >
      <Icon name={fallbackIcon(info)} size="sm" />
    </span>
  );
}

/**
 * The one Connect card of every protocol (#2917; product concept §7.3):
 * Jira, cloud storage providers, per-user MCP servers — any integration that
 * needs the user's own sign-in.
 *
 * It says why iHub needs to act as the user for this request, which
 * permissions that covers in plain words, and where the user will sign in;
 * **Connect** leaves for the vendor's consent and comes back to this page
 * (the same chat); **Not now** folds the card away. For a connection that
 * needs to be renewed (`expired`) or that lacks a permission
 * (`insufficient_scope`) it says why and what changes, and **Reconnect**
 * keeps the connection (same id) and adds the permission.
 *
 * When the user is connected by now (a reopened chat, another tab) the card
 * says so instead of asking again. A sign-in that just came back with an
 * error for this integration is announced.
 *
 * @param {Object} props
 * @param {import('./authPrompts').AuthPrompt} props.prompt - What the call needed
 * @param {boolean} [props.readOnly=false] - Shared chats show the notice without buttons
 * @param {'chat'|'files'} [props.context='chat'] - Wording: a chat request, or browsing files
 * @param {(url: string) => void} [props.navigate] - Test seam; defaults to a full-page navigation
 * @returns {JSX.Element}
 *
 * @example
 * <ConnectCard prompt={{ integration: 'jira', name: 'Jira', reason: 'not_connected',
 *   action: 'Search issues' }} />
 */
export function ConnectCard({ prompt, readOnly = false, context = 'chat', navigate }) {
  const { t } = useTranslation();
  const titleId = useId();
  const returned = useConnectResult(result => {
    if (result.connected === prompt.integration) return 'connected';
    if (result.error && result.errorIntegration === prompt.integration) return result.error;
    return null;
  });
  const [info, setInfo] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (returned) invalidateIntegrationInfo(prompt.integration);
    loadIntegrationInfo(prompt.integration).then(loaded => {
      if (!cancelled) setInfo(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [prompt.integration, returned]);

  const name = info?.name || prompt.name || prompt.integration;
  const status = info?.connection?.status;
  const needsScope = prompt.reason === 'insufficient_scope';
  // An `expired` prompt means the vendor just refused the connection the
  // status may still call connected (a cached answer, or tokens that look
  // valid here): only a sign-in that came back to this page fixes it.
  const statusConnected =
    status === 'connected' && (prompt.reason !== 'expired' || returned === 'connected');
  // A missing permission is not fixed by being connected; everything else is.
  const connectedNow =
    !needsScope && (statusConnected || (status === undefined && returned === 'connected'));
  const reconnect = prompt.reason !== 'not_connected' || status === 'needs_reconnect';
  const host = info?.connection?.signInHost;
  const permissions = permissionsByEffect(info?.actions);

  const connect = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startIntegrationConnect(prompt.integration, {
        reconnect,
        scopes: needsScope ? prompt.scopes : undefined,
        navigate
      });
    } catch {
      setStartError(
        t('integrations.connect.startFailed', 'The sign-in to {{name}} could not be started.', {
          name
        })
      );
      setStarting(false);
    }
  };

  if (connectedNow) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200"
        role="status"
      >
        <Icon name="check-circle" size="sm" className="shrink-0" />
        <span>
          {info?.connection?.account
            ? t('integrations.connect.connectedAs', '{{name}} is connected as {{account}}.', {
                name,
                account: info.connection.account
              })
            : t('integrations.connect.connected', '{{name}} is connected.', { name })}
        </span>
      </div>
    );
  }

  if (dismissed) {
    return (
      <div className="my-2 flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <Icon name="lock-closed" size="sm" className="shrink-0" />
        <span>{t('integrations.connect.notNowNote', '{{name}} is not connected.', { name })}</span>
        <button
          type="button"
          onClick={() => setDismissed(false)}
          className="font-medium text-indigo-700 underline hover:text-indigo-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
        >
          {t('integrations.connect.show', 'Show details')}
        </button>
      </div>
    );
  }

  const title = needsScope
    ? t('integrations.connect.titleScope', '{{name}} needs another permission', { name })
    : reconnect
      ? t('integrations.connect.titleReconnect', 'Reconnect {{name}}', { name })
      : t('integrations.connect.title', 'Connect {{name}}', { name });

  let why;
  if (needsScope) {
    why = t(
      'integrations.connect.whyScope',
      'This request needs a permission you have not granted to iHub yet. Reconnecting keeps your connection and adds it.'
    );
  } else if (reconnect) {
    why = t(
      'integrations.connect.whyExpired',
      'Your connection to {{name}} has expired or was revoked. Sign in again to continue; your settings stay as they are.',
      { name }
    );
  } else if (context === 'files') {
    why = t(
      'integrations.connect.whyFiles',
      'To show your files, iHub needs to act as you in {{name}}.',
      { name }
    );
  } else if (prompt.action) {
    why = t(
      'integrations.connect.whyAction',
      'To run “{{action}}” for your request, iHub needs to act as you in {{name}}.',
      { name, action: prompt.action }
    );
  } else {
    why = t(
      'integrations.connect.why',
      'To answer your request, iHub needs to act as you in {{name}}.',
      { name }
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="my-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-3 text-sm text-gray-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-gray-100"
    >
      <div className="flex items-start gap-3">
        <IntegrationLogo info={info} />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-semibold">
            {title}
          </h3>
          <p className="mt-0.5 text-gray-700 dark:text-gray-300">
            {why}
            {host && !needsScope && (
              <> {t('integrations.connect.signInAt', 'You will sign in at {{host}}.', { host })}</>
            )}
          </p>

          {needsScope && prompt.scopes?.length > 0 && (
            <p className="mt-1 text-gray-700 dark:text-gray-300">
              <span className="font-medium">
                {t('integrations.connect.newPermission', 'New permission:')}
              </span>{' '}
              <span className="font-mono text-xs">{prompt.scopes.join(', ')}</span>
            </p>
          )}

          {permissions.length > 0 && (
            <div className="mt-2">
              <p className="font-medium">{t('integrations.connect.permissions', 'Permissions')}</p>
              <ul className="mt-1 space-y-1">
                {permissions.map(group => (
                  <li key={group.effect} className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={EFFECT_TONES[group.effect]} shape="rounded">
                      {t(`integrations.connect.effects.${group.effect}`, group.effect)}
                    </Badge>
                    <span className="text-gray-700 dark:text-gray-300">
                      {group.titles.join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {returned && returned !== 'connected' && (
            <p className="mt-2 text-red-700 dark:text-red-300" role="alert">
              {t(`integrations.connect.errors.${returned}`, {
                name,
                defaultValue: t(
                  'integrations.connect.failed',
                  'Connecting {{name}} did not succeed. Try again.',
                  {
                    name
                  }
                )
              })}
            </p>
          )}
          {startError && (
            <p className="mt-2 text-red-700 dark:text-red-300" role="alert">
              {startError}
            </p>
          )}

          {!readOnly && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={connect}
                disabled={starting}
                className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-60 dark:focus-visible:ring-offset-gray-900"
              >
                <Icon name="link" size="sm" className="mr-1.5" />
                {reconnect
                  ? t('integrations.connect.reconnect', 'Reconnect')
                  : t('integrations.connect.connect', 'Connect')}
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {t('integrations.connect.notNow', 'Not now')}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The Connect cards of one assistant answer (`message.integrationAuthRequired`).
 *
 * @param {Object} props
 * @param {Array<Object>} props.prompts
 * @param {boolean} [props.readOnly]
 * @returns {JSX.Element|null}
 */
function ConnectCards({ prompts, readOnly = false }) {
  const list = normalizeAuthPrompts(prompts);
  if (list.length === 0) return null;
  return list.map(prompt => (
    <ConnectCard key={prompt.integration} prompt={prompt} readOnly={readOnly} />
  ));
}

export default ConnectCards;
