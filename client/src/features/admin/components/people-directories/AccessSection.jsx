// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import FormSection from './FormSection';
import ChoiceField from './ChoiceField';
import { CALLOUT_CLASS, LABEL_CLASS, MONO_INPUT_CLASS } from './formStyles';

/**
 * Editor section "Access": how iHub binds to the directory. Anonymously, with
 * a service account, or — when a sign-in provider is reused — with that
 * provider's bind account. The service account's password is picked from the
 * credential store; it is never typed into this form.
 *
 * iHub never keeps a user's LDAP password, so a search cannot run as the user.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {Object|undefined} props.provider - The reused sign-in provider, if any
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'} props.transport - Connection security
 */
function AccessSection({ form, update, provider, transport }) {
  const { t } = useTranslation();
  const reuses = form.sourceMode === 'provider';
  // Without a sign-in provider, "no bind configured" means anonymous.
  const mode = !reuses && form.bindMode === 'default' ? 'anonymous' : form.bindMode;

  const options = [
    reuses && {
      value: 'default',
      label: t(
        'admin.peopleDirectories.access.providerAccount',
        "The sign-in provider's bind account"
      ),
      help: t(
        'admin.peopleDirectories.access.providerAccountHelp',
        'The service account the provider already uses to look up users.'
      )
    },
    {
      value: 'anonymous',
      label: t('admin.peopleDirectories.access.anonymous', 'Anonymous'),
      help: t(
        'admin.peopleDirectories.access.anonymousHelp',
        'Only for directories that allow anonymous search, such as x500.bund.de. Active Directory normally does not.'
      )
    },
    {
      value: 'service',
      label: t('admin.peopleDirectories.access.service', 'Service account'),
      help: t(
        'admin.peopleDirectories.access.serviceHelp',
        'A read-only account of its own for the people search.'
      )
    }
  ].filter(Boolean);

  return (
    <FormSection
      id="pd-access"
      title={t('admin.peopleDirectories.access.title', 'Access')}
      description={t(
        'admin.peopleDirectories.access.description',
        "How iHub signs in to the directory. Searches never run with a user's own password, because iHub does not keep it."
      )}
    >
      <fieldset>
        <legend className="sr-only">{t('admin.peopleDirectories.access.title', 'Access')}</legend>
        <div className="space-y-3">
          {options.map(option => (
            <ChoiceField
              key={option.value}
              id={`pd-bind-mode-${option.value}`}
              name="pd-bind-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => update({ bindMode: option.value })}
              label={option.label}
              help={option.help}
            />
          ))}
        </div>
      </fieldset>

      {reuses && mode === 'default' && provider && !provider.hasBindAccount && (
        <div className={CALLOUT_CLASS.warning} role="note">
          {t(
            'admin.peopleDirectories.access.noBindAccount',
            'This sign-in provider has no bind account. Choose anonymous access if the directory allows it, or a service account.'
          )}
        </div>
      )}

      {mode === 'service' && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="pd-bind-dn" className={LABEL_CLASS}>
              {t('admin.peopleDirectories.access.bindDn', 'Bind DN')}
            </label>
            <input
              id="pd-bind-dn"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.bindDn}
              onChange={e => update({ bindDn: e.target.value })}
              placeholder="cn=people-search,ou=services,dc=example,dc=org"
              className={MONO_INPUT_CLASS}
            />
          </div>
          <CredentialRefSelect
            id="pd-bind-password-ref"
            value={form.bindPasswordRef}
            onChange={id => update({ bindPasswordRef: id })}
            types={['secret', 'basic']}
            label={t('admin.peopleDirectories.access.password', 'Password')}
            help={t(
              'admin.peopleDirectories.access.passwordHelp',
              'Choose the stored credential that holds the password.'
            )}
          />
          {transport === 'plaintext' && (
            <div className={`${CALLOUT_CLASS.danger} md:col-span-2`} role="note">
              {t(
                'admin.peopleDirectories.access.servicePlaintext',
                'A service account never binds over plain text. Use ldaps:// or StartTLS, or this directory cannot connect.'
              )}
            </div>
          )}
        </div>
      )}
    </FormSection>
  );
}

export default AccessSection;
