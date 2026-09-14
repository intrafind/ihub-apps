import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Plain-language descriptions of the scopes a connection can hold.
 *
 * Deliberately the same wording as the OAuth consent screen
 * (`server/routes/oauthAuthorize.js`): what a user agreed to and what they are
 * later shown they agreed to should not be two different sentences.
 */
function scopeDescriptions(t) {
  return {
    openid: t('integrations.page.connections.scopes.openid', 'Verify your identity'),
    profile: t(
      'integrations.page.connections.scopes.profile',
      'Access your name and profile information'
    ),
    email: t('integrations.page.connections.scopes.email', 'Access your email address'),
    offline_access: t(
      'integrations.page.connections.scopes.offline_access',
      'Access resources when you are not actively using the app'
    ),
    'mcp:tools:read': t(
      'integrations.page.connections.scopes.mcpToolsRead',
      'List the iHub tools available to you'
    ),
    'mcp:tools:call': t(
      'integrations.page.connections.scopes.mcpToolsCall',
      'Run iHub tools on your behalf'
    ),
    'mcp:apps:invoke': t(
      'integrations.page.connections.scopes.mcpAppsInvoke',
      'Run iHub apps on your behalf'
    ),
    'mcp:workflows:run': t(
      'integrations.page.connections.scopes.mcpWorkflowsRun',
      'Run iHub workflows on your behalf'
    ),
    'mcp:resources:read': t(
      'integrations.page.connections.scopes.mcpResourcesRead',
      'Read iHub sources and skills available to you'
    )
  };
}

function formatDate(value, locale) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
}

/**
 * Settings > Integrations card listing the applications a user has connected.
 *
 * A connection is a grant — this application, these scopes, this date — which
 * is the thing a user can reason about and revoke. It is not the same as the
 * OAuth client record: an application identified by a metadata document has no
 * record at all, and one record can serve many people.
 */
export default function ConnectedAppsCard({
  connections = [],
  tokenExpirationMinutes = 60,
  busy = false,
  onDisconnect
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const descriptions = scopeDescriptions(t);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-start space-x-4">
        <div className="shrink-0">
          <div className="w-12 h-12 bg-purple-600 rounded-lg flex items-center justify-center">
            <Icon name="link" className="w-7 h-7 text-white" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('integrations.page.connections.title', 'Connected apps')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                {t(
                  'integrations.page.connections.description',
                  'Applications you have allowed to access iHub Apps as you. Disconnecting one makes it ask for your permission again.'
                )}
              </p>
            </div>
            <span className="shrink-0 px-3 py-1 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {connections.length}
            </span>
          </div>

          {connections.length === 0 ? (
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'integrations.page.connections.empty',
                'You have not connected any applications yet.'
              )}
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
              {connections.map(connection => {
                const granted = formatDate(connection.grantedAt, locale);
                const lastUsed = formatDate(connection.lastUsedAt, locale);

                return (
                  <li
                    key={`${connection.clientId}:${connection.userId}`}
                    className="py-4 flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {connection.clientName}
                        </span>
                        {connection.clientHost && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                            {connection.clientHost}
                          </span>
                        )}
                      </div>

                      <ul className="mt-2 space-y-1">
                        {connection.scopes.map(scope => (
                          <li
                            key={scope}
                            className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-1.5"
                          >
                            <Icon
                              name="check"
                              className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-500"
                            />
                            <span>{descriptions[scope] || scope}</span>
                          </li>
                        ))}
                      </ul>

                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        {granted &&
                          t('integrations.page.connections.granted', 'Connected {{date}}', {
                            date: granted
                          })}
                        {granted && lastUsed && ' · '}
                        {lastUsed &&
                          t('integrations.page.connections.lastUsed', 'Last used {{date}}', {
                            date: lastUsed
                          })}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDisconnect(connection)}
                      className="shrink-0 rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                    >
                      {t('integrations.page.connections.disconnect', 'Disconnect')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {connections.length > 0 && (
            <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'integrations.page.connections.tokenNote',
                'An access token the app already holds keeps working for up to {{minutes}} minutes after you disconnect. It cannot obtain a new one.',
                { minutes: tokenExpirationMinutes }
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
