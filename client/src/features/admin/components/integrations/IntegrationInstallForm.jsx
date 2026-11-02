// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import LoadingSpinner from '../../../../shared/components/LoadingSpinner';
import IntegrationTestResults from '../IntegrationTestResults';
import { GrantedGroups } from './editors/InstallationEditorParts';
import { groupsGranting } from '../../utils/groupIntegrationAccess';
import ConfigFieldInput, { pickText } from './ConfigFieldInput';
import ActionToggleList from './ActionToggleList';
import { buildActionsPolicy, initialCheckedActions } from './actionsPolicy';
import { mergedLabel } from './installationPayload';
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
} from '../formStyles';
import {
  fetchInstalledIntegration,
  fetchIntegrationDefinition,
  installIntegration,
  testIntegrationDraft,
  updateInstalledIntegration
} from '../../../../api/integrationsAdminApi';
import { fetchAdminGroups, getAdminApiErrorMessage } from '../../../../api/adminApi';

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

/** One validation detail as text: `key: message`, `path.to.field: message` or the message. */
function detailLine(detail) {
  if (detail?.key) return `${detail.key}: ${detail.message}`;
  if (detail?.path) return `${detail.path.join('.')}: ${detail.message}`;
  return detail?.message;
}

function detailText(err) {
  const details = err?.response?.data?.details;
  if (!Array.isArray(details)) return '';
  return details.map(detailLine).filter(Boolean).join('; ');
}

/** `GET /api/admin/groups` → `groups` (id → group), or null when it failed. */
function groupsOf(groupsResult) {
  return groupsResult?.groups && typeof groupsResult.groups === 'object'
    ? groupsResult.groups
    : null;
}

/**
 * The stored installation the form edits, as `GET …/installed/:id` returns
 * it: the one the caller preloaded, else fetched when editing, else none.
 *
 * @param {{ instanceId?: string, isEdit: boolean, preloaded?: Object }} options
 * @returns {Object|null|Promise<Object|null>}
 */
function existingInstallation({ instanceId, isEdit, preloaded }) {
  if (preloaded) return preloaded.existing;
  return isEdit ? fetchInstalledIntegration(instanceId) : Promise.resolve(null);
}

/**
 * The starting values of the admin fields (never a sensitive one): the
 * stored value, else (installing) the prefilled one, else the field's
 * default, else empty.
 *
 * @param {Object} definition - the integration definition
 * @param {Object|null} existing - the stored installation, null when installing
 * @param {boolean} isEdit
 * @param {{ values?: Object }} [prefill]
 * @returns {Object<string, unknown>}
 */
function initialValues(definition, existing, isEdit, prefill) {
  const values = {};
  for (const field of definition.install || []) {
    if (field.sensitive || field.scope !== 'admin') continue;
    values[field.key] =
      existing?.values?.[field.key] ??
      (isEdit ? undefined : prefill?.values?.[field.key]) ??
      field.default ??
      '';
  }
  return values;
}

/** The label of the submit button: "Saving…" while saving, else Save (editing) or Install. */
function submitLabel(t, { saving, isEdit }) {
  if (saving) return t('common.saving', 'Saving…');
  return isEdit ? t('common.save', 'Save') : t('admin.integrationCatalog.install', 'Install');
}

/** Stable default: a fresh `[]` per render would re-run the load effect every render. */
const NO_TAKEN_IDS = [];

/**
 * The generic install / edit form of an integration, built from the
 * definition's install fields: name, settings, sign-in, who may use it and
 * which actions are on, with a test before saving.
 *
 * It renders in two places:
 *
 * - `variant="dialog"` inside `IntegrationInstallDialog` (installing from the
 *   catalog): the form scrolls and the buttons stay at the bottom of the
 *   modal; the parent renders the header.
 * - `variant="page"` on an installation's page (Settings tab), for every
 *   definition without a dedicated editor (see `editors/index.js`).
 *
 * @param {Object} props
 * @param {string} props.definitionId - the definition to install or edit
 * @param {string} [props.instanceId] - edit this installation instead of creating one
 * @param {string[]} [props.takenIds] - existing installation ids (to propose a free one)
 * @param {{ values?: Object, label?: string }} [props.prefill] - install values and
 *   label a new installation starts with (a deep link from another page)
 * @param {{ definition: Object, existing: Object|null }} [props.preloaded] - the
 *   definition and the `GET …/installed/:id` response the caller already has;
 *   skips loading them again
 * @param {'dialog'|'page'} [props.variant='dialog']
 * @param {(definition: Object) => void} [props.onLoaded] - the definition was loaded
 * @param {() => void} props.onCancel
 * @param {(instance: Object) => void} props.onSaved - with the saved installation
 */
function IntegrationInstallForm({
  definitionId,
  instanceId,
  takenIds = NO_TAKEN_IDS,
  prefill,
  preloaded,
  variant = 'dialog',
  onLoaded,
  onCancel,
  onSaved
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const isEdit = Boolean(instanceId);
  const inDialog = variant === 'dialog';
  const formId = inDialog ? 'integration-install-form' : 'integration-settings-form';

  const [definition, setDefinition] = useState(null);
  // The actions the form offers: the definition's, or (dynamic actions,
  // MCP) what the system listed in the edit view or the last test.
  const [knownActions, setKnownActions] = useState([]);
  // The groups (id → group), for who grants the installation; null when unknown.
  const [groups, setGroups] = useState(null);
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
  // What the admin typed into the definition's `test.input` field (a sample search).
  const [testInput, setTestInput] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [def, groupsResult, existing] = await Promise.all([
          preloaded?.definition || fetchIntegrationDefinition(definitionId),
          fetchAdminGroups().catch(() => null),
          existingInstallation({ instanceId, isEdit, preloaded })
        ]);
        if (cancelled) return;
        setDefinition(def);
        onLoaded?.(def);
        setGroups(groupsOf(groupsResult));
        const values = initialValues(def, existing, isEdit, prefill);
        const instance = existing?.instance;
        const { knownActions: actions, checked } = initialCheckedActions({
          definition: def,
          instance,
          liveActions: existing?.actions || []
        });
        setKnownActions(actions);
        setSecretStored(Boolean(instance?.auth?.credentialRef));
        // The stored label in every language (`labelLocalized`); `label` is
        // only the admin's language.
        const storedLabel =
          instance?.labelLocalized && typeof instance.labelLocalized === 'object'
            ? instance.labelLocalized
            : {};
        setForm({
          id: instance?.id || def.singleton?.instanceId || proposeInstanceId(def.id, takenIds),
          label: pickText(storedLabel, lang) || (!isEdit && prefill?.label) || '',
          description: pickText(instance?.description, lang) || '',
          enabled: instance ? instance.enabled !== false : true,
          values,
          authMode: instance?.auth?.mode || def.defaultAuthMode || def.authModes?.[0] || 'none',
          secret: '',
          checkedActions: checked,
          // Kept as stored and sent back: other languages of the label and
          // the per-action overrides have no editor here yet.
          storedLabel,
          storedDescription:
            instance?.description && typeof instance.description === 'object'
              ? instance.description
              : {},
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
    // `onLoaded` is a notification; a new function identity must not reload the form.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [definitionId, instanceId, isEdit, lang, takenIds, prefill, preloaded]);

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
      description: mergedLabel(form.storedDescription, lang, form.description.trim()),
      enabled: form.enabled,
      values,
      auth: { mode: form.authMode },
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
      const payload = buildPayload();
      const inputKey = definition.test?.input?.key;
      if (inputKey && testInput.trim()) payload.testInput = { [inputKey]: testInput.trim() };
      const result = await testIntegrationDraft(definition.id, payload);
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

  if (loading) {
    return (
      <div className={inDialog ? 'flex-1 flex justify-center py-10' : 'flex justify-center py-10'}>
        <LoadingSpinner size="md" />
      </div>
    );
  }
  if (loadError || !definition || !form) {
    return (
      <div className={inDialog ? 'px-6 py-4' : ''}>
        <div className={CALLOUT_CLASS.danger}>{loadError}</div>
      </div>
    );
  }

  const legendClass = 'text-sm font-semibold text-gray-900 dark:text-gray-100';
  const fieldsetClass = 'space-y-3';
  // On the page each step is a card of its own; in the dialog they run on.
  const card = node =>
    inDialog ? (
      node
    ) : (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
        {node}
      </div>
    );

  const body = (
    <form id={formId} onSubmit={save} className={inDialog ? 'space-y-6' : 'space-y-5'}>
      {inDialog && definition.description && (
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
      {card(
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>
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
          <div>
            <label htmlFor="integration-instance-description" className={LABEL_CLASS}>
              {t('admin.integrationCatalog.wizard.description', 'Description')}
            </label>
            <textarea
              id="integration-instance-description"
              className={INPUT_CLASS}
              rows={2}
              value={form.description}
              onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))}
            />
            <p className={HELP_CLASS}>
              {t(
                'admin.integrationCatalog.wizard.descriptionHelp',
                'What this installation holds, for admins and — where the integration reads it, like a people directory — for the model: say what is in it and what to search by.'
              )}
            </p>
          </div>
        </fieldset>
      )}

      {/* 2 Settings */}
      {card(
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>
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
      )}

      {/* 3 Sign-in */}
      {card(
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>
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
      )}

      {/* 4 Who */}
      {card(
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>
            {t('admin.integrationCatalog.wizard.who', '4 · Who may use it')}
          </legend>
          <GrantedGroups
            grantedTo={
              groups
                ? groupsGranting(
                    { id: form.id.trim(), definition: definition.id, type: definition.type },
                    groups
                  )
                : null
            }
          />
          {definition.alwaysInstalled ? (
            <p className={HELP_CLASS}>
              {t(
                'admin.integrationCatalog.wizard.alwaysInstalledHelp',
                'This integration is always installed and enabled; switch single actions off below instead.'
              )}
            </p>
          ) : (
            // On the installation page, the header switches the installation on and off.
            inDialog && (
              <label className="inline-flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input
                  type="checkbox"
                  className={CHECKBOX_CLASS}
                  checked={form.enabled}
                  onChange={e => setForm(prev => ({ ...prev, enabled: e.target.checked }))}
                />
                {t('admin.integrationCatalog.wizard.enabled', 'Enabled')}
              </label>
            )
          )}
        </fieldset>
      )}

      {/* 5 Actions */}
      {card(
        <fieldset className="space-y-2">
          <legend className={legendClass}>
            {t('admin.integrationCatalog.wizard.actions', '5 · Actions the model may call')}
          </legend>
          <ActionToggleList
            actions={knownActions}
            checked={form.checkedActions}
            onToggle={(name, on) =>
              setForm(prev => {
                const next = new Set(prev.checkedActions);
                if (on) next.add(name);
                else next.delete(name);
                return { ...prev, checkedActions: next };
              })
            }
            authMode={form.authMode}
            dynamicActions={Boolean(definition.dynamicActions)}
            storedPolicy={form.storedActions}
          />
        </fieldset>
      )}

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
  );

  const footer = (
    <div
      className={
        inDialog
          ? 'flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700'
          : 'mt-5 flex flex-wrap items-center justify-between gap-3'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
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
        {definition.test?.input && (
          <div>
            <label htmlFor="integration-test-input" className="sr-only">
              {definition.test.input.title}
            </label>
            <input
              id="integration-test-input"
              className={`${INPUT_CLASS} sm:w-64`}
              value={testInput}
              onChange={e => setTestInput(e.target.value)}
              placeholder={definition.test.input.title}
              title={definition.test.input.description || definition.test.input.title}
            />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          type="submit"
          form={formId}
          className={PRIMARY_BUTTON_CLASS}
          disabled={saving || testing || !definition.supported}
        >
          {submitLabel(t, { saving, isEdit })}
        </button>
      </div>
    </div>
  );

  if (!inDialog) {
    return (
      <div data-testid="generic-installation-editor">
        {body}
        {footer}
      </div>
    );
  }
  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-4">{body}</div>
      {footer}
    </>
  );
}

export default IntegrationInstallForm;
