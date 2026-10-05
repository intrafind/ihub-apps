import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * How many connections are listed before the rest hide behind "Show all", and
 * the count above which the list gets a search box. A user who connects one
 * desktop client per machine quickly collects a screenful of near-identical
 * entries; the most recently used ones are the ones they come here for.
 */
const VISIBLE_LIMIT = 5;

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

function connectionKey(connection) {
  return `${connection.clientId}:${connection.userId}`;
}

/** Most recent activity first: last use, or the grant for a never-used one. */
function byRecentActivity(a, b) {
  const activityA = a.lastUsedAt || a.grantedAt || '';
  const activityB = b.lastUsedAt || b.grantedAt || '';
  return activityB.localeCompare(activityA);
}

function matchesQuery(connection, query) {
  return [connection.clientName, connection.clientHost, connection.clientId].some(value =>
    String(value || '')
      .toLowerCase()
      .includes(query)
  );
}

/**
 * Settings > Integrations card listing the applications a user has connected.
 *
 * A connection is a grant — this application, these scopes, this date — which
 * is the thing a user can reason about and revoke. It is not the same as the
 * OAuth client record: an application identified by a metadata document has no
 * record at all, and one record can serve many people.
 *
 * Each connection is one compact row; the permissions it holds open on demand,
 * so the list stays scannable when a user has connected many clients.
 */
export default function ConnectedAppsCard({ connections = [], busy = false, onDisconnect }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const descriptions = scopeDescriptions(t);
  const listId = useId();
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => [...connections].sort(byRecentActivity), [connections]);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? sorted.filter(connection => matchesQuery(connection, normalizedQuery))
    : sorted;
  // A search shows every match; otherwise only the most recent few.
  const collapsible = !normalizedQuery && filtered.length > VISIBLE_LIMIT;
  const visible = collapsible && !showAll ? filtered.slice(0, VISIBLE_LIMIT) : filtered;

  const toggle = key => setExpanded(current => ({ ...current, [key]: !current[key] }));

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 sm:p-6">
      <div className="flex items-start sm:space-x-4">
        <div className="hidden sm:block shrink-0">
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
                  'Applications you have allowed to access iHub Apps as you.'
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
            <>
              {connections.length > VISIBLE_LIMIT && (
                <div className="mt-4 relative">
                  <Icon
                    name="search"
                    className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={t('integrations.page.connections.search', 'Search connected apps')}
                    aria-label={t('integrations.page.connections.search', 'Search connected apps')}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 pl-9 pr-3 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                  />
                </div>
              )}

              {filtered.length === 0 ? (
                <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                  {t(
                    'integrations.page.connections.noMatches',
                    'No connected apps match "{{query}}".',
                    { query: query.trim() }
                  )}
                </p>
              ) : (
                <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
                  {visible.map((connection, index) => {
                    const key = connectionKey(connection);
                    const isOpen = !!expanded[key];
                    const detailsId = `${listId}-scopes-${index}`;
                    const granted = formatDate(connection.grantedAt, locale);
                    const lastUsed = formatDate(connection.lastUsedAt, locale);
                    const meta = [
                      lastUsed &&
                        t('integrations.page.connections.lastUsed', 'Last used {{date}}', {
                          date: lastUsed
                        }),
                      granted &&
                        t('integrations.page.connections.granted', 'Connected {{date}}', {
                          date: granted
                        }),
                      t('integrations.page.connections.permissionCount', {
                        count: connection.scopes.length,
                        defaultValue_one: '{{count}} permission',
                        defaultValue_other: '{{count}} permissions'
                      })
                    ].filter(Boolean);

                    return (
                      <li key={key} className="px-3 py-2.5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                          <button
                            type="button"
                            onClick={() => toggle(key)}
                            aria-expanded={isOpen}
                            aria-controls={detailsId}
                            className="flex-1 min-w-0 flex items-start gap-2 text-left rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                          >
                            <Icon
                              name="chevron-right"
                              className={`w-4 h-4 mt-0.5 shrink-0 text-gray-400 transition-transform ${
                                isOpen ? 'rotate-90' : ''
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="flex items-center gap-2 flex-wrap">
                                <span className="min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
                                  {connection.clientName}
                                </span>
                                {connection.clientHost && (
                                  <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                    {connection.clientHost}
                                  </span>
                                )}
                              </span>
                              <span className="block mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                {meta.join(' · ')}
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onDisconnect(connection)}
                            className="self-start ml-6 sm:ml-0 shrink-0 rounded-md border border-red-300 dark:border-red-700 px-3 py-1 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                          >
                            {t('integrations.page.connections.disconnect', 'Disconnect')}
                          </button>
                        </div>

                        {isOpen && (
                          <ul id={detailsId} className="mt-2 ml-6 space-y-1">
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
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {collapsible && (
                <button
                  type="button"
                  onClick={() => setShowAll(current => !current)}
                  className="mt-3 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {showAll
                    ? t('integrations.page.connections.showFewer', 'Show fewer')
                    : t('integrations.page.connections.showAll', 'Show all {{count}}', {
                        count: filtered.length
                      })}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
