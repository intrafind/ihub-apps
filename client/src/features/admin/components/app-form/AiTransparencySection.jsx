import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import JustificationDialog from '../../../../shared/components/JustificationDialog';
import Icon from '../../../../shared/components/Icon';
import { useAuth } from '../../../../shared/contexts/AuthContext';
import { usePlatformConfig } from '../../../../shared/contexts/PlatformConfigContext';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../../api/adminApi';
import { EXEMPTION_TYPES, SENSITIVE_CATEGORIES } from '../../../../../../shared/aiTransparency.js';
import { isForeignRecord } from '../../utils/aiTransparencyAdmin';

/** English fallbacks for the sensitive-context options (`admin.apps.aiTransparency.sensitive.<key>`). */
const SENSITIVE_FALLBACKS = Object.freeze({
  legal: 'Legal',
  finance: 'Finance',
  health: 'Health',
  complaints: 'Complaints',
  vulnerable: 'Vulnerable people'
});

/** English fallbacks for the exemption types (`admin.apps.aiTransparency.exemption.types.<key>`). */
const EXEMPTION_FALLBACKS = Object.freeze({
  standardEditing: {
    label: 'Standard editing',
    description:
      'Grammar and spell checking, minor stylistic polishing, translation, format conversion, transcription — no substantial alteration of the input.'
  },
  b2bTechnical: {
    label: 'Technical B2B output',
    description:
      'Strictly technical output, seen only by a limited, pre-defined group of professionals inside the organisation, and not meant to leave it (all three must hold).'
  }
});

const inputClass =
  'mt-1 block w-full rounded-md border-gray-300 bg-white text-gray-900 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';
const secondaryButton =
  'inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-xs hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600';

/**
 * Format a record timestamp for the admin's language.
 * @param {string} value - ISO timestamp
 * @param {string} language - i18n language code
 * @returns {string}
 */
function formatDate(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return date.toLocaleString(language || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

/**
 * Who/when/why/where of one installation record, as a definition list.
 *
 * @param {Object} props
 * @param {string} props.by - Name (or id) of the admin who made the record
 * @param {string} props.at - ISO timestamp
 * @param {string} props.reason - The justification
 * @param {Object} props.record - The record (installation fields)
 * @param {boolean} props.foreign - Whether it was made on another installation
 * @returns {JSX.Element}
 */
function RecordDetails({ by, at, reason, record, foreign }) {
  const { t, i18n } = useTranslation();
  const installation = [
    record.installationUrl,
    record.installationId && `(${record.installationId})`
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="mt-2 space-y-2">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="font-medium text-gray-500 dark:text-gray-400">
          {t('admin.apps.aiTransparency.record.by', 'Decided by')}
        </dt>
        <dd className="text-gray-900 dark:text-gray-100">
          {by || '—'}
          {at ? ` · ${formatDate(at, i18n.language)}` : ''}
        </dd>
        <dt className="font-medium text-gray-500 dark:text-gray-400">
          {t('admin.apps.aiTransparency.record.reason', 'Reason')}
        </dt>
        <dd className="whitespace-pre-line break-words text-gray-900 dark:text-gray-100">
          {reason || '—'}
        </dd>
        <dt className="font-medium text-gray-500 dark:text-gray-400">
          {t('admin.apps.aiTransparency.record.installation', 'Installation')}
        </dt>
        <dd className="break-all text-gray-900 dark:text-gray-100">
          {installation || '—'}
          {record.ihubVersion ? ` · iHub ${record.ihubVersion}` : ''}
        </dd>
      </dl>
      {foreign && (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
          <Icon
            name="exclamation-triangle"
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <span>
            {t(
              'admin.apps.aiTransparency.record.foreign',
              'This record was made on another installation and is not in effect here. An administrator of this installation has to decide again.'
            )}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Status pill with icon and text (never colour alone).
 *
 * @param {Object} props
 * @param {'ok'|'warning'} props.tone
 * @param {string} props.children - Status text
 * @returns {JSX.Element}
 */
function StatusPill({ tone, children }) {
  const classes =
    tone === 'ok'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200'
      : 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${classes}`}
    >
      <Icon
        name={tone === 'ok' ? 'check-circle' : 'exclamation-triangle'}
        className="h-3.5 w-3.5"
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

/**
 * "EU AI Act" section of the app editor (issue #2564/#2565, concept §8.2).
 *
 * Two kinds of settings live here, and they are saved differently on purpose:
 *
 * - **Records** — the Art. 50(1) disclosure opt-out and the Art. 50(2)
 *   exemption. They document a decision of one installation, so only full
 *   administrators make them, always with a written reason, through the
 *   dedicated audited endpoints (`/admin/ai-transparency/apps/:id/…`). They
 *   are never part of the normal app save; content admins see them
 *   read-only. After a change the stored records are re-read and merged into
 *   the editor via `onRecordsChange`, so unsaved edits elsewhere survive.
 * - **Plain settings** — sensitive context, reminder interval, first-turn
 *   notice, signpost overrides. They are ordinary app config and are saved
 *   with the app.
 *
 * @param {Object} props
 * @param {Object} props.app - App config being edited (admin view, with records)
 * @param {(app: Object) => void} props.onChange - Updates the app in the editor
 * @param {string|null} [props.appId] - Id of the saved app; null for a new, unsaved one
 * @param {(records: {disclosureOptOut: Object|null, exemption: Object|null}) => void} [props.onRecordsChange]
 *   Called with the stored records after an opt-out / exemption change
 * @returns {JSX.Element}
 */
function AiTransparencySection({ app, onChange, appId = null, onRecordsChange = null }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { platformConfig } = usePlatformConfig();
  const canManageRecords = Boolean(user?.isAdmin || user?.permissions?.adminAccess);
  const block = app.aiTransparency || {};
  const optOut = block.disclosureOptOut || null;
  const exemption = block.exemption || null;
  const aiConfig = platformConfig?.aiTransparency;
  const [installationId, setInstallationId] = useState(null);
  const [dialog, setDialog] = useState(null); // 'optOut' | 'exemption' | null
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Which installation this is, to tell records copied in from elsewhere
  // apart. Admin-only endpoint; a content admin simply sees no hint.
  useEffect(() => {
    if (!canManageRecords) return undefined;
    let active = true;
    makeAdminApiCall('/admin/ai-transparency/settings')
      .then(response => {
        if (active) setInstallationId(response?.data?.installation?.installationId || null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [canManageRecords]);

  /** Re-read the stored records and hand them to the page. */
  const refreshRecords = useCallback(
    async fallback => {
      let records = fallback;
      try {
        const response = await makeAdminApiCall(`/admin/apps/${encodeURIComponent(appId)}`);
        const stored = response?.data?.aiTransparency || {};
        records = {
          disclosureOptOut: stored.disclosureOptOut || null,
          exemption: stored.exemption || null
        };
      } catch {
        // Keep the endpoint's own answer when the re-read fails.
      }
      onRecordsChange?.(records);
    },
    [appId, onRecordsChange]
  );

  const recordsPath = `/admin/ai-transparency/apps/${encodeURIComponent(appId || '')}`;

  const switchOff = async reason => {
    const response = await makeAdminApiCall(`${recordsPath}/disclosure-opt-out`, {
      method: 'PUT',
      body: { reason }
    });
    setDialog(null);
    await refreshRecords({
      disclosureOptOut: response?.data?.disclosureOptOut || null,
      exemption
    });
  };

  const declareExemption = async (justification, type) => {
    const response = await makeAdminApiCall(`${recordsPath}/exemption`, {
      method: 'PUT',
      body: { type, justification }
    });
    setDialog(null);
    await refreshRecords({
      disclosureOptOut: optOut,
      exemption: response?.data?.exemption || null
    });
  };

  const removeRecord = async kind => {
    setBusy(true);
    setActionError(null);
    try {
      await makeAdminApiCall(
        `${recordsPath}/${kind === 'optOut' ? 'disclosure-opt-out' : 'exemption'}`,
        { method: 'DELETE' }
      );
      await refreshRecords({
        disclosureOptOut: kind === 'optOut' ? null : optOut,
        exemption: kind === 'exemption' ? null : exemption
      });
    } catch (error) {
      setActionError(getAdminApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  // ── plain settings (saved with the app) ───────────────────────────────
  const setField = (key, value) => {
    const next = { ...block };
    if (value === undefined) delete next[key];
    else next[key] = value;
    const updated = { ...app };
    if (Object.keys(next).length > 0) updated.aiTransparency = next;
    else delete updated.aiTransparency;
    onChange(updated);
  };

  const setSignpost = (key, mode) => {
    const signpost = { ...(block.signpost || {}) };
    if (mode === 'on') signpost[key] = true;
    else if (mode === 'off') signpost[key] = false;
    else delete signpost[key];
    setField('signpost', Object.keys(signpost).length > 0 ? signpost : undefined);
  };

  const signpostMode = key =>
    block.signpost?.[key] === true ? 'on' : block.signpost?.[key] === false ? 'off' : 'default';

  const platformReminder = aiConfig?.interactionDisclosure?.reminderInterval;
  const onOff = value =>
    value ? t('admin.apps.aiTransparency.on', 'On') : t('admin.apps.aiTransparency.off', 'Off');
  // Off platform-wide (feature or interaction disclosure switched off): the
  // app's own setting does not matter then, but the admin should know.
  const platformDisclosureOff = aiConfig ? aiConfig.interactionDisclosure?.enabled !== true : false;
  const disclosureOff = Boolean(optOut) && !isForeignRecord(optOut, installationId);
  const exemptionActive = Boolean(exemption) && !isForeignRecord(exemption, installationId);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.aiTransparency.title', 'EU AI Act')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.aiTransparency.description',
              'Art. 50 transparency for this app: telling people they talk to an AI system, reminders in sensitive contexts, and exemptions from machine-readable marking.'
            )}
          </p>
        </div>
        <div className="mt-5 space-y-6 md:col-span-2 md:mt-0">
          {!canManageRecords && (
            <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Icon name="lock-closed" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t(
                'admin.apps.aiTransparency.readOnlyHint',
                'Only administrators can switch off the disclosure or declare an exemption.'
              )}
            </p>
          )}
          {!appId && canManageRecords && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t(
                'admin.apps.aiTransparency.saveFirst',
                'Save the app first to switch off the disclosure or declare an exemption.'
              )}
            </p>
          )}
          {actionError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
            >
              {actionError}
            </div>
          )}

          {/* Art. 50(1) interaction disclosure */}
          <section aria-labelledby="ai-transparency-disclosure-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4
                id="ai-transparency-disclosure-heading"
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.aiTransparency.disclosure.title', 'AI disclosure (Art. 50(1))')}
              </h4>
              <StatusPill tone={disclosureOff || platformDisclosureOff ? 'warning' : 'ok'}>
                {platformDisclosureOff
                  ? t('admin.apps.aiTransparency.disclosure.statusPlatformOff', 'Off platform-wide')
                  : disclosureOff
                    ? t('admin.apps.aiTransparency.disclosure.statusOff', 'Off for this app')
                    : t('admin.apps.aiTransparency.disclosure.statusOn', 'On')}
              </StatusPill>
            </div>
            {platformDisclosureOff && (
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                {t(
                  'admin.apps.aiTransparency.disclosure.platformOffHint',
                  'The interaction disclosure is switched off for the whole installation (Admin → EU AI Act). No app shows it until it is switched back on there.'
                )}
              </p>
            )}
            {optOut ? (
              <RecordDetails
                by={optOut.disabledByName || optOut.disabledBy}
                at={optOut.disabledAt}
                reason={optOut.reason}
                record={optOut}
                foreign={isForeignRecord(optOut, installationId)}
              />
            ) : (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {t(
                  'admin.apps.aiTransparency.disclosure.onDescription',
                  'People see a notice before their first message, an "AI" badge next to the input and an "AI generated" chip on every answer.'
                )}
              </p>
            )}
            {canManageRecords && appId && (
              <div className="mt-3">
                {optOut ? (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() => removeRecord('optOut')}
                  >
                    {t('admin.apps.aiTransparency.disclosure.switchOn', 'Switch back on')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() => setDialog('optOut')}
                  >
                    {t('admin.apps.aiTransparency.disclosure.switchOff', 'Switch off disclosure…')}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Art. 50(2) exemption */}
          <section aria-labelledby="ai-transparency-exemption-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4
                id="ai-transparency-exemption-heading"
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t('admin.apps.aiTransparency.exemption.title', 'Marking exemption (Art. 50(2))')}
              </h4>
              <StatusPill tone={exemptionActive ? 'warning' : 'ok'}>
                {exemptionActive
                  ? t(
                      `admin.apps.aiTransparency.exemption.types.${exemption.type}.label`,
                      EXEMPTION_FALLBACKS[exemption.type]?.label || exemption.type
                    )
                  : t('admin.apps.aiTransparency.exemption.none', 'None — answers are marked')}
              </StatusPill>
            </div>
            {exemption ? (
              <RecordDetails
                by={exemption.declaredByName || exemption.declaredBy}
                at={exemption.declaredAt}
                reason={exemption.justification}
                record={exemption}
                foreign={isForeignRecord(exemption, installationId)}
              />
            ) : (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {t(
                  'admin.apps.aiTransparency.exemption.noneDescription',
                  'Answers of this app are marked machine-readably where the model supports it. Declare an exemption only for standard editing or strictly technical B2B output.'
                )}
              </p>
            )}
            {canManageRecords && appId && (
              <div className="mt-3">
                {exemption ? (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() => removeRecord('exemption')}
                  >
                    {t('admin.apps.aiTransparency.exemption.withdraw', 'Withdraw exemption')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() => setDialog('exemption')}
                  >
                    {t('admin.apps.aiTransparency.exemption.declare', 'Declare exemption…')}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Plain settings, saved with the app */}
          <div className="grid grid-cols-6 gap-6 border-t border-gray-200 pt-6 dark:border-gray-700">
            <div className="col-span-6 sm:col-span-3">
              <label
                htmlFor="aiTransparency.sensitive"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.apps.aiTransparency.sensitive.label', 'Sensitive context')}
              </label>
              <select
                id="aiTransparency.sensitive"
                value={block.sensitive || ''}
                onChange={e => setField('sensitive', e.target.value || undefined)}
                aria-describedby="aiTransparency.sensitive-hint"
                className={inputClass}
              >
                <option value="">{t('admin.apps.aiTransparency.sensitive.none', 'None')}</option>
                {SENSITIVE_CATEGORIES.map(category => (
                  <option key={category} value={category}>
                    {t(
                      `admin.apps.aiTransparency.sensitive.${category}`,
                      SENSITIVE_FALLBACKS[category] || category
                    )}
                  </option>
                ))}
              </select>
              <p
                id="aiTransparency.sensitive-hint"
                className="mt-1 text-xs text-gray-500 dark:text-gray-400"
              >
                {t(
                  'admin.apps.aiTransparency.sensitive.hint',
                  'Legal, financial, health, complaint or vulnerable-person contexts get periodic reminders that the user is talking to an AI system.'
                )}
              </p>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label
                htmlFor="aiTransparency.reminderInterval"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.apps.aiTransparency.reminderInterval.label', 'Reminder every N answers')}
              </label>
              <input
                id="aiTransparency.reminderInterval"
                type="number"
                min={0}
                max={100}
                step={1}
                value={block.reminderInterval ?? ''}
                placeholder={
                  platformReminder !== undefined && platformReminder !== null
                    ? String(platformReminder)
                    : ''
                }
                onChange={e => {
                  const raw = e.target.value;
                  const parsed = parseInt(raw, 10);
                  setField(
                    'reminderInterval',
                    raw === '' || !Number.isFinite(parsed)
                      ? undefined
                      : Math.min(100, Math.max(0, parsed))
                  );
                }}
                aria-describedby="aiTransparency.reminderInterval-hint"
                className={inputClass}
              />
              <p
                id="aiTransparency.reminderInterval-hint"
                className="mt-1 text-xs text-gray-500 dark:text-gray-400"
              >
                {t(
                  'admin.apps.aiTransparency.reminderInterval.hint',
                  'Only for sensitive apps. Empty uses the platform default ({{value}}); 0 turns reminders off.',
                  {
                    value:
                      platformReminder ?? t('admin.apps.aiTransparency.platformDefault', 'default')
                  }
                )}
              </p>
            </div>

            <div className="col-span-6">
              <DynamicLanguageEditor
                label={t('admin.apps.aiTransparency.firstTurnNotice.label', 'First-turn notice')}
                name="aiTransparency.firstTurnNotice"
                type="textarea"
                value={block.firstTurnNotice || {}}
                onChange={value =>
                  setField(
                    'firstTurnNotice',
                    value && Object.keys(value).length > 0 ? value : undefined
                  )
                }
                placeholder={{
                  en: 'You are chatting with an AI system. Answers are generated automatically and may be inaccurate — check important information.',
                  de: 'Sie chatten mit einem KI-System. Antworten werden automatisch erzeugt und können fehlerhaft sein – prüfen Sie wichtige Informationen.'
                }}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'admin.apps.aiTransparency.firstTurnNotice.hint',
                  'Shown in the empty chat before the first message. Leave empty for the default text. It must say clearly that the user is interacting with an AI system.'
                )}
              </p>
            </div>

            {['exports', 'clipboard'].map(key => (
              <div key={key} className="col-span-6 sm:col-span-3">
                <label
                  htmlFor={`aiTransparency.signpost.${key}`}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {key === 'exports'
                    ? t('admin.apps.aiTransparency.signpost.exports', 'Text signpost in exports')
                    : t(
                        'admin.apps.aiTransparency.signpost.clipboard',
                        'Text signpost when copying'
                      )}
                </label>
                <select
                  id={`aiTransparency.signpost.${key}`}
                  value={signpostMode(key)}
                  onChange={e => setSignpost(key, e.target.value)}
                  className={inputClass}
                >
                  <option value="default">
                    {t(
                      'admin.apps.aiTransparency.signpost.default',
                      'Platform default ({{value}})',
                      { value: onOff(aiConfig?.text?.signpost?.[key]) }
                    )}
                  </option>
                  <option value="on">{t('admin.apps.aiTransparency.on', 'On')}</option>
                  <option value="off">{t('admin.apps.aiTransparency.off', 'Off')}</option>
                </select>
              </div>
            ))}
            <p className="col-span-6 -mt-4 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.apps.aiTransparency.signpost.hint',
                'The signpost is an invisible, signed C2PA text manifest that lets other tools detect AI-generated text.'
              )}
            </p>
          </div>
        </div>
      </div>

      <JustificationDialog
        isOpen={dialog === 'optOut'}
        danger
        title={t(
          'admin.apps.aiTransparency.optOutDialog.title',
          'Switch off the AI disclosure for this app?'
        )}
        description={
          <>
            <p>
              {t(
                'admin.apps.aiTransparency.optOutDialog.body',
                'Art. 50(1) EU AI Act requires telling people that they are interacting with an AI system. The Commission guidelines (¶45) allow an exception only where this is obvious — for example an internal assistant used only by trained, AI-literate staff. Customer-facing or public apps do not qualify.'
              )}
            </p>
            <p className="mt-2">
              {t(
                'admin.apps.aiTransparency.optOutDialog.record',
                'The decision applies to this installation only. It is removed when the app is downloaded, backed up or published, so another installation has to decide again.'
              )}
            </p>
          </>
        }
        label={t('admin.apps.aiTransparency.optOutDialog.reason', 'Reason')}
        placeholder={t(
          'admin.apps.aiTransparency.optOutDialog.placeholder',
          'e.g. Internal assistant for the IT support team only; all users completed the AI literacy training.'
        )}
        confirmLabel={t('admin.apps.aiTransparency.optOutDialog.confirm', 'Switch off disclosure')}
        onConfirm={switchOff}
        onCancel={() => setDialog(null)}
      />

      <JustificationDialog
        isOpen={dialog === 'exemption'}
        title={t(
          'admin.apps.aiTransparency.exemptionDialog.title',
          'Declare an exemption from marking?'
        )}
        description={t(
          'admin.apps.aiTransparency.exemptionDialog.body',
          'Answers of an exempt app are not required to carry a machine-readable AI marking (Art. 50(2)). Summaries, rewrites that change style or meaning, and generated images are never exempt. Most apps — emails, marketing, reports, customer answers — do not qualify.'
        )}
        choices={EXEMPTION_TYPES.map(type => ({
          value: type,
          label: t(
            `admin.apps.aiTransparency.exemption.types.${type}.label`,
            EXEMPTION_FALLBACKS[type]?.label || type
          ),
          description: t(
            `admin.apps.aiTransparency.exemption.types.${type}.description`,
            EXEMPTION_FALLBACKS[type]?.description || ''
          )
        }))}
        choiceLabel={t('admin.apps.aiTransparency.exemptionDialog.type', 'Exemption type')}
        label={t('admin.apps.aiTransparency.exemptionDialog.justification', 'Justification')}
        confirmLabel={t('admin.apps.aiTransparency.exemptionDialog.confirm', 'Declare exemption')}
        onConfirm={declareExemption}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

export default AiTransparencySection;
