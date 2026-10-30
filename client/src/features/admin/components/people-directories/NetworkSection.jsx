// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import FormSection from './FormSection';
import TransportBadge from './TransportBadge';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from './formStyles';

/**
 * Editor section "Network": transport security, hosts allowed on private
 * addresses, and the trust anchors (`tlsCa`) that verify the server certificate.
 *
 * Plain `ldap://` without StartTLS is refused unless `allowPlaintext` is set:
 * search terms and the records returned are personal data. A service bind is
 * never sent in plain text, whatever the flag says.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'} props.transport - Connection security
 */
function NetworkSection({ form, update, transport }) {
  const { t } = useTranslation();

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

      <div>
        <label htmlFor="pd-tls-ca" className={LABEL_CLASS}>
          {t('admin.peopleDirectories.network.tlsCa', 'Trusted certificates')}
        </label>
        <textarea
          id="pd-tls-ca"
          rows={2}
          spellCheck={false}
          value={form.tlsCa}
          onChange={e => update({ tlsCa: e.target.value })}
          placeholder="pca-1-verwaltung-23"
          aria-describedby="pd-tls-ca-help"
          className={MONO_INPUT_CLASS}
        />
        <p id="pd-tls-ca-help" className={HELP_CLASS}>
          {t(
            'admin.peopleDirectories.network.tlsCaHelp',
            "Only for a CA that the iHub server does not trust already. One name per line: the file contents/config/certs/<name>.pem on the server. When set, only these certificates verify the server's certificate. Leave empty to use the public roots and the server's operating system certificate store. Verification stays on unless the host is on the platform's SSL whitelist."
          )}
        </p>
      </div>
    </FormSection>
  );
}

export default NetworkSection;
