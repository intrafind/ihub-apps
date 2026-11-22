// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  fetchAdminGroups,
  fetchUserAppSettings,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  saveUserAppSettings
} from '../../../api/adminApi';
import {
  fetchInstalledIntegration,
  fetchInstalledIntegrations
} from '../../../api/integrationsAdminApi';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import {
  CHECKBOX_CLASS,
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';

/**
 * Whether this build has the publish routes (slice P12). With `false` the
 * switch "Publishing as a company app" is shown disabled with the note "Not
 * available yet".
 */
export const PUBLISHING_AVAILABLE = true;

/** The system installation: never offered to personal apps. */
const SYSTEM_INSTALLATION_ID = 'ihub';

/** The range of `limits.maxAppsPerUser`; zero means no limit. */
const MAX_APPS_RANGE = { min: 0, max: 100_000 };

/** The audiences of the project panel, in its order. */
const AUDIENCES = [
  ['allowUsers', 'admin.userApps.settings.allowUsers'],
  ['allowGroups', 'admin.userApps.settings.allowGroups'],
  ['allowEveryone', 'admin.userApps.settings.allowEveryone']
];

/** What personal apps may use, beside connected systems. */
const CAPABILITIES = [
  ['modelChoice', 'admin.userApps.capability.model'],
  ['upload', 'admin.userApps.capability.upload'],
  ['webSearch', 'userApps.edit.extras.webSearch'],
  ['skills', 'userApps.edit.extras.skills']
];

/**
 * The names of the groups that hold a permission, their own or inherited.
 *
 * @param {Object<string, Object>} groups - The groups of `GET /api/admin/groups`, by ID.
 * @param {string} permission - `userApps` or `userAppSharing`.
 * @returns {string[]} Group names, in the order of the file.
 *
 * @example
 * groupsWithPermission(
 *   { users: { name: 'Users', permissions: { userApps: true } },
 *     hr: { name: 'HR', inherits: ['users'] } },
 *   'userApps'
 * ); // → ['Users', 'HR']
 */
export function groupsWithPermission(groups, permission) {
  const holds = (id, seen = new Set()) => {
    const group = groups?.[id];
    if (!group || seen.has(id)) return false;
    seen.add(id);
    if (group.permissions?.[permission] === true) return true;
    return (group.inherits || []).some(parent => holds(parent, seen));
  };
  return Object.keys(groups || {})
    .filter(id => groups[id]?.enabled !== false && holds(id))
    .map(id => String(groups[id].name || id));
}

/**
 * The integer a limit field holds, or null when it is no number in the range.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseMaxApps(text) {
  if (!/^\d+$/.test(String(text).trim())) return null;
  const value = Number(text);
  return value >= MAX_APPS_RANGE.min && value <= MAX_APPS_RANGE.max ? value : null;
}

/**
 * The settings of personal apps (`platform.userApps`), on the tab "Personal
 * apps" of Admin → Apps. The first groups of fields are those of the project
 * panel, in its order: the audiences users may share with, the publishing
 * switch, the hint about the group permission, the limits. Then follow the
 * fields only apps have: what personal apps may use, with the connected
 * systems and their functions, and the people whose apps are switched off.
 * Every change applies at once, without a restart. Full admins only: for
 * anyone else the panel is not shown. It is there whether or not the feature
 * is on.
 *
 * @param {Object} props
 * @param {boolean} [props.publishingAvailable] - Whether owners can publish
 *   at all on this build; see {@link PUBLISHING_AVAILABLE}.
 * @returns {JSX.Element|null}
 */
function UserAppSettingsPanel({ publishingAvailable = PUBLISHING_AVAILABLE }) {
  const { t } = useTranslation();
  const featureOn = useFeatureFlags().isEnabled('userApps', false);
  const [stored, setStored] = useState(null);
  const [draft, setDraft] = useState(null);
  const [maxInput, setMaxInput] = useState('');
  const [groups, setGroups] = useState(null);
  // The installations with their functions; null until "Choose…" was opened.
  const [installations, setInstallations] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [people, setPeople] = useState({});
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    fetchUserAppSettings()
      .then(settings => {
        if (!active) return;
        setStored(settings);
        setDraft(settings);
        setMaxInput(String(settings.limits?.maxAppsPerUser ?? ''));
      })
      .catch(err => {
        if (!active) return;
        if (err?.response?.status === 403 || err?.response?.status === 401) setForbidden(true);
        else setError(getAdminApiErrorMessage(err));
      });
    // Who gets the feature: a hint, the panel works without it.
    fetchAdminGroups()
      .then(data => {
        if (active) setGroups(data?.groups || {});
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const blockedOwners = draft?.blockedOwners;
  const hasBlocked = Array.isArray(blockedOwners) && blockedOwners.length > 0;
  useEffect(() => {
    if (!hasBlocked) return undefined;
    let active = true;
    // The names of the blocked people: a hint, their IDs are shown without it.
    makeAdminApiCall('/admin/auth/users')
      .then(response => {
        if (!active) return;
        const names = {};
        for (const user of Object.values(response.data?.users || {})) {
          if (user?.id) names[user.id] = user.name || user.username || user.id;
        }
        setPeople(names);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [hasBlocked]);

  if (forbidden) return null;
  if (!draft) {
    return error ? (
      <p role="alert" className="mb-6 text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    ) : null;
  }

  const maxApps = parseMaxApps(maxInput);
  const maxChanged = maxApps !== stored.limits?.maxAppsPerUser;
  const changed = key => JSON.stringify(draft[key]) !== JSON.stringify(stored[key]);
  const dirty =
    maxChanged ||
    ['sharing', 'capabilities', 'publishing', 'blockedOwners'].some(key => changed(key));

  const change = update => {
    setDraft(update);
    setSaved(false);
  };
  const setSharing = patch =>
    change(previous => ({ ...previous, sharing: { ...previous.sharing, ...patch } }));
  const setCapability = patch =>
    change(previous => ({ ...previous, capabilities: { ...previous.capabilities, ...patch } }));

  const allowed = draft.capabilities?.integrations || [];
  const allowedActions = id => allowed.find(entry => entry.id === id)?.actions || [];
  const toggleAction = (id, action, on) => {
    const actions = on
      ? [...new Set([...allowedActions(id), action])]
      : allowedActions(id).filter(name => name !== action);
    const others = allowed.filter(entry => entry.id !== id);
    // An installation without a ticked function is not on the list at all.
    setCapability({ integrations: actions.length > 0 ? [...others, { id, actions }] : others });
  };

  const openChooser = async () => {
    setChoosing(true);
    if (installations) return;
    try {
      const listed = await fetchInstalledIntegrations();
      const items = (listed?.items || []).filter(item => item.id !== SYSTEM_INSTALLATION_ID);
      const details = await Promise.all(
        items.map(item => fetchInstalledIntegration(item.id).catch(() => null))
      );
      setInstallations(
        items.map((item, index) => ({
          id: item.id,
          label: item.label || item.id,
          actions: (details[index]?.actions || []).map(action => ({
            name: action.name,
            title: action.title || action.name
          }))
        }))
      );
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
      setInstallations([]);
    }
  };

  // What the chooser lists: the installations, and entries of the settings
  // whose installation is gone, so they can be removed.
  const chooserRows = [
    ...(installations || []),
    ...allowed
      .filter(
        entry =>
          entry.id !== SYSTEM_INSTALLATION_ID &&
          !(installations || []).some(item => item.id === entry.id)
      )
      .map(entry => ({
        id: entry.id,
        label: entry.id,
        actions: entry.actions.map(name => ({ name, title: name }))
      }))
  ];
  const installationLabel = id => installations?.find(item => item.id === id)?.label || id;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const settings = await saveUserAppSettings({
        ...(changed('sharing') ? { sharing: draft.sharing } : {}),
        ...(changed('publishing') ? { publishing: draft.publishing } : {}),
        ...(maxChanged ? { limits: { maxAppsPerUser: maxApps } } : {}),
        ...(changed('capabilities') ? { capabilities: draft.capabilities } : {}),
        ...(changed('blockedOwners') ? { blockedOwners: draft.blockedOwners } : {})
      });
      setStored(settings);
      setDraft(settings);
      setMaxInput(String(settings.limits?.maxAppsPerUser ?? ''));
      setSaved(true);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const checkbox = ({ id, checked, onChange, label, help, disabled = false }) => (
    <label
      key={id}
      htmlFor={id}
      className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
    >
      <input
        id={id}
        type="checkbox"
        className={`${CHECKBOX_CLASS} mt-0.5`}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
      <span>
        {label}
        {help && <span className="block text-xs text-gray-600 dark:text-gray-400">{help}</span>}
      </span>
    </label>
  );

  const groupLine = (key, permission) => (
    <p className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
      <span>
        {t(key, {
          list:
            groups === null
              ? '…'
              : groupsWithPermission(groups, permission).join(', ') ||
                t('admin.userApps.settings.none')
        })}
      </span>
      <Link to="/admin/groups" className="text-indigo-600 dark:text-indigo-400 underline">
        {t('admin.userApps.settings.change')}
      </Link>
    </p>
  );

  const legendClass = 'text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

  return (
    <details className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('admin.userApps.settings.title')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
        <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
          <span>{featureOn ? t('admin.userApps.featureOn') : t('admin.userApps.featureOff')}</span>
          {/* A link on its own, not in a sentence: at least 24px high (WCAG 2.5.8). */}
          <Link
            to="/admin/features"
            className="inline-block py-0.5 text-indigo-600 dark:text-indigo-400 underline"
          >
            {t('admin.nav.features')}
          </Link>
        </p>

        <fieldset className="space-y-2">
          <legend className={legendClass}>{t('admin.userApps.settings.shareWith')}</legend>
          {AUDIENCES.map(([key, label]) =>
            checkbox({
              id: `user-app-settings-${key}`,
              checked: draft.sharing?.[key] === true,
              onChange: on => setSharing({ [key]: on }),
              label: t(label)
            })
          )}
          {checkbox({
            id: 'user-app-settings-allowPublish',
            checked: publishingAvailable && draft.sharing?.allowPublish === true,
            disabled: !publishingAvailable,
            onChange: on => setSharing({ allowPublish: on }),
            label: t('admin.userApps.settings.allowPublish'),
            help: publishingAvailable
              ? t('admin.userApps.settings.allowPublishHelp')
              : t('admin.userApps.settings.notAvailable')
          })}
          {publishingAvailable && draft.sharing?.allowPublish === true && (
            <div className="ml-6">
              {checkbox({
                id: 'user-app-settings-adminEnables',
                checked: draft.publishing?.adminEnables === 'always',
                onChange: on =>
                  change(previous => ({
                    ...previous,
                    publishing: {
                      ...previous.publishing,
                      adminEnables: on ? 'always' : 'withTools'
                    }
                  })),
                label: t('admin.userApps.settings.adminEnablesAlways')
              })}
            </div>
          )}
        </fieldset>

        <div className="space-y-1">
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('admin.userApps.settings.permissionHint')}
          </p>
          {groupLine('admin.userApps.settings.groupsCreate', 'userApps')}
          {groupLine('admin.userApps.settings.groupsShare', 'userAppSharing')}
        </div>

        <fieldset className="space-y-2">
          <legend className={legendClass}>{t('admin.userApps.settings.limits')}</legend>
          <label
            htmlFor="user-app-settings-max"
            className="block text-sm text-gray-700 dark:text-gray-300"
          >
            {t('admin.userApps.settings.max')}
          </label>
          <input
            id="user-app-settings-max"
            type="number"
            inputMode="numeric"
            min={MAX_APPS_RANGE.min}
            max={MAX_APPS_RANGE.max}
            step={1}
            value={maxInput}
            onChange={event => {
              setMaxInput(event.target.value);
              setSaved(false);
            }}
            aria-invalid={maxApps === null || undefined}
            aria-describedby="user-app-settings-max-help"
            className={`${INPUT_CLASS} max-w-[12rem] aria-[invalid=true]:border-red-500`}
          />
          <p id="user-app-settings-max-help" className="text-xs text-gray-600 dark:text-gray-400">
            {maxApps === null && (
              <span className="block text-red-700 dark:text-red-300">
                {t('admin.projects.limits.invalid')}
              </span>
            )}
            {t('admin.userApps.settings.maxHelp')}
          </p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className={legendClass}>{t('admin.userApps.settings.mayUse')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CAPABILITIES.map(([key, label]) =>
              checkbox({
                id: `user-app-settings-${key}`,
                checked: draft.capabilities?.[key] === true,
                onChange: on => setCapability({ [key]: on }),
                label: t(label)
              })
            )}
          </div>
          <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
            <span>
              {t('userApps.edit.extras.integrations')}:{' '}
              {allowed.map(entry => installationLabel(entry.id)).join(', ') ||
                t('admin.userApps.settings.none')}
            </span>
            <button
              type="button"
              onClick={choosing ? () => setChoosing(false) : openChooser}
              aria-expanded={choosing}
              aria-controls="user-app-settings-integrations"
              className={SECONDARY_BUTTON_CLASS}
            >
              {t('admin.userApps.settings.choose')}
            </button>
          </p>
          {choosing && (
            <div id="user-app-settings-integrations" className="space-y-3">
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {t('admin.userApps.settings.integrationsHelp')}
              </p>
              {installations === null && (
                <p className="text-sm text-gray-700 dark:text-gray-300">{t('common.loading')}</p>
              )}
              {installations !== null && chooserRows.length === 0 && (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t('admin.userApps.settings.noInstallations')}
                </p>
              )}
              {installations !== null &&
                chooserRows.map(row => (
                  <fieldset
                    key={row.id}
                    className="rounded-md border border-gray-200 dark:border-gray-700 p-3"
                  >
                    <legend className="px-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {row.label}
                    </legend>
                    {row.actions.length === 0 ? (
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        {t('admin.userApps.settings.noActions')}
                      </p>
                    ) : (
                      <div className="grid gap-1 sm:grid-cols-2">
                        {row.actions.map(action =>
                          checkbox({
                            id: `user-app-settings-action-${row.id}-${action.name}`,
                            checked: allowedActions(row.id).includes(action.name),
                            onChange: on => toggleAction(row.id, action.name, on),
                            label: action.title
                          })
                        )}
                      </div>
                    )}
                  </fieldset>
                ))}
            </div>
          )}
        </fieldset>

        <div className="space-y-1">
          <p className={legendClass}>{t('admin.userApps.settings.blocked')}</p>
          {draft.blockedOwners?.length > 0 ? (
            <ul className="space-y-1">
              {draft.blockedOwners.map(id => (
                <li
                  key={id}
                  className="flex flex-wrap items-center gap-3 text-sm text-gray-700 dark:text-gray-300"
                >
                  <span>{people[id] || id}</span>
                  <button
                    type="button"
                    onClick={() =>
                      change(previous => ({
                        ...previous,
                        blockedOwners: previous.blockedOwners.filter(entry => entry !== id)
                      }))
                    }
                    aria-label={`${t('admin.userApps.settings.unblock')}: ${people[id] || id}`}
                    className="text-indigo-600 dark:text-indigo-400 underline"
                  >
                    {t('admin.userApps.settings.unblock')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.userApps.settings.none')}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && (
            <span role="status" className="text-sm text-green-700 dark:text-green-400">
              {t('admin.projects.sharing.saved')}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving || maxApps === null}
            className={PRIMARY_BUTTON_CLASS}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </details>
  );
}

export default UserAppSettingsPanel;
