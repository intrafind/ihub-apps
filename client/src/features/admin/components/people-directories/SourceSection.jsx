// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import FormSection from './FormSection';
import ChoiceField from './ChoiceField';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from './formStyles';
import { DEFAULT_PRESET_ID } from '../../utils/peopleDirectories';

/**
 * Editor section "Source": where the directory lives. Either it reuses an
 * LDAP sign-in provider from the authentication settings (URL, base DN,
 * directory type and bind account come from there, and each can be overridden
 * here), or it connects directly with its own URL and base DN.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state (see utils/peopleDirectories.js)
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Array<Object>} props.ldapProviders - Sign-in providers from the GET
 * @param {Object|undefined} props.provider - The selected provider, if configured
 * @param {Array<{id: string, label: string}>} props.presets - Search presets
 */
function SourceSection({ form, update, ldapProviders, provider, presets }) {
  const { t } = useTranslation();
  const reuses = form.sourceMode === 'provider';
  const hasOverrides = Boolean(
    form.url || form.baseDn || form.preset || form.starttls !== 'inherit'
  );
  const [overridesOpen, setOverridesOpen] = useState(hasOverrides);

  const presetLabel = id => {
    const preset = presets.find(p => p.id === id);
    return t(`admin.peopleDirectories.presets.${id}`, preset?.label || id);
  };
  const providerLabel = p =>
    p.displayName && p.displayName !== p.name ? `${p.displayName} (${p.name})` : p.name;
  const missingProvider = reuses && form.authProvider && !provider;

  const presetOptions = presets.length
    ? presets
    : [{ id: DEFAULT_PRESET_ID, label: DEFAULT_PRESET_ID }];

  return (
    <FormSection
      id="pd-source"
      title={t('admin.peopleDirectories.source.title', 'Source')}
      description={t(
        'admin.peopleDirectories.source.description',
        'Where the directory lives and how iHub reaches it.'
      )}
    >
      <fieldset>
        <legend className="sr-only">{t('admin.peopleDirectories.source.title', 'Source')}</legend>
        <div className="space-y-3">
          <ChoiceField
            id="pd-source-mode-provider"
            name="pd-source-mode"
            value="provider"
            checked={reuses}
            onChange={() => update({ sourceMode: 'provider' })}
            label={t('admin.peopleDirectories.source.reuse', 'Reuse a sign-in provider')}
            help={t(
              'admin.peopleDirectories.source.reuseHelp',
              'URL, base DN, directory type and bind account come from an LDAP sign-in provider of the authentication settings.'
            )}
          />
          <ChoiceField
            id="pd-source-mode-direct"
            name="pd-source-mode"
            value="direct"
            checked={!reuses}
            onChange={() => update({ sourceMode: 'direct' })}
            label={t('admin.peopleDirectories.source.direct', 'Connect directly')}
            help={t(
              'admin.peopleDirectories.source.directHelp',
              'For directories without a sign-in provider, such as the external x500.bund.de.'
            )}
          />
        </div>
      </fieldset>

      {reuses ? (
        <>
          <div>
            <label htmlFor="pd-auth-provider" className={LABEL_CLASS}>
              {t('admin.peopleDirectories.source.provider', 'Sign-in provider')}
            </label>
            <select
              id="pd-auth-provider"
              value={form.authProvider}
              onChange={e => update({ authProvider: e.target.value })}
              className={INPUT_CLASS}
            >
              <option value="">
                {t('admin.peopleDirectories.source.providerPlaceholder', 'Choose a provider…')}
              </option>
              {ldapProviders.map(p => (
                <option key={p.name} value={p.name}>
                  {providerLabel(p)}
                </option>
              ))}
              {missingProvider && (
                <option value={form.authProvider}>
                  {t(
                    'admin.peopleDirectories.source.providerNotConfigured',
                    '{{name}} (not configured)',
                    { name: form.authProvider }
                  )}
                </option>
              )}
            </select>
            {ldapProviders.length === 0 && (
              <p className={HELP_CLASS}>
                {t(
                  'admin.peopleDirectories.source.noProviders',
                  'No LDAP sign-in provider is configured.'
                )}{' '}
                <Link
                  to="/admin/auth"
                  className="text-blue-700 dark:text-blue-300 underline hover:no-underline"
                >
                  {t('admin.peopleDirectories.source.openAuth', 'Open the authentication settings')}
                </Link>
              </p>
            )}
          </div>

          {missingProvider && (
            <div className={CALLOUT_CLASS.warning} role="note">
              {t(
                'admin.peopleDirectories.source.missingProvider',
                'The sign-in provider "{{name}}" is not configured. Save it in the authentication settings first, or choose another one.',
                { name: form.authProvider }
              )}
            </div>
          )}

          {provider && (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-md bg-gray-50 dark:bg-gray-900/40 p-3 text-sm sm:grid-cols-3">
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.source.url', 'URL')}
              </dt>
              <dd className="font-mono text-gray-900 dark:text-gray-100 break-all sm:col-span-2">
                {provider.url || '—'}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.source.baseDn', 'Base DN')}
              </dt>
              <dd className="font-mono text-gray-900 dark:text-gray-100 break-all sm:col-span-2">
                {provider.baseDn || '—'}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.source.preset', 'Directory type')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100 sm:col-span-2">
                {presetLabel(provider.preset || DEFAULT_PRESET_ID)}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.source.bindAccount', 'Bind account')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100 sm:col-span-2">
                {provider.hasBindAccount
                  ? t('admin.peopleDirectories.source.bindAccountSet', 'Configured')
                  : t('admin.peopleDirectories.source.bindAccountNone', 'None')}
              </dd>
            </dl>
          )}

          <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
            <button
              type="button"
              onClick={() => setOverridesOpen(open => !open)}
              aria-expanded={overridesOpen}
              aria-controls="pd-source-overrides"
              className="inline-flex items-center min-h-[24px] text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500 rounded-sm"
            >
              <Icon
                name={overridesOpen ? 'chevron-up' : 'chevron-down'}
                size="sm"
                className="mr-1"
              />
              {t('admin.peopleDirectories.source.overrides', 'Override provider settings')}
            </button>
            <div id="pd-source-overrides" hidden={!overridesOpen} className="mt-3 space-y-4">
              <p className={HELP_CLASS}>
                {t(
                  'admin.peopleDirectories.source.overridesHelp',
                  'Leave a field empty to use the value of the sign-in provider.'
                )}
              </p>
              <DirectFields
                form={form}
                update={update}
                provider={provider}
                presetOptions={presetOptions}
                presetLabel={presetLabel}
                optional
              />
            </div>
          </div>
        </>
      ) : (
        <DirectFields
          form={form}
          update={update}
          presetOptions={presetOptions}
          presetLabel={presetLabel}
        />
      )}
    </FormSection>
  );
}

/**
 * URL, base DN, directory type and StartTLS. Required for a direct
 * connection; optional overrides when a sign-in provider is reused, with the
 * provider's values as placeholders.
 */
function DirectFields({ form, update, provider, presetOptions, presetLabel, optional = false }) {
  const { t } = useTranslation();
  const providerPreset = provider?.preset || DEFAULT_PRESET_ID;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <label htmlFor="pd-url" className={LABEL_CLASS}>
          {t('admin.peopleDirectories.source.url', 'URL')}
          {!optional && (
            <span className="text-red-700 dark:text-red-400 ml-0.5" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <input
          id="pd-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required={!optional}
          value={form.url}
          onChange={e => update({ url: e.target.value })}
          placeholder={optional ? provider?.url || '' : 'ldaps://ldap.example.org:636'}
          aria-describedby="pd-url-help"
          className={MONO_INPUT_CLASS}
        />
        <p id="pd-url-help" className={HELP_CLASS}>
          {t(
            'admin.peopleDirectories.source.urlHelp',
            'ldaps://host:636 for TLS. ldap://host:389 needs StartTLS — or plain text allowed under Network, which is not recommended.'
          )}
        </p>
      </div>
      <div>
        <label htmlFor="pd-base-dn" className={LABEL_CLASS}>
          {t('admin.peopleDirectories.source.baseDn', 'Base DN')}
          {!optional && (
            <span className="text-red-700 dark:text-red-400 ml-0.5" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <input
          id="pd-base-dn"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required={!optional}
          value={form.baseDn}
          onChange={e => update({ baseDn: e.target.value })}
          placeholder={optional ? provider?.baseDn || '' : 'dc=example,dc=org'}
          className={MONO_INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor="pd-preset" className={LABEL_CLASS}>
          {t('admin.peopleDirectories.source.preset', 'Directory type')}
        </label>
        <select
          id="pd-preset"
          value={optional ? form.preset : form.preset || DEFAULT_PRESET_ID}
          onChange={e => update({ preset: e.target.value })}
          aria-describedby="pd-preset-help"
          className={INPUT_CLASS}
        >
          {optional && (
            <option value="">
              {t('admin.peopleDirectories.source.presetInherit', 'As the provider ({{preset}})', {
                preset: presetLabel(providerPreset)
              })}
            </option>
          )}
          {presetOptions.map(preset => (
            <option key={preset.id} value={preset.id}>
              {presetLabel(preset.id)}
            </option>
          ))}
        </select>
        <p id="pd-preset-help" className={HELP_CLASS}>
          {t(
            'admin.peopleDirectories.source.presetHelp',
            'Sets which entries are people and where each field is read from. See Mapping below.'
          )}
        </p>
      </div>
      <div className="md:col-span-2">
        {optional ? (
          <>
            <label htmlFor="pd-starttls" className={LABEL_CLASS}>
              {t('admin.peopleDirectories.source.starttls', 'StartTLS')}
            </label>
            <select
              id="pd-starttls"
              value={form.starttls}
              onChange={e => update({ starttls: e.target.value })}
              className={INPUT_CLASS}
            >
              <option value="inherit">
                {provider?.starttls
                  ? t('admin.peopleDirectories.source.starttlsInheritOn', 'As the provider (on)')
                  : t('admin.peopleDirectories.source.starttlsInheritOff', 'As the provider (off)')}
              </option>
              <option value="on">{t('admin.peopleDirectories.source.starttlsOn', 'On')}</option>
              <option value="off">{t('admin.peopleDirectories.source.starttlsOff', 'Off')}</option>
            </select>
          </>
        ) : (
          <ChoiceField
            id="pd-starttls"
            type="checkbox"
            checked={form.starttls === 'on'}
            onChange={checked => update({ starttls: checked ? 'on' : 'off' })}
            label={t(
              'admin.peopleDirectories.source.starttlsLabel',
              'Use StartTLS (encrypt ldap:// connections)'
            )}
            help={t(
              'admin.peopleDirectories.source.starttlsHelp',
              'Upgrades an ldap:// connection to TLS before anything is searched. Not needed for ldaps://.'
            )}
          />
        )}
      </div>
    </div>
  );
}

export default SourceSection;
