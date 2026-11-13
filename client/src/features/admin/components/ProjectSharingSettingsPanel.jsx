// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchProjectSettings,
  getAdminApiErrorMessage,
  saveProjectSettings
} from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import ProjectAppSelect from '../../projects/components/ProjectAppSelect';
import { knowledgeModeDescription, knowledgeModeLabel } from '../../projects/utils/knowledgeModes';
import { KNOWLEDGE_MODES } from '../../../../../shared/knowledgeModes.js';
import { LIMIT_FIELDS, LIMIT_LABELS, limitInputsOf, parseLimits } from '../utils/projectLimits';
import {
  CONVERT_CONCURRENCY_RANGE,
  FETCH_CONCURRENCY_RANGE,
  parseRefreshTtl,
  parseWholeNumber,
  REFRESH_MODES,
  REFRESH_WAIT_RANGE,
  parseRefreshIdleDays,
  refreshModeLabel,
  refreshTtlChoices,
  refreshTtlLabel
} from '../../projects/utils/refreshTtl';

import {
  cacheSettingsPatch,
  HEAP_SHARE_PERCENT_RANGE,
  INDEX_CACHE_ENTRIES_RANGE,
  parsePercentShare,
  shareToPercentText
} from '../utils/cacheSettings';

const NUMBER_INPUT_CLASS =
  'block w-32 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2';

/**
 * A whole-number setting with its label and help text.
 *
 * @param {Object} props
 * @param {string} props.id
 * @param {string} props.label
 * @param {string} props.help
 * @param {number} props.value
 * @param {{min: number, max: number}} props.range
 * @param {(value: string) => void} props.onChange
 */
function NumberSetting({ id, label, help, value, range, onChange }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-describedby={`${id}-help`}
        className={NUMBER_INPUT_CLASS}
      />
      <p id={`${id}-help`} className="text-xs text-gray-500 dark:text-gray-400">
        {help}
      </p>
    </div>
  );
}

const TIER_POLICIES = [
  {
    value: 'ihub',
    label: ['admin.projects.tierPolicy.ihub', 'iHub projects only'],
    help: [
      'admin.projects.tierPolicy.ihubHelp',
      'iFinder smart collections are not offered. This is the default.'
    ]
  },
  {
    value: 'both',
    label: ['admin.projects.tierPolicy.both', 'iHub projects and iFinder smart collections'],
    help: [
      'admin.projects.tierPolicy.bothHelp',
      'Users add their iFinder smart collections to their projects from the catalog, and choose the tier when they create a project.'
    ]
  },
  {
    value: 'ifinder',
    label: ['admin.projects.tierPolicy.ifinder', 'iFinder smart collections preferred'],
    help: [
      'admin.projects.tierPolicy.ifinderHelp',
      'Smart collections can be added like under "both". Local projects stay usable and can still be created.'
    ]
  }
];

/**
 * Platform settings of user projects: who users may share their projects with
 * (`platform.projects.sharing`: specific users, groups, everyone signed in and
 * the catalog of published projects) and the tier policy
 * (`platform.projects.tierPolicy`: whether iFinder smart collections can be
 * added), the default app of project chats (`platform.projects.defaultAppId`)
 * and the limits of the local tier (`platform.projects.limits`). Every change
 * applies at once, without a restart. Full admins only: for anyone else the panel is not shown.
 *
 * @returns {JSX.Element|null}
 */
function shareInputsOf(settings) {
  return {
    index: shareToPercentText(settings?.indexCache?.maxHeapShare),
    text: shareToPercentText(settings?.textCache?.maxHeapShare)
  };
}

function ProjectSharingSettingsPanel() {
  const { t } = useTranslation();
  const [stored, setStored] = useState(null);
  const [draft, setDraft] = useState(null);
  const [limitInputs, setLimitInputs] = useState({});
  // The heap shares of the caches, as typed (percent; empty: built-in budget).
  const [shareInputs, setShareInputs] = useState({ index: '', text: '' });
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  // The default app reaches the chat composers through the platform config.
  const { refreshConfig } = usePlatformConfig() || {};

  useEffect(() => {
    let active = true;
    fetchProjectSettings()
      .then(settings => {
        if (!active) return;
        setStored(settings);
        setDraft(settings);
        setLimitInputs(limitInputsOf(settings.limits));
        setShareInputs(shareInputsOf(settings));
      })
      .catch(err => {
        if (!active) return;
        if (err?.response?.status === 403 || err?.response?.status === 401) setForbidden(true);
        else setError(getAdminApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  if (forbidden) return null;
  if (!draft) {
    return error ? (
      <p role="alert" className="mb-6 text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    ) : null;
  }

  const ceiling = stored.maxFilesCeiling;
  const limits = parseLimits(limitInputs, stored.limits || {}, ceiling);
  const limitsChanged = LIMIT_FIELDS.some(
    ({ key }) => limits.invalid.includes(key) || limits.values[key] !== stored.limits?.[key]
  );
  const indexShare = parsePercentShare(shareInputs.index);
  const textShare = parsePercentShare(shareInputs.text);
  const sharesChanged =
    (indexShare.valid ? indexShare.share : undefined) !==
      (stored.indexCache?.maxHeapShare ?? null) ||
    (textShare.valid ? textShare.share : undefined) !== (stored.textCache?.maxHeapShare ?? null);
  const sharesInvalid = !indexShare.valid || !textShare.valid;
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored) || limitsChanged || sharesChanged;
  const updateLimit = (key, text) => {
    setLimitInputs(previous => ({ ...previous, [key]: text }));
    setSaved(false);
  };
  const update = patch => {
    setDraft(previous => ({ ...previous, sharing: { ...previous.sharing, ...patch } }));
    setSaved(false);
  };
  const updateTierPolicy = tierPolicy => {
    setDraft(previous => ({ ...previous, tierPolicy }));
    setSaved(false);
  };
  const updateDefaultApp = defaultAppId => {
    setDraft(previous => ({ ...previous, defaultAppId }));
    setSaved(false);
  };
  const toggleKnowledgeMode = (mode, on) => {
    setDraft(previous => {
      const current = new Set(previous.knowledgeModes || KNOWLEDGE_MODES);
      if (on) current.add(mode);
      else current.delete(mode);
      // `auto` is always offered: it is where a project lands when its mode is switched off.
      current.add('auto');
      return { ...previous, knowledgeModes: KNOWLEDGE_MODES.filter(entry => current.has(entry)) };
    });
    setSaved(false);
  };
  const updateRefreshTtl = value => {
    const refreshTtl = parseRefreshTtl(value);
    if (refreshTtl === null) return;
    setDraft(previous => ({ ...previous, refreshTtl }));
    setSaved(false);
  };

  const updateRefreshMode = value => {
    if (!REFRESH_MODES.includes(value)) return;
    setDraft(previous => ({ ...previous, refreshMode: value }));
    setSaved(false);
  };
  const updateRefreshIdleDays = value => {
    // An emptied field is no number: 0 would silently turn the idle rule off.
    const days = parseRefreshIdleDays(value);
    if (days === null) return;
    setDraft(previous => ({ ...previous, refreshIdleDays: days }));
    setSaved(false);
  };

  const updateRefreshWait = value => {
    const seconds = parseWholeNumber(value, REFRESH_WAIT_RANGE.min, REFRESH_WAIT_RANGE.max);
    if (seconds === null) return;
    setDraft(previous => ({ ...previous, refreshWaitSeconds: seconds }));
    setSaved(false);
  };
  const updateShareInput = (key, text) => {
    setShareInputs(previous => ({ ...previous, [key]: text }));
    setSaved(false);
  };
  const updateIndexEntries = value => {
    const maxEntries = parseWholeNumber(
      value,
      INDEX_CACHE_ENTRIES_RANGE.min,
      INDEX_CACHE_ENTRIES_RANGE.max
    );
    if (maxEntries === null) return;
    setDraft(previous => ({ ...previous, indexCache: { ...previous.indexCache, maxEntries } }));
    setSaved(false);
  };
  const updateIngest = (key, range, value) => {
    const number = parseWholeNumber(value, range.min, range.max);
    if (number === null) return;
    setDraft(previous => ({ ...previous, ingest: { ...previous.ingest, [key]: number } }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const {
        sharing,
        tierPolicy,
        defaultAppId,
        refreshTtl,
        refreshMode,
        refreshIdleDays,
        refreshWaitSeconds,
        ingest,
        indexCache,
        knowledgeModes
      } = draft;
      const ingestChanged = JSON.stringify(ingest) !== JSON.stringify(stored.ingest);
      const modesChanged =
        Array.isArray(knowledgeModes) &&
        JSON.stringify(knowledgeModes) !== JSON.stringify(stored.knowledgeModes);
      const settings = await saveProjectSettings({
        sharing,
        tierPolicy,
        defaultAppId,
        ...(modesChanged ? { knowledgeModes } : {}),
        ...(refreshTtl !== undefined && refreshTtl !== stored.refreshTtl ? { refreshTtl } : {}),
        ...(refreshMode !== undefined && refreshMode !== stored.refreshMode ? { refreshMode } : {}),
        ...(refreshIdleDays !== undefined && refreshIdleDays !== stored.refreshIdleDays
          ? { refreshIdleDays }
          : {}),
        ...(refreshWaitSeconds !== undefined && refreshWaitSeconds !== stored.refreshWaitSeconds
          ? { refreshWaitSeconds }
          : {}),
        ...(ingest && ingestChanged ? { ingest } : {}),
        ...cacheSettingsPatch({ draftIndex: indexCache, stored, indexShare, textShare }),
        ...(limitsChanged ? { limits: limits.values } : {})
      });
      // The default app and the limits reach the project pages through the platform config.
      if (
        settings?.defaultAppId !== stored?.defaultAppId ||
        settings?.refreshMode !== stored?.refreshMode ||
        limitsChanged ||
        modesChanged
      ) {
        refreshConfig?.();
      }
      setStored(settings);
      setDraft(settings);
      setLimitInputs(limitInputsOf(settings.limits));
      setShareInputs(shareInputsOf(settings));
      setSaved(true);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key, label, help) => (
    <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
        checked={draft.sharing[key] === true}
        onChange={e => update({ [key]: e.target.checked })}
      />
      <span>
        {label}
        {help && <span className="block text-xs text-gray-500 dark:text-gray-400">{help}</span>}
      </span>
    </label>
  );

  return (
    <details className="mb-6 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('admin.projects.settings.title', 'Project settings')}
      </summary>
      <div className="px-4 pb-4 space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.projects.tierPolicy.legend', 'Where users find their projects')}
          </legend>
          {TIER_POLICIES.map(({ value, label, help }) => (
            <label
              key={value}
              className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              <input
                type="radio"
                name="project-tier-policy"
                className="mt-0.5 h-4 w-4 border-gray-300 text-indigo-600"
                checked={draft.tierPolicy === value}
                onChange={() => updateTierPolicy(value)}
              />
              <span>
                {t(label[0], label[1])}
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {t(help[0], help[1])}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.tierPolicy.requirements',
              'Smart collections also need iFinder configured (Integrations → iFinder), a user with the fi_smartcollections role and iFinder 6.8 or later. Use the iFinder integration test to check them.'
            )}
          </p>
        </fieldset>
        <div className="space-y-1">
          <label
            htmlFor="project-settings-default-app"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('admin.projects.defaultApp.label', 'Default app for project chats')}
          </label>
          <ProjectAppSelect
            id="project-settings-default-app"
            value={draft.defaultAppId || ''}
            onChange={updateDefaultApp}
            noneLabel={t('admin.projects.defaultApp.none', 'First app in the list')}
            className="block w-full max-w-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.defaultApp.help',
              'A chat in a project starts in the default app of the project; when the project has none, it starts in this app.'
            )}
          </p>
        </div>
        {draft.refreshTtl !== undefined && (
          <div className="space-y-1">
            <label
              htmlFor="project-settings-refresh-ttl"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.projects.refreshTtl.label', 'Refresh files and web pages after')}
            </label>
            <select
              id="project-settings-refresh-ttl"
              value={String(draft.refreshTtl)}
              onChange={e => updateRefreshTtl(e.target.value)}
              className="block w-full max-w-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2"
            >
              {refreshTtlChoices(draft.refreshTtl).map(ttl => (
                <option key={ttl} value={String(ttl)}>
                  {refreshTtlLabel(ttl, t)}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.refreshTtl.help',
                'Files and web pages from websites are fetched again after this time; an unchanged one keeps its text. Projects and items can set their own.'
              )}
            </p>
          </div>
        )}
        {draft.refreshMode !== undefined && (
          <div className="space-y-1">
            <label
              htmlFor="project-settings-refresh-mode"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.projects.refreshMode.label', 'Refresh outdated files and web pages')}
            </label>
            <select
              id="project-settings-refresh-mode"
              value={draft.refreshMode}
              onChange={e => updateRefreshMode(e.target.value)}
              aria-describedby="project-settings-refresh-mode-help"
              className="block w-full max-w-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2"
            >
              {REFRESH_MODES.map(mode => (
                <option key={mode} value={mode}>
                  {refreshModeLabel(mode, t)}
                </option>
              ))}
            </select>
            <p
              id="project-settings-refresh-mode-help"
              className="text-xs text-gray-500 dark:text-gray-400"
            >
              {t(
                'admin.projects.refreshMode.help',
                'Always: refreshed in the background, used or not. Automatically: refreshed in the background while a project is used. When the project is used: outdated ones are not refreshed in the background; using the project (a chat, a search, an app or a workflow reading it, attaching it to a chat; not opening it) refreshes what is outdated, and answers use the stored text until then. Projects and items can set their own.'
              )}
            </p>
          </div>
        )}
        {/* Shown in every mode: a project or an item may set "Automatically" itself. */}
        {draft.refreshIdleDays !== undefined && (
          <div className="space-y-1">
            <label
              htmlFor="project-settings-refresh-idle-days"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t(
                'admin.projects.refreshIdleDays.label',
                'Refresh only when used after (days without use)'
              )}
            </label>
            <input
              id="project-settings-refresh-idle-days"
              type="number"
              min={0}
              max={3650}
              step={1}
              value={draft.refreshIdleDays}
              onChange={e => updateRefreshIdleDays(e.target.value)}
              aria-describedby="project-settings-refresh-idle-days-help"
              className="block w-32 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2"
            />
            <p
              id="project-settings-refresh-idle-days-help"
              className="text-xs text-gray-500 dark:text-gray-400"
            >
              {t(
                'admin.projects.refreshIdleDays.help',
                'For "Automatically, while the project is used": a project nobody used for this many days is no longer refreshed in the background, only when it is used again. 0 always refreshes in the background.'
              )}
            </p>
          </div>
        )}
        {draft.refreshWaitSeconds !== undefined && (
          <NumberSetting
            id="project-settings-refresh-wait"
            label={t(
              'admin.projects.refreshWait.label',
              'Wait for outdated documents before answering (seconds)'
            )}
            help={t(
              'admin.projects.refreshWait.help',
              'Before a chat or a workflow reads a project, its outdated files and web pages are refreshed and waited for up to this long. What is not done by then is read as stored and keeps refreshing. 0 answers at once from what is stored.'
            )}
            value={draft.refreshWaitSeconds}
            range={REFRESH_WAIT_RANGE}
            onChange={updateRefreshWait}
          />
        )}
        {draft.ingest && (
          <>
            <NumberSetting
              id="project-settings-fetch-concurrency"
              label={t(
                'admin.projects.fetchConcurrency.label',
                'Files and web pages checked at once'
              )}
              help={t(
                'admin.projects.fetchConcurrency.help',
                'Per server process. Checking whether a file or page changed takes little memory; at least as many as conversions at once.'
              )}
              value={draft.ingest.fetchConcurrency}
              range={FETCH_CONCURRENCY_RANGE}
              onChange={value => updateIngest('fetchConcurrency', FETCH_CONCURRENCY_RANGE, value)}
            />
            <NumberSetting
              id="project-settings-convert-concurrency"
              label={t('admin.projects.convertConcurrency.label', 'Documents converted at once')}
              help={t(
                'admin.projects.convertConcurrency.help',
                'Per server process: uploads, and files and web pages that changed, are read into text this many at a time. Each conversion can take a lot of memory.'
              )}
              value={draft.ingest.concurrency}
              range={CONVERT_CONCURRENCY_RANGE}
              onChange={value => updateIngest('concurrency', CONVERT_CONCURRENCY_RANGE, value)}
            />
          </>
        )}
        {draft.indexCache && (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.projects.caches.legend', 'Memory of project search')}
            </legend>
            <NumberSetting
              id="project-settings-index-entries"
              label={t('admin.projects.caches.indexEntries.label', 'Search indexes kept in memory')}
              help={t(
                'admin.projects.caches.indexEntries.help',
                'Per server process, one per project. A project whose index is not in memory is indexed again on its next question, which takes 60 to 90 ms of processing time for a large project. Raise it when many projects are in use at the same time.'
              )}
              value={draft.indexCache.maxEntries}
              range={INDEX_CACHE_ENTRIES_RANGE}
              onChange={updateIndexEntries}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['index', 'indexShare', 'Memory share of the search indexes (%)'],
                ['text', 'textShare', 'Memory share of the cached document texts (%)']
              ].map(([key, name, fallback]) => {
                const id = `project-settings-${key}-share`;
                const invalid = !(key === 'index' ? indexShare : textShare).valid;
                return (
                  <div key={key} className="space-y-1">
                    <label htmlFor={id} className="block text-sm text-gray-700 dark:text-gray-300">
                      {t(`admin.projects.caches.${name}.label`, fallback)}
                    </label>
                    <input
                      id={id}
                      type="number"
                      inputMode="decimal"
                      min={HEAP_SHARE_PERCENT_RANGE.min}
                      max={HEAP_SHARE_PERCENT_RANGE.max}
                      step="any"
                      placeholder={t('admin.projects.caches.builtIn', 'Built-in')}
                      value={shareInputs[key]}
                      onChange={e => updateShareInput(key, e.target.value)}
                      aria-invalid={invalid || undefined}
                      aria-describedby={`${id}-help`}
                      className="block w-full max-w-[12rem] rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2 aria-[invalid=true]:border-red-500"
                    />
                    <p id={`${id}-help`} className="text-xs text-gray-500 dark:text-gray-400">
                      {invalid && (
                        <span className="block text-red-600 dark:text-red-400">
                          {t('admin.projects.caches.invalid', 'Enter 1 to 50, or leave empty.')}
                        </span>
                      )}
                      {t(
                        `admin.projects.caches.${name}.help`,
                        key === 'index'
                          ? "Share of the server process's memory the indexes may use. Empty: 10 %, at most about 135 MB."
                          : "Share of the server process's memory the decrypted texts may use. Empty: 6 %, at most 96 MB."
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.caches.hint',
                'Each server process (worker) holds its own copy, so memory grows with the number of workers. A share you enter replaces the built-in maximum. Check the cache metrics before raising it.'
              )}
            </p>
          </fieldset>
        )}
        {Array.isArray(draft.knowledgeModes) && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.projects.knowledgeModes.legend', 'Knowledge modes users may choose')}
            </legend>
            {KNOWLEDGE_MODES.map(mode => (
              <label
                key={mode}
                className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={draft.knowledgeModes.includes(mode)}
                  disabled={mode === 'auto'}
                  onChange={e => toggleKnowledgeMode(mode, e.target.checked)}
                />
                <span>
                  {knowledgeModeLabel(t, mode)}
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {knowledgeModeDescription(t, mode)}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.projects.knowledgeModes.help',
                'Switch off a mode, for example full context to save cost. A project or chat that uses it falls back to automatic; the links of apps and workflows keep the mode an administrator set.'
              )}
            </p>
          </fieldset>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.projects.sharing.legend', 'Users may share their projects with')}
          </legend>
          {toggle('allowUsers', t('admin.projects.sharing.allowUsers', 'Specific users'))}
          {toggle('allowGroups', t('admin.projects.sharing.allowGroups', 'Groups'))}
          {toggle(
            'allowEveryone',
            t('admin.projects.sharing.allowEveryone', 'Everyone signed in'),
            t(
              'admin.projects.sharing.allowEveryoneHelp',
              'The project appears for every user, marked "Global".'
            )
          )}
          {toggle(
            'allowCatalog',
            t('admin.projects.sharing.allowCatalog', 'The project catalog'),
            t(
              'admin.projects.sharing.allowCatalogHelp',
              'Owners and editors publish a project; every user can browse the catalog and add it to their projects. Turning this off hides published projects again.'
            )
          )}
        </fieldset>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.projects.sharing.permissionHint',
            'Users also need the "projectSharing" permission of their group.'
          )}
        </p>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('admin.projects.limits.legend', 'Limits of user projects')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMIT_FIELDS.map(({ key, min, max, decimals }) => {
              const id = `project-settings-limit-${key}`;
              const invalid = limits.invalid.includes(key);
              return (
                <div key={key} className="space-y-1">
                  <label htmlFor={id} className="block text-sm text-gray-700 dark:text-gray-300">
                    {t(`admin.projects.limits.${key}`, LIMIT_LABELS[key][0])}
                  </label>
                  <input
                    id={id}
                    type="number"
                    inputMode={decimals ? 'decimal' : 'numeric'}
                    min={min}
                    max={key === 'maxFiles' ? ceiling : max}
                    step={decimals ? 'any' : 1}
                    value={limitInputs[key] ?? ''}
                    onChange={e => updateLimit(key, e.target.value)}
                    aria-invalid={invalid || undefined}
                    aria-describedby={`${id}-help`}
                    className="block w-full max-w-[12rem] rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2 aria-[invalid=true]:border-red-500"
                  />
                  <p id={`${id}-help`} className="text-xs text-gray-500 dark:text-gray-400">
                    {invalid && (
                      <span className="block text-red-600 dark:text-red-400">
                        {t('admin.projects.limits.invalid', 'Enter a number in the allowed range.')}
                      </span>
                    )}
                    {t(`admin.projects.limits.${key}Help`, LIMIT_LABELS[key][1], { max: ceiling })}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.projects.limits.applyHint',
              'Changes apply at once. Lowering a limit removes nothing; it only refuses what would go past it.'
            )}
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && !dirty && (
            <span className="text-sm text-green-700 dark:text-green-400">
              {t('admin.projects.sharing.saved', 'Saved')}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving || limits.invalid.length > 0 || sharesInvalid}
            className="px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </details>
  );
}

export default ProjectSharingSettingsPanel;
