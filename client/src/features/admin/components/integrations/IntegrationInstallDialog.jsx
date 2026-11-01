// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../../shared/components/Modal';
import Icon from '../../../../shared/components/Icon';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import IntegrationTestResults from '../IntegrationTestResults';
import GroupMultiSelect from '../GroupMultiSelect';
import ConfigFieldInput, { pickText } from './ConfigFieldInput';
import { buildActionsPolicy, isAllowlist } from './actionsPolicy';
import { fieldApplies, secretFieldForMode } from '../../../../shared/utils/configFieldWhen';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PRIMARY_BUTTON_CLASS,
  RADIO_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../people-directories/formStyles';
import {
  fetchInstalledIntegration,
  fetchIntegrationDefinition,
  installIntegration,
  testIntegrationDraft,
  updateInstalledIntegration
} from '../../../../api/integrationsAdminApi';
import { fetchAdminGroups, getAdminApiErrorMessage } from '../../../../api/adminApi';

const SIDE_EFFECT_CLASS = {
  read: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  write: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  destructive: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
  unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
};

const AUTH_MODE_KEYS = {
  none: ['none', 'No sign-in (public API)'],
  'service-account': ['serviceAccount', 'Shared service account (one token for everyone)'],
  'oauth-client': ['oauthClient', 'iHub signs in with one OAuth client (client credentials)'],
  'api-key-user': ['apiKeyUser', 'Each user enters an API key'],
  'oauth-user': ['oauthUser', 'Each user signs in (OAuth)'],
  'enterprise-managed': ['enterpriseManaged', 'Enterprise-managed (IdP)']
};

/** Instance id proposal from a definition id: the last segment, de-duplicated by the caller. */
export function proposeInstanceId(definitionId, taken = []) {
  const base = String(definitionId || 'integration')
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .toLowerCase();
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function detailText(err) {
  const details = err?.response?.data?.details;
  if (!Array.isArray(details)) return '';
  return details
    .map(d =>
      d?.key ? `${d.key}: ${d.message}` : d?.path ? `${d.path.join('.')}: ${d.message}` : d?.message
    )
    .filter(Boolean)
    .join('; ');
}

/**
 * Install (or edit) an instance of an integration definition: a form built
 * from the definition's install fields, the sign-in mode, who may use it and
 * which actions are on, with a test before saving.
 *
 * @param {Object} props
 * @param {string} props.definitionId - definition to install
 * @param {string} [props.instanceId] - edit this instance instead of creating one
 * @param {string[]} [props.takenIds] - existing instance ids (to propose a free one)
 * @param {() => void} props.onClose
 * @param {(instance: Object) => void} props.onSaved
 */
/**
 * The edited translation merged into the stored label object; `undefined`
 * when nothing is left.
 */
function mergedLabel(stored, lang, text) {
  const next = { ...(stored || {}) };
  if (text) next[lang] = text;
  else delete next[lang];
  return Object.keys(next).length ? next : undefined;
}

/** Stable default: a fresh `[]` per render would re-run the load effect every render. */
const NO_TAKEN_IDS = [];

function IntegrationInstallDialog({
  definitionId,
  instanceId,
  takenIds = NO_TAKEN_IDS,
  onClose,
  onSaved
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const isEdit = Boolean(instanceId);

  const [definition, setDefinition] = useState(null);
  // The actions the wizard offers: the definition's, or (dynamic actions,
  // MCP) what the system listed in the edit view or the last test.
  const [knownActions, setKnownActions] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState(null);
  const [secretStored, setSecretStored] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [def, groupsResult, existing] = await Promise.all([
          fetchIntegrationDefinition(definitionId),
          fetchAdminGroups().catch(() => null),
          isEdit ? fetchInstalledIntegration(instanceId) : Promise.resolve(null)
        ]);
        if (cancelled) return;
        setDefinition(def);
        const groupList = groupsResult?.groups
          ? Object.entries(groupsResult.groups).map(([id, g]) => ({ id, name: g.name || id }))
          : Array.isArray(groupsResult)
            ? groupsResult
            : [];
        setGroups(groupList);
        const values = {};
        for (const field of def.install || []) {
          if (field.sensitive || field.scope !== 'admin') continue;
          values[field.key] = existing?.values?.[field.key] ?? field.default ?? '';
        }
        const instance = existing?.instance;
        const actions = def.dynamicActions ? existing?.actions || [] : def.actions || [];
        setKnownActions(actions);
        const defaultOn = new Set(
          actions.filter(a => a.enabledByDefault !== false).map(a => a.name)
        );
        let checked;
        if (def.dynamicActions && instance) {
          checked = new Set(actions.filter(a => a.enabled !== false).map(a => a.name));
        } else if (instance?.actions) {
          const enabled = instance.actions.enabled || ['*'];
          const disabled = new Set(instance.actions.disabled || []);
          checked = new Set(
            actions
              .map(a => a.name)
              .filter(
                name =>
                  !disabled.has(name) &&
                  (enabled.includes(name) || (enabled.includes('*') && defaultOn.has(name)))
              )
          );
        } else {
          checked = defaultOn;
        }
        setSecretStored(Boolean(instance?.auth?.credentialRef));
        setForm({
          id: instance?.id || def.singleton?.instanceId || proposeInstanceId(def.id, takenIds),
          label: pickText(instance?.label, lang) || '',
          enabled: instance ? instance.enabled !== false : true,
          values,
          authMode: instance?.auth?.mode || def.defaultAuthMode || def.authModes?.[0] || 'none',
          secret: '',
          allowedGroups: instance?.allowedGroups || [],
          checkedActions: checked,
          // Kept as stored and sent back: other languages of the label and
          // the per-action overrides have no editor here yet.
          storedLabel: instance?.label && typeof instance.label === 'object' ? instance.label : {},
          overrides: instance?.actions?.overrides || {},
          // The stored policy: sent back unchanged while no actions are known,
          // and it decides whether an allowlist stays one (`buildActionsPolicy`).
          storedActions: instance?.actions || null
        });
      } catch (err) {
        if (!cancelled) setLoadError(getAdminApiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [definitionId, instanceId, isEdit, lang, takenIds]);

  const secretField = useMemo(
    () => secretFieldForMode(definition, form?.authMode),
    [definition, form?.authMode]
  );
  const adminFields = useMemo(
    () => (definition?.install || []).filter(f => f.scope === 'admin' && !f.sensitive),
    [definition]
  );
  // A field with a `when` clause shows only while it applies.
  const visibleFields = adminFields.filter(f =>
    fieldApplies(f, form?.values || {}, form?.authMode)
  );
  const mainFields = visibleFields.filter(f => !f.advanced);
  const advancedFields = visibleFields.filter(f => f.advanced);
  const supportedModes = definition?.supportedAuthModes || ['none', 'service-account'];

  const setValue = (key, value) => {
    setForm(prev => ({ ...prev, values: { ...prev.values, [key]: value } }));
    setFieldErrors(prev => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const buildPayload = () => {
    const values = {};
    for (const [key, value] of Object.entries(form.values)) {
      if (value === '' || value === null || value === undefined) continue;
      // A hidden field's value is dropped: it belongs to another transport or sign-in mode.
      const field = adminFields.find(f => f.key === key);
      if (field && !fieldApplies(field, form.values, form.authMode)) continue;
      values[key] = value;
    }
    const payload = {
      id: form.id.trim(),
      definition: definition.id,
      label: mergedLabel(form.storedLabel, lang, form.label.trim()),
      enabled: form.enabled,
      values,
      auth: { mode: form.authMode },
      allowedGroups: form.allowedGroups,
      actions: buildActionsPolicy({
        knownActions,
        checkedActions: form.checkedActions,
        stored: form.storedActions,
        overrides: form.overrides || {}
      })
    };
    if (secretField && form.secret.trim()) {
      payload.secrets = { [secretField.key]: form.secret.trim() };
    }
    return payload;
  };

  const applyError = err => {
    const data = err?.response?.data;
    if (Array.isArray(data?.details) && data.code === 'INVALID_VALUES') {
      const errors = {};
      for (const d of data.details) if (d?.key) errors[d.key] = d.message;
      setFieldErrors(errors);
    }
    const detail = detailText(err);
    const message = getAdminApiErrorMessage(err);
    setError(detail ? `${message} (${detail})` : message);
  };

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testIntegrationDraft(definition.id, buildPayload());
      setTestResult(result);
      // Dynamic actions: the test listed the server's tools; offer them. A
      // tool seen for the first time starts as the tested policy has it (the
      // stored allowlist or denylist, sent with the draft), so a tool the
      // admin switched off before the server went down stays off.
      if (definition.dynamicActions && Array.isArray(result?.actions) && result.actions.length) {
        setKnownActions(result.actions);
        setForm(prev => {
          const known = new Set(result.actions.map(a => a.name));
          const kept = [...prev.checkedActions].filter(name => known.has(name));
          const fresh = result.actions
            .filter(a => !knownActions.some(k => k.name === a.name) && a.enabled !== false)
            .map(a => a.name);
          return { ...prev, checkedActions: new Set([...kept, ...fresh]) };
        });
      }
    } catch (err) {
      applyError(err);
    } finally {
      setTesting(false);
    }
  };

  const save = async event => {
    event?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      const saved = isEdit
        ? await updateInstalledIntegration(instanceId, payload)
        : await installIntegration(payload);
      onSaved?.(saved);
    } catch (err) {
      applyError(err);
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit
    ? t('admin.integrationCatalog.wizard.editTitle', 'Edit integration')
    : t('admin.integrationCatalog.wizard.installTitle', 'Install integration');

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-3xl"
      labelledBy="integration-install-title"
    >
      <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h2
            id="integration-install-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            {title}
          </h2>
          {definition && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              {definition.name}
              <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                {definition.id} · v{definition.version}
              </span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1"
          aria-label={t('common.close', 'Close')}
        >
          <Icon name="x" size="md" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <div className="flex justify-center py-10">
            <LoadingSpinner size="md" />
          </div>
        )}
        {loadError && <div className={CALLOUT_CLASS.danger}>{loadError}</div>}

        {!loading && definition && form && (
          <form id="integration-install-form" onSubmit={save} className="space-y-6">
            {definition.description && (
              <p className="text-sm text-gray-600 dark:text-gray-400">{definition.description}</p>
            )}
            {definition.runsCode && (
              <div className={CALLOUT_CLASS.warning}>
                {t(
                  'admin.integrationCatalog.wizard.runsCode',
                  'This integration runs its own connector module in the iHub server process. Install it only from a publisher you trust.'
                )}
              </div>
            )}
            {!definition.supported && (
              <div className={CALLOUT_CLASS.warning}>
                {t(
                  'admin.integrationCatalog.unsupportedProtocol',
                  'This integration uses the protocol "{{protocol}}", which this release cannot run yet.',
                  { protocol: definition.protocol }
                )}
              </div>
            )}

            {/* 1 Identity */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.wizard.identity', '1 · Name')}
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="integration-instance-id" className={LABEL_CLASS}>
                    {t('admin.integrationCatalog.wizard.instanceId', 'ID')}
                  </label>
                  <input
                    id="integration-instance-id"
                    className={`${INPUT_CLASS} font-mono`}
                    value={form.id}
                    disabled={isEdit || Boolean(definition.singleton)}
                    onChange={e => setForm(prev => ({ ...prev, id: e.target.value }))}
                    pattern="[a-zA-Z0-9._-]+"
                    required
                  />
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.integrationCatalog.wizard.instanceIdHelp',
                      'Apps refer to the installation by this id. Letters, digits, dots, hyphens.'
                    )}
                  </p>
                </div>
                <div>
                  <label htmlFor="integration-instance-label" className={LABEL_CLASS}>
                    {t('admin.integrationCatalog.wizard.label', 'Label')}
                  </label>
                  <input
                    id="integration-instance-label"
                    className={INPUT_CLASS}
                    value={form.label}
                    onChange={e => setForm(prev => ({ ...prev, label: e.target.value }))}
                    placeholder={definition.name}
                  />
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.integrationCatalog.wizard.labelHelp',
                      'Shown to users in the chat, e.g. "GovData" or "Open Data Norderstedt".'
                    )}
                  </p>
                </div>
              </div>
            </fieldset>

            {/* 2 Settings */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.wizard.settings', '2 · Settings')}
              </legend>
              {mainFields.map(field => (
                <ConfigFieldInput
                  key={field.key}
                  field={field}
                  value={form.values[field.key]}
                  onChange={value => setValue(field.key, value)}
                  language={lang}
                  error={fieldErrors[field.key]}
                />
              ))}
              {advancedFields.length > 0 && (
                <div>
                  <button
                    type="button"
                    className="text-sm text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                    onClick={() => setShowAdvanced(v => !v)}
                    aria-expanded={showAdvanced}
                  >
                    <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size="sm" />
                    {t('admin.integrationCatalog.wizard.advanced', 'Advanced settings')}
                  </button>
                  {showAdvanced && (
                    <div className="mt-3 space-y-3 pl-3 border-l-2 border-gray-200 dark:border-gray-700">
                      {advancedFields.map(field => (
                        <ConfigFieldInput
                          key={field.key}
                          field={field}
                          value={form.values[field.key]}
                          onChange={value => setValue(field.key, value)}
                          language={lang}
                          error={fieldErrors[field.key]}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </fieldset>

            {/* 3 Sign-in */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.wizard.signIn', '3 · Sign-in')}
              </legend>
              <div className="space-y-2">
                {(definition.authModes || []).map(mode => {
                  const [key, fallback] = AUTH_MODE_KEYS[mode] || [mode, mode];
                  const available = supportedModes.includes(mode);
                  return (
                    <label
                      key={mode}
                      className={`flex items-start gap-2 text-sm ${available ? 'text-gray-800 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500'}`}
                    >
                      <input
                        type="radio"
                        name="integration-auth-mode"
                        className={`${RADIO_CLASS} mt-0.5`}
                        value={mode}
                        checked={form.authMode === mode}
                        disabled={!available}
                        onChange={() => setForm(prev => ({ ...prev, authMode: mode }))}
                      />
                      <span>
                        {t(`admin.integrationCatalog.authModes.${key}`, fallback)}
                        {!available && (
                          <span className="ml-1 text-xs">
                            {t('admin.integrationCatalog.wizard.laterRelease', '(later release)')}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {secretField && (
                <ConfigFieldInput
                  field={secretField}
                  value={form.secret}
                  onChange={value => setForm(prev => ({ ...prev, secret: value }))}
                  language={lang}
                  error={fieldErrors[secretField.key]}
                  secretStored={secretStored}
                />
              )}
            </fieldset>

            {/* 4 Who */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.wizard.who', '4 · Who may use it')}
              </legend>
              <GroupMultiSelect
                id="integration-allowed-groups"
                label={t('admin.integrationCatalog.wizard.groups', 'Groups')}
                value={form.allowedGroups}
                onChange={groupsValue => setForm(prev => ({ ...prev, allowedGroups: groupsValue }))}
                availableGroups={groups}
                helpText={t(
                  'admin.integrationCatalog.wizard.groupsHelp',
                  'Leave empty for everyone who may use an app that binds this integration.'
                )}
              />
              <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={form.enabled}
                  onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
                />
                {t('admin.integrationCatalog.wizard.enabled', 'Enabled')}
              </label>
            </fieldset>

            {/* 5 Actions */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.integrationCatalog.wizard.actions', '5 · Actions the model may call')}
              </legend>
              {definition.dynamicActions && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {knownActions.length === 0 && form.storedActions
                    ? t(
                        'admin.integrationCatalog.wizard.dynamicActionsUnavailable',
                        'The server did not list its tools (not reachable, or nobody connected yet). Saving keeps the stored tool selection as it is; test the connection to see and change it.'
                      )
                    : knownActions.length === 0
                      ? t(
                          'admin.integrationCatalog.wizard.dynamicActionsEmpty',
                          'The server lists its tools when iHub connects. Test the connection to see them; every tool is on until you switch some off.'
                        )
                      : isAllowlist(form.storedActions)
                        ? t(
                            'admin.integrationCatalog.wizard.dynamicActionsAllowlistHint',
                            'These are the tools the server lists; only the checked ones may run, and a tool the server adds later stays off until you switch it on.'
                          )
                        : t(
                            'admin.integrationCatalog.wizard.dynamicActionsHint',
                            'These are the tools the server lists; a tool the server adds later is on by default.'
                          )}
                </p>
              )}
              <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
                {knownActions.map(action => {
                  const needsToken = action.connection === 'token' && form.authMode === 'none';
                  const requirement = action.requires
                    ? Object.entries(action.requires)
                        .map(([k, v]) => `${k.replace(/^install\./, '')} = ${String(v)}`)
                        .join(', ')
                    : null;
                  return (
                    <li key={action.name} className="flex items-start gap-3 px-3 py-2">
                      <input
                        id={`integration-action-${action.name}`}
                        type="checkbox"
                        className={`${CHECKBOX_CLASS} mt-1`}
                        checked={form.checkedActions.has(action.name)}
                        onChange={e =>
                          setForm(prev => {
                            const next = new Set(prev.checkedActions);
                            if (e.target.checked) next.add(action.name);
                            else next.delete(action.name);
                            return { ...prev, checkedActions: next };
                          })
                        }
                      />
                      <label
                        htmlFor={`integration-action-${action.name}`}
                        className="flex-1 text-sm"
                      >
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {action.title}
                        </span>
                        <span className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                          {action.name}
                        </span>
                        <span
                          className={`ml-2 inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${SIDE_EFFECT_CLASS[action.sideEffect] || SIDE_EFFECT_CLASS.unknown}`}
                        >
                          {t(
                            `admin.integrationCatalog.sideEffect.${action.sideEffect}`,
                            action.sideEffect
                          )}
                        </span>
                        {action.description && (
                          <span className="block text-gray-600 dark:text-gray-400">
                            {action.description}
                          </span>
                        )}
                        {requirement && (
                          <span className="block text-xs text-gray-500 dark:text-gray-400">
                            {t(
                              'admin.integrationCatalog.wizard.requires',
                              'Requires {{requirement}}',
                              {
                                requirement
                              }
                            )}
                          </span>
                        )}
                        {needsToken && (
                          <span className="block text-xs text-amber-700 dark:text-amber-300">
                            {t(
                              'admin.integrationCatalog.wizard.needsToken',
                              'Needs a shared service account; off while sign-in is "none".'
                            )}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            {error && (
              <div className={CALLOUT_CLASS.danger} role="alert">
                {error}
              </div>
            )}
            {testResult && (
              <IntegrationTestResults
                title={t('admin.integrationCatalog.wizard.testResults', 'Test results')}
                result={testResult}
              />
            )}
          </form>
        )}
      </div>

      {!loading && definition && form && (
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={runTest}
            disabled={testing || saving || !definition.supported}
          >
            <Icon name="play" size="sm" />
            {testing
              ? t('admin.integrationCatalog.wizard.testing', 'Testing…')
              : t('admin.integrationCatalog.wizard.test', 'Test connection')}
          </button>
          <div className="flex gap-2">
            <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              form="integration-install-form"
              className={PRIMARY_BUTTON_CLASS}
              disabled={saving || testing || !definition.supported}
            >
              {saving
                ? t('common.saving', 'Saving…')
                : isEdit
                  ? t('common.save', 'Save')
                  : t('admin.integrationCatalog.install', 'Install')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default IntegrationInstallDialog;
