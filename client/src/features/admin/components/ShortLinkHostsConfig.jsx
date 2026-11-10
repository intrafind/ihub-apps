// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';

/**
 * The host of a pasted URL (`https://www.example.com/x` → `www.example.com`);
 * anything else as typed. The server refuses URLs, so a pasted one is reduced here.
 *
 * @param {string} value
 * @returns {string}
 */
export function hostEntryFromInput(value) {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Admin → Short Links → Allowed external hosts: `platform.shortLinks.allowedHosts`,
 * the hosts a short link may redirect to with an absolute URL. Also lists the hosts
 * that stored links lead to but the list refuses, each with a button to allow it.
 */
function ShortLinkHostsConfig() {
  const { t } = useTranslation();
  const [allowedHosts, setAllowedHosts] = useState([]);
  const [blockedHosts, setBlockedHosts] = useState([]);
  const [newHost, setNewHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await makeAdminApiCall('/admin/shortlinks/config');
        setAllowedHosts(response.data?.allowedHosts ?? []);
        setBlockedHosts(response.data?.blockedHosts ?? []);
      } catch (error) {
        setMessage({
          type: 'error',
          text: apiErrorMessage(
            error,
            t,
            t('admin.shortlinks.allowedHosts.loadError', 'The allowed hosts could not be loaded.')
          )
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const addHost = value => {
    const entry = hostEntryFromInput(value);
    if (!entry) return;
    setAllowedHosts(prev => (prev.includes(entry) ? prev : [...prev, entry]));
    setMessage(null);
  };

  const handleAdd = () => {
    addHost(newHost);
    setNewHost('');
  };

  const handleRemove = host => {
    setAllowedHosts(prev => prev.filter(h => h !== host));
    setMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await makeAdminApiCall('/admin/shortlinks/config', {
        method: 'PUT',
        body: { allowedHosts }
      });
      setAllowedHosts(response.data?.allowedHosts ?? allowedHosts);
      setBlockedHosts(response.data?.blockedHosts ?? []);
      setMessage({
        type: 'success',
        text: t('admin.shortlinks.allowedHosts.saved', 'Allowed hosts saved.')
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: apiErrorMessage(
          error,
          t,
          t('admin.shortlinks.allowedHosts.saveError', 'The allowed hosts could not be saved.')
        )
      });
    } finally {
      setSaving(false);
    }
  };

  // Hosts of stored links that are still refused once the list is saved as it stands.
  const pendingBlocked = blockedHosts.filter(({ host }) => !allowedHosts.includes(host));

  return (
    <section
      id="allowed-hosts"
      aria-labelledby="short-link-allowed-hosts-title"
      className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6"
    >
      <div className="flex items-start mb-4">
        <Icon name="ShieldCheckIcon" className="w-6 h-6 mr-2 text-blue-500 shrink-0" />
        <div>
          <h2
            id="short-link-allowed-hosts-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {t('admin.shortlinks.allowedHosts.title', 'Allowed external hosts')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.shortlinks.allowedHosts.description',
              'Short links can always lead to pages of this installation. A link to another website works only when its host is on this list. The SSRF allowlist does not apply to short links.'
            )}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('common.loading', 'Loading...')}
        </p>
      ) : (
        <>
          <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg flex">
            <Icon
              name="ExclamationTriangleIcon"
              className="w-5 h-5 text-yellow-700 dark:text-yellow-400 mt-0.5 mr-3 shrink-0"
            />
            <p className="text-sm text-yellow-800 dark:text-yellow-300">
              {t(
                'admin.shortlinks.allowedHosts.warning',
                'A short link of this installation can send visitors to every host on this list, and anyone who may create short links can use it. Only add hosts you trust.'
              )}
            </p>
          </div>

          {message && (
            <div
              role={message.type === 'error' ? 'alert' : 'status'}
              className={`p-3 rounded-md mb-4 text-sm ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </div>
          )}

          {pendingBlocked.length > 0 && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                {t('admin.shortlinks.allowedHosts.blockedTitle', 'Links that do not work')}
              </h3>
              <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                {t(
                  'admin.shortlinks.allowedHosts.blockedDescription',
                  'Existing short links lead to these hosts, which are not on the list. They answer "Not found" until you allow the host and save.'
                )}
              </p>
              <ul className="mt-2 space-y-1">
                {pendingBlocked.map(({ host, links }) => (
                  <li key={host} className="flex items-center justify-between gap-2">
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                      {host}{' '}
                      <span className="font-sans text-gray-600 dark:text-gray-400">
                        (
                        {t('admin.shortlinks.allowedHosts.linkCount', '{{count}} links', {
                          count: links
                        })}
                        )
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => addHost(host)}
                      aria-label={t(
                        'admin.shortlinks.allowedHosts.allowHostLabel',
                        'Allow {{host}}',
                        {
                          host
                        }
                      )}
                      className="shrink-0 text-sm font-medium text-blue-700 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {t('admin.shortlinks.allowedHosts.allowHost', 'Allow')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newHost}
              onChange={e => setNewHost(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAdd();
              }}
              aria-label={t('admin.shortlinks.allowedHosts.inputLabel', 'Host to allow')}
              placeholder={t(
                'admin.shortlinks.allowedHosts.placeholder',
                'www.example.com, *.example.com'
              )}
              className="flex-1 min-w-0 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newHost.trim()}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
              {t('admin.shortlinks.allowedHosts.addHost', 'Add host')}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t(
              'admin.shortlinks.allowedHosts.patternHelp',
              'An exact host (www.example.com), any subdomain (*.example.com or .example.com, not example.com itself), or a /regular expression/ matched against the whole host. A pasted URL is reduced to its host.'
            )}
          </p>

          {allowedHosts.length > 0 ? (
            <ul className="space-y-2 mb-4">
              {allowedHosts.map(host => (
                <li
                  key={host}
                  className="flex items-center justify-between gap-2 p-3 bg-gray-50 dark:bg-gray-700 rounded-md"
                >
                  <span className="flex items-center min-w-0">
                    <Icon
                      name="GlobeAltIcon"
                      className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2 shrink-0"
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100 font-mono break-all">
                      {host}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemove(host)}
                    aria-label={t(
                      'admin.shortlinks.allowedHosts.removeHostLabel',
                      'Remove {{host}}',
                      { host }
                    )}
                    className="shrink-0 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-sm font-medium"
                  >
                    {t('admin.shortlinks.allowedHosts.removeHost', 'Remove')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-3 bg-gray-50 dark:bg-gray-700 rounded-md text-center text-sm text-gray-600 dark:text-gray-400 mb-4">
              {t(
                'admin.shortlinks.allowedHosts.noHosts',
                'No external hosts allowed. Short links lead only to pages of this installation.'
              )}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
              {saving
                ? t('admin.shortlinks.allowedHosts.saving', 'Saving…')
                : t('admin.shortlinks.allowedHosts.save', 'Save allowed hosts')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default ShortLinkHostsConfig;
