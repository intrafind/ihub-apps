// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import FormSection from './FormSection';
import DirectoryBadge from './DirectoryBadge';
import TransportBadge from './TransportBadge';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS,
  SECONDARY_BUTTON_CLASS
} from './formStyles';
import { certificateExpiryState } from '../../utils/peopleDirectories';

/**
 * Editor section "Network": transport security, hosts allowed on private
 * addresses, and the trust anchors that verify the server certificate.
 *
 * Plain `ldap://` without StartTLS is refused unless `allowPlaintext` is set:
 * search terms and the records returned are personal data. A service bind is
 * never sent in plain text, whatever the flag says.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'} props.transport - Connection security
 * @param {Array<Object>} props.certificates - The certificate store
 * @param {string|null} props.certificatesError - Why the store could not be loaded
 * @param {() => void} props.onReloadCertificates - Load the store again (after an upload in another tab)
 */
function NetworkSection({
  form,
  update,
  transport,
  certificates,
  certificatesError,
  onReloadCertificates
}) {
  const { t } = useTranslation();
  const storeNames = new Set(certificates.map(c => c.name));
  const missing = form.tlsCa.filter(name => !storeNames.has(name));

  const toggleCa = (name, checked) =>
    update({
      tlsCa: checked ? [...form.tlsCa, name] : form.tlsCa.filter(entry => entry !== name)
    });

  return (
    <FormSection
      id="pd-network"
      title={t('admin.peopleDirectories.network.title', 'Network')}
      description={t(
        'admin.peopleDirectories.network.description',
        'How the connection is secured and which servers iHub may reach.'
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <span className="font-medium">
          {t('admin.peopleDirectories.network.transport', 'Transport')}:
        </span>
        <TransportBadge transport={transport} />
      </div>

      <div>
        <label className="flex items-start gap-3">
          <input
            id="pd-allow-plaintext"
            type="checkbox"
            checked={form.allowPlaintext}
            onChange={e => update({ allowPlaintext: e.target.checked })}
            aria-describedby="pd-allow-plaintext-warning"
            className={`${CHECKBOX_CLASS} mt-0.5`}
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t(
              'admin.peopleDirectories.network.allowPlaintext',
              'Allow plain-text connections (ldap:// without StartTLS)'
            )}
          </span>
        </label>
        <p id="pd-allow-plaintext-warning" className={`${CALLOUT_CLASS.warning} mt-2 ml-7`}>
          {t(
            'admin.peopleDirectories.network.plaintextWarning',
            'Without TLS, the search terms and the records the directory returns — names, phone numbers, e-mail addresses — cross the network in plain text. Use ldaps://host:636, or ldap://host:389 with StartTLS, whenever the server supports it. A service account password is never sent in plain text.'
          )}
        </p>
        {transport === 'plaintext' && !form.allowPlaintext && (
          <div className={`${CALLOUT_CLASS.danger} mt-2 ml-7`} role="note">
            {t(
              'admin.peopleDirectories.network.plaintextRefused',
              'This directory uses ldap:// without StartTLS. iHub refuses the connection until plain text is allowed here — better switch to ldaps:// or StartTLS.'
            )}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="pd-allowed-hosts" className={LABEL_CLASS}>
          {t('admin.peopleDirectories.network.allowedHosts', 'Hosts allowed on private addresses')}
        </label>
        <textarea
          id="pd-allowed-hosts"
          rows={3}
          spellCheck={false}
          value={form.allowedHosts}
          onChange={e => update({ allowedHosts: e.target.value })}
          placeholder="ldap.corp.local"
          aria-describedby="pd-allowed-hosts-help"
          className={MONO_INPUT_CLASS}
        />
        <p id="pd-allowed-hosts-help" className={HELP_CLASS}>
          {t(
            'admin.peopleDirectories.network.allowedHostsHelp',
            'One host per line. iHub refuses a directory host that resolves to a private, loopback or link-local address unless it is listed here or in the platform-wide SSRF allow-list. The host of a reused sign-in provider is always allowed.'
          )}
        </p>
      </div>

      <fieldset id="pd-tls-ca" aria-describedby="pd-tls-ca-help">
        <legend className={LABEL_CLASS}>
          {t('admin.peopleDirectories.network.tlsCa', 'Trusted certificates')}
        </legend>
        <p id="pd-tls-ca-help" className={`${HELP_CLASS} mt-0 mb-2`}>
          {t(
            'admin.peopleDirectories.network.tlsCaHelp',
            "When you pick certificates here, only they verify the server's certificate. Leave all unchecked to trust the usual public roots. Verification stays on unless the host is on the platform's SSL whitelist (ssl.ignoreInvalidCertificates with ssl.domainWhitelist): then it is switched off for this directory too, whatever you pick here."
          )}
        </p>
        {certificatesError && (
          <p className="text-sm text-red-800 dark:text-red-300">
            {t(
              'admin.peopleDirectories.network.tlsCaLoadError',
              'The certificate store could not be loaded: {{error}}',
              { error: certificatesError }
            )}
          </p>
        )}
        {certificates.length === 0 && missing.length === 0 && !certificatesError ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('admin.peopleDirectories.network.tlsCaEmpty', 'The certificate store is empty.')}
          </p>
        ) : (
          <ul className="space-y-2">
            {certificates.map(certificate => {
              const id = `pd-tls-ca-${certificate.name}`;
              const expiry = certificateExpiryState(certificate);
              return (
                <li key={certificate.name} className="flex items-start gap-3">
                  <input
                    id={id}
                    type="checkbox"
                    checked={form.tlsCa.includes(certificate.name)}
                    onChange={e => toggleCa(certificate.name, e.target.checked)}
                    className={`${CHECKBOX_CLASS} mt-0.5`}
                  />
                  <label htmlFor={id} className="text-sm text-gray-900 dark:text-gray-100">
                    <span className="font-mono">{certificate.name}</span>
                    {certificate.subjectCN && (
                      <span className="text-gray-600 dark:text-gray-400">
                        {' '}
                        — {certificate.subjectCN}
                      </span>
                    )}
                  </label>
                  {expiry === 'expired' && (
                    <DirectoryBadge tone="danger" icon="exclamation-triangle">
                      {t('admin.peopleDirectories.certificates.expired', 'Expired')}
                    </DirectoryBadge>
                  )}
                  {expiry === 'expiringSoon' && (
                    <DirectoryBadge tone="warning" icon="exclamation-triangle">
                      {t(
                        'admin.peopleDirectories.certificates.expiresIn',
                        'Expires in {{count}} days',
                        { count: certificate.daysUntilExpiry }
                      )}
                    </DirectoryBadge>
                  )}
                </li>
              );
            })}
            {missing.map(name => {
              const id = `pd-tls-ca-${name}`;
              return (
                <li key={name} className="flex items-start gap-3">
                  <input
                    id={id}
                    type="checkbox"
                    checked
                    onChange={e => toggleCa(name, e.target.checked)}
                    className={`${CHECKBOX_CLASS} mt-0.5`}
                  />
                  <label
                    htmlFor={id}
                    className="text-sm font-mono text-gray-900 dark:text-gray-100"
                  >
                    {name}
                  </label>
                  <DirectoryBadge tone="danger" icon="exclamation-triangle">
                    {t('admin.peopleDirectories.network.tlsCaMissing', 'Not in the store')}
                  </DirectoryBadge>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link
            to="/admin/integrations/people-directories?tab=certificates"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-700 dark:text-blue-300 underline hover:no-underline"
          >
            {t(
              'admin.peopleDirectories.network.manageCertificates',
              'Manage the certificate store (opens in a new tab)'
            )}
          </Link>
          <button type="button" onClick={onReloadCertificates} className={SECONDARY_BUTTON_CLASS}>
            <Icon name="refresh" size="sm" />
            {t('admin.peopleDirectories.network.reloadCertificates', 'Reload certificates')}
          </button>
        </div>
      </fieldset>
    </FormSection>
  );
}

export default NetworkSection;
