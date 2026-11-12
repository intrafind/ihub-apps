// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../../shared/components/ConfirmDialog';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../../api/adminApi';
import {
  MIB,
  PROVENANCE_BOUNDS,
  PROVENANCE_DEFAULTS
} from '../../../../../../shared/provenanceSettings.js';
import AdminLoadError from '../AdminLoadError';
import EuAiActCard from './EuAiActCard';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from './KeyDialogs';
import {
  SERVER_FIELD,
  buildBody,
  consequences,
  isDirty,
  needsConfirmation,
  toForm,
  validateForm
} from './provenanceSettingsForm';
import EuAiActStateNote from './EuAiActStateNote';

const FIELD_ORDER = [
  'retentionDays',
  'recordUser',
  'verifyAccess',
  'maxVerifyBytes',
  'alpha',
  'minScoredTokens',
  'detectorTimeoutMs'
];
// The size field shows MiB; its error key stays `maxVerifyBytes`.
const INPUT_ID = field => `provenance-${field}`;

function Checkbox({ id, checked, onChange, label, help }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-4 w-4 rounded border-gray-300"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        aria-describedby={`${id}-help`}
      />
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </label>
        <p id={`${id}-help`} className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          {help}
        </p>
      </div>
    </div>
  );
}

function Field({ field, label, help, error, unit, children }) {
  const id = INPUT_ID(field);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900 dark:text-gray-100">
        {label}
        {unit && <span className="font-normal text-gray-600 dark:text-gray-400"> ({unit})</span>}
      </label>
      <div className="mt-1 max-w-xs">{children}</div>
      <p id={`${id}-help`} className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        {help}
      </p>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Group({ title, children }) {
  return (
    <fieldset className="space-y-4">
      <legend className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * Card 5: the platform `provenance.*` settings. Edits only what it owns: the save
 * sends a partial block and the server merges it into the stored one. Everything
 * applies at once; no restart.
 *
 * @param {Object} props
 * @param {() => void} [props.onSaved] - Called after a save so the status checks refresh
 */
export default function ProvenanceSettingsCard({ onSaved }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [saving, setSaving] = useState(false);
  const formRef = useRef(null);
  const messageRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const next = toForm(response.data?.provenance || {});
      setForm(next);
      setSaved(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch, ...clear) => {
    setForm(current => ({ ...current, ...patch }));
    setErrors(current => {
      const next = { ...current };
      clear.forEach(field => delete next[field]);
      return next;
    });
    setMessage(null);
  };

  const problemText = (field, code) => {
    const bounds = PROVENANCE_BOUNDS[field] || {};
    const isSize = field === 'maxVerifyBytes';
    const scale = isSize ? MIB : 1;
    const params = {
      min: bounds.min / scale,
      max: bounds.max / scale
    };
    switch (code) {
      case 'required':
        return t('admin.euAiAct.settings.error.required', 'Enter a value.');
      case 'number':
        return t('admin.euAiAct.settings.error.number', 'Enter a number.');
      case 'integer':
        return t('admin.euAiAct.settings.error.integer', 'Enter a whole number.');
      case 'min':
        return bounds.exclusive
          ? t(
              'admin.euAiAct.settings.error.aboveExclusive',
              'Enter a number greater than {{min}}.',
              params
            )
          : t('admin.euAiAct.settings.error.min', 'Enter {{min}} or more.', params);
      case 'max':
        return bounds.exclusive
          ? t(
              'admin.euAiAct.settings.error.belowExclusive',
              'Enter a number less than {{max}}.',
              params
            )
          : t('admin.euAiAct.settings.error.max', 'Enter {{max}} or less.', params);
      default:
        return t('admin.euAiAct.settings.error.invalid', 'This value is not allowed.');
    }
  };

  const focusFirst = problems => {
    const first = FIELD_ORDER.find(field => problems[field]);
    const id =
      first === 'verifyAccess'
        ? 'provenance-verifyAccess-authenticated'
        : first === 'recordUser'
          ? 'provenance-recordUser-none'
          : INPUT_ID(first);
    if (first) document.getElementById(id)?.focus();
  };

  const doSave = async () => {
    setConfirming(null);
    setSaving(true);
    setMessage(null);
    try {
      // Read-modify-write: platform.json holds settings this card does not show.
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      platform.provenance = buildBody(form);
      const result = await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: platform
      });
      const next = toForm(result.data?.config?.provenance || {});
      setForm(next);
      setSaved(next);
      setErrors({});
      setMessage({
        type: 'success',
        text: t(
          'admin.euAiAct.settings.saved',
          'Settings saved. They apply now; no restart needed.'
        )
      });
      onSaved?.();
    } catch (err) {
      const list = err?.response?.data?.errors;
      const fieldErrors = {};
      if (Array.isArray(list)) {
        for (const item of list) {
          const field = SERVER_FIELD[item.field];
          if (field) fieldErrors[field] = item.message;
        }
      }
      setErrors(fieldErrors);
      setMessage({
        type: 'error',
        text:
          t('admin.euAiAct.settings.saveError', 'The settings were not saved.') +
          ' ' +
          getAdminApiErrorMessage(err)
      });
      focusFirst(fieldErrors);
    } finally {
      setSaving(false);
    }
  };

  const submit = event => {
    event.preventDefault();
    const problems = validateForm(form);
    if (Object.keys(problems).length > 0) {
      setErrors(
        Object.fromEntries(
          Object.entries(problems).map(([field, code]) => [field, problemText(field, code)])
        )
      );
      setMessage({
        type: 'error',
        text: t('admin.euAiAct.settings.fixErrors', 'Fix the marked fields and save again.')
      });
      focusFirst(problems);
      return;
    }
    const c = consequences(form, saved);
    if (needsConfirmation(c)) setConfirming(c);
    else void doSave();
  };

  const reset = () => {
    setForm(saved);
    setErrors({});
    setMessage(null);
  };

  const fieldProps = field => ({
    id: INPUT_ID(field),
    'aria-invalid': errors[field] ? 'true' : undefined,
    'aria-describedby': errors[field]
      ? `${INPUT_ID(field)}-help ${INPUT_ID(field)}-error`
      : `${INPUT_ID(field)}-help`
  });

  const d = PROVENANCE_DEFAULTS;
  const defaultText = value =>
    t('admin.euAiAct.settings.default', 'Default: {{value}}.', { value });
  const dirty = form && saved ? isDirty(form, saved) : false;

  return (
    <EuAiActCard
      id="provenance-settings"
      title={t('admin.euAiAct.settings.title', 'Provenance settings')}
      description={t(
        'admin.euAiAct.settings.description',
        'How long output records are kept, who may check an output, and how strict the watermark detector is. Changes apply immediately; no restart is needed. Every save is written to the audit log.'
      )}
    >
      <EuAiActStateNote hideWhenOn className="mb-4" />
      {loadError && !form ? (
        <AdminLoadError
          framed={false}
          message={loadError}
          title={t('admin.euAiAct.settings.loadError', 'Could not load the settings')}
          action={{ label: t('common.retry', 'Retry'), onClick: load }}
        />
      ) : !form ? null : (
        <form ref={formRef} onSubmit={submit} noValidate className="space-y-8">
          <Group title={t('admin.euAiAct.settings.records', 'Output records')}>
            <Checkbox
              id="provenance-storeRecords"
              checked={form.storeRecords}
              onChange={storeRecords => set({ storeRecords })}
              label={t('admin.euAiAct.settings.storeRecords', 'Keep a record of every output')}
              help={t(
                'admin.euAiAct.settings.storeRecordsHelp',
                'A record holds a hash of the output, never its text. Without records, "did this installation produce this text?" cannot be answered. Default: on.'
              )}
            />
            <Field
              field="retentionDays"
              label={t('admin.euAiAct.settings.retentionDays', 'Keep records for')}
              unit={t('admin.euAiAct.settings.days', 'days')}
              error={errors.retentionDays}
              help={`${t(
                'admin.euAiAct.settings.retentionHelp',
                '0 keeps records forever. Older records are deleted by a daily clean-up.'
              )} ${defaultText(d.retentionDays)}`}
            >
              <input
                {...fieldProps('retentionDays')}
                type="number"
                inputMode="numeric"
                min={PROVENANCE_BOUNDS.retentionDays.min}
                max={PROVENANCE_BOUNDS.retentionDays.max}
                step={1}
                value={form.retentionDays}
                onChange={e => set({ retentionDays: e.target.value }, 'retentionDays')}
                className={INPUT}
              />
            </Field>
            <div role="radiogroup" aria-labelledby="provenance-recordUser-label">
              <p
                id="provenance-recordUser-label"
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t('admin.euAiAct.settings.recordUser', 'Who a record names')}
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {t(
                  'admin.euAiAct.settings.recordUserHelp',
                  'Applies to records written from now on. Only admins see it when checking an output; it is never part of what a user or API caller receives. It stays in the record when the user is deleted.'
                )}
              </p>
              {[
                [
                  'none',
                  t('admin.euAiAct.settings.recordUserNone', 'Nobody'),
                  t(
                    'admin.euAiAct.settings.recordUserNoneHelp',
                    'The record describes the output only. Default.'
                  )
                ],
                [
                  'anonymous',
                  t('admin.euAiAct.settings.recordUserAnonymous', 'Anonymous (secured hash)'),
                  t(
                    'admin.euAiAct.settings.recordUserAnonymousHelp',
                    'A hash keyed with a secret only the server holds (usr_…). Records of one person share the value, but the user cannot be determined from it.'
                  )
                ],
                [
                  'pseudonymous',
                  t(
                    'admin.euAiAct.settings.recordUserPseudonymous',
                    'Pseudonymous (hash of the user id)'
                  ),
                  t(
                    'admin.euAiAct.settings.recordUserPseudonymousHelp',
                    'A plain SHA-256 of the user id. Whoever knows a user id can compute it and so attribute the record.'
                  )
                ],
                [
                  'identified',
                  t('admin.euAiAct.settings.recordUserIdentified', 'Identified (user id)'),
                  t(
                    'admin.euAiAct.settings.recordUserIdentifiedHelp',
                    'The user id, never the name or email. The records then hold personal data: cover them in your data protection documentation.'
                  )
                ]
              ].map(([value, label, help]) => (
                <div key={value} className="mt-2 flex items-start gap-3">
                  <input
                    id={`provenance-recordUser-${value}`}
                    type="radio"
                    name="provenance-recordUser"
                    className="mt-1 h-4 w-4 border-gray-300"
                    checked={form.recordUser === value}
                    onChange={() => set({ recordUser: value }, 'recordUser')}
                    aria-describedby={`provenance-recordUser-${value}-help`}
                  />
                  <div>
                    <label
                      htmlFor={`provenance-recordUser-${value}`}
                      className="block text-sm text-gray-900 dark:text-gray-100"
                    >
                      {label}
                    </label>
                    <p
                      id={`provenance-recordUser-${value}-help`}
                      className="text-xs text-gray-600 dark:text-gray-400"
                    >
                      {help}
                    </p>
                  </div>
                </div>
              ))}
              {errors.recordUser && (
                <p className="mt-1 text-sm text-red-700 dark:text-red-300">{errors.recordUser}</p>
              )}
            </div>
          </Group>

          <Group title={t('admin.euAiAct.settings.verification', 'Checking outputs')}>
            <div role="radiogroup" aria-labelledby="provenance-verifyAccess-label">
              <p
                id="provenance-verifyAccess-label"
                className="text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                {t('admin.euAiAct.settings.verifyAccess', 'Who may check an output')}
              </p>
              {[
                [
                  'authenticated',
                  t('admin.euAiAct.settings.accessAuthenticated', 'Signed-in users only'),
                  t(
                    'admin.euAiAct.settings.accessAuthenticatedHelp',
                    'Anonymous visitors get a sign-in request. Default.'
                  )
                ],
                [
                  'public',
                  t('admin.euAiAct.settings.accessPublic', 'Anyone, without signing in'),
                  t(
                    'admin.euAiAct.settings.accessPublicHelp',
                    'Third parties such as journalists or platforms can check a text or file. Anyone can then find out whether a text came from this installation.'
                  )
                ]
              ].map(([value, label, help]) => (
                <div key={value} className="mt-2 flex items-start gap-3">
                  <input
                    id={`provenance-verifyAccess-${value}`}
                    type="radio"
                    name="provenance-verifyAccess"
                    className="mt-1 h-4 w-4 border-gray-300"
                    checked={form.verifyAccess === value}
                    onChange={() => set({ verifyAccess: value }, 'verifyAccess')}
                    aria-describedby={`provenance-verifyAccess-${value}-help`}
                  />
                  <div>
                    <label
                      htmlFor={`provenance-verifyAccess-${value}`}
                      className="block text-sm text-gray-900 dark:text-gray-100"
                    >
                      {label}
                    </label>
                    <p
                      id={`provenance-verifyAccess-${value}-help`}
                      className="text-xs text-gray-600 dark:text-gray-400"
                    >
                      {help}
                    </p>
                  </div>
                </div>
              ))}
              {errors.verifyAccess && (
                <p className="mt-1 text-sm text-red-700 dark:text-red-300">{errors.verifyAccess}</p>
              )}
            </div>
            <Field
              field="maxVerifyBytes"
              label={t('admin.euAiAct.settings.maxVerify', 'Largest file that can be checked')}
              unit="MiB"
              error={errors.maxVerifyBytes}
              help={`${t(
                'admin.euAiAct.settings.maxVerifyHelp',
                'Applies to image and audio uploads on the check form. Larger files are refused.'
              )} ${defaultText(`${d.maxVerifyBytes / MIB} MiB`)}`}
            >
              <input
                {...fieldProps('maxVerifyBytes')}
                type="number"
                inputMode="decimal"
                min={PROVENANCE_BOUNDS.maxVerifyBytes.min / MIB}
                max={PROVENANCE_BOUNDS.maxVerifyBytes.max / MIB}
                step="any"
                value={form.maxVerifyMib}
                onChange={e => set({ maxVerifyMib: e.target.value }, 'maxVerifyBytes')}
                className={INPUT}
              />
            </Field>
            <Checkbox
              id="provenance-readC2pa"
              checked={form.readC2pa}
              onChange={readC2pa => set({ readC2pa })}
              label={t('admin.euAiAct.settings.readC2pa', 'Read C2PA marks of images')}
              help={t(
                'admin.euAiAct.settings.readC2paHelp',
                'Reads the provider mark (C2PA manifest) of generated and uploaded images. Default: on.'
              )}
            />
          </Group>

          <Group title={t('admin.euAiAct.settings.detection', 'Text watermark detection')}>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.euAiAct.settings.detectionIntro',
                'Leave a field empty to use its default. The defaults suit most installations; change them only for a reason.'
              )}
            </p>
            <Field
              field="alpha"
              label={t('admin.euAiAct.settings.alpha', 'False-positive limit')}
              error={errors.alpha}
              help={`${t(
                'admin.euAiAct.settings.alphaHelp',
                'The chance that a text is wrongly called "consistent with our watermark". Smaller is stricter. Between 0 and 1, for example 0.0001.'
              )} ${defaultText(d.alpha)}`}
            >
              <input
                {...fieldProps('alpha')}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={String(d.alpha)}
                value={form.alpha}
                onChange={e => set({ alpha: e.target.value }, 'alpha')}
                className={INPUT}
              />
            </Field>
            <Field
              field="minScoredTokens"
              label={t('admin.euAiAct.settings.minTokens', 'Shortest text that can be judged')}
              unit={t('admin.euAiAct.settings.tokens', 'tokens')}
              error={errors.minScoredTokens}
              help={`${t(
                'admin.euAiAct.settings.minTokensHelp',
                'Shorter texts are reported as "too short to tell" instead of "not watermarked".'
              )} ${defaultText(d.minScoredTokens)}`}
            >
              <input
                {...fieldProps('minScoredTokens')}
                type="number"
                inputMode="numeric"
                min={PROVENANCE_BOUNDS.minScoredTokens.min}
                max={PROVENANCE_BOUNDS.minScoredTokens.max}
                step={1}
                placeholder={String(d.minScoredTokens)}
                value={form.minScoredTokens}
                onChange={e => set({ minScoredTokens: e.target.value }, 'minScoredTokens')}
                className={INPUT}
              />
            </Field>
            <Field
              field="detectorTimeoutMs"
              label={t('admin.euAiAct.settings.timeout', 'Detector time limit')}
              unit={t('admin.euAiAct.settings.milliseconds', 'milliseconds')}
              error={errors.detectorTimeoutMs}
              help={`${t(
                'admin.euAiAct.settings.timeoutHelp',
                'How long to wait for the detector of a model. Between 1000 and 120000.'
              )} ${defaultText(d.detectorTimeoutMs)}`}
            >
              <input
                {...fieldProps('detectorTimeoutMs')}
                type="number"
                inputMode="numeric"
                min={PROVENANCE_BOUNDS.detectorTimeoutMs.min}
                max={PROVENANCE_BOUNDS.detectorTimeoutMs.max}
                step={100}
                placeholder={String(d.detectorTimeoutMs)}
                value={form.detectorTimeoutMs}
                onChange={e => set({ detectorTimeoutMs: e.target.value }, 'detectorTimeoutMs')}
                className={INPUT}
              />
            </Field>
          </Group>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving || !dirty} className={BUTTON_PRIMARY}>
              {t('common.save', 'Save')}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={saving || !dirty}
              className={BUTTON_SECONDARY}
            >
              {t('admin.euAiAct.settings.discard', 'Discard changes')}
            </button>
            <div ref={messageRef} role="status" aria-live="polite">
              {message && (
                <p
                  className={`text-sm ${
                    message.type === 'error'
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-green-800 dark:text-green-300'
                  }`}
                >
                  {message.text}
                </p>
              )}
            </div>
          </div>
        </form>
      )}

      <ConfirmDialog
        isOpen={Boolean(confirming)}
        title={t('admin.euAiAct.settings.confirmTitle', 'Save these settings?')}
        message={
          confirming && (
            <div className="space-y-2">
              {confirming.retentionLowered && (
                <p>
                  {t(
                    'admin.euAiAct.settings.confirmRetention',
                    'Records older than {{days}} days are deleted at the next daily clean-up. This cannot be undone, and those outputs can no longer be recognised.',
                    { days: confirming.retentionDays }
                  )}
                </p>
              )}
              {confirming.accessPublic && (
                <p>
                  {t(
                    'admin.euAiAct.settings.confirmPublic',
                    'Anyone on the internet can then check texts and files against this installation without signing in.'
                  )}
                </p>
              )}
              {confirming.accessRestricted && (
                <p>
                  {t(
                    'admin.euAiAct.settings.confirmRestricted',
                    'Third parties who rely on checking without an account will be asked to sign in.'
                  )}
                </p>
              )}
            </div>
          )
        }
        confirmLabel={t('common.save', 'Save')}
        danger={Boolean(confirming?.retentionLowered)}
        onConfirm={doSave}
        onDeny={() => setConfirming(null)}
      />
    </EuAiActCard>
  );
}
