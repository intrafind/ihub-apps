// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../../../shared/components/Icon';
import { EditorSection, FieldError } from '../InstallationEditorParts';
import TransportBadge from './TransportBadge';
import {
  CALLOUT_CLASS,
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  MONO_INPUT_CLASS
} from '../../../formStyles';
import { TLS_VERSIONS } from '../peopleDirectoryEditorModel';

const K = 'admin.integrations.editors.peopleDirectory.network';

/**
 * Section "Network" of the People directory (LDAP) editor: transport
 * security, hosts allowed on private addresses, the trust anchors (`tlsCa`)
 * that verify the server certificate, and — folded away — the TLS versions
 * and cipher suites.
 *
 * Plain `ldap://` without StartTLS is refused unless `allowPlaintext` is set:
 * search terms and the records returned are personal data. A service bind is
 * never sent in plain text, whatever the flag says. Certificate verification
 * itself cannot be switched off here; only the platform's SSL whitelist does.
 *
 * @param {Object} props
 * @param {Object} props.form - Form state
 * @param {(patch: Object) => void} props.update - Merge a patch into the form
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'} props.transport - Connection security
 * @param {Object<string,string>} props.errors - Field errors by install field
 */
function NetworkSection({ form, update, transport, errors }) {
  const { t } = useTranslation();
  const [tlsOpen, setTlsOpen] = useState(
    Boolean(form.tlsMinVersion || form.tlsMaxVersion || form.tlsCiphers)
  );

  const versionSelect = (key, id, label) => (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        value={form[key]}
        onChange={e => update({ [key]: e.target.value })}
        className={INPUT_CLASS}
      >
        <option value="">{t(`${K}.tlsDefault`, "Node's default")}</option>
        {TLS_VERSIONS.map(version => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <EditorSection
      id="pd-network"
      title={t(`${K}.title`, 'Network')}
      description={t(
        `${K}.description`,
        'How the connection is secured and which servers iHub may reach.'
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <span className="font-medium">{t(`${K}.transport`, 'Transport')}:</span>
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
            {t(`${K}.allowPlaintext`, 'Allow plain-text connections (ldap:// without StartTLS)')}
          </span>
        </label>
        <p id="pd-allow-plaintext-warning" className={`${CALLOUT_CLASS.warning} mt-2 ml-7`}>
          {t(
            `${K}.plaintextWarning`,
            'Without TLS, the search terms and the records the directory returns — names, phone numbers, e-mail addresses — cross the network in plain text. Use ldaps://host:636, or ldap://host:389 with StartTLS, whenever the server supports it. A service account password is never sent in plain text.'
          )}
        </p>
        {transport === 'plaintext' && !form.allowPlaintext && (
          <div className={`${CALLOUT_CLASS.danger} mt-2 ml-7`} role="note">
            {t(
              `${K}.plaintextRefused`,
              'This directory uses ldap:// without StartTLS. iHub refuses the connection until plain text is allowed here — better switch to ldaps:// or StartTLS.'
            )}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="pd-allowed-hosts" className={LABEL_CLASS}>
          {t(`${K}.allowedHosts`, 'Hosts allowed on private addresses')}
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
            `${K}.allowedHostsHelp`,
            'One host per line. iHub refuses a directory host that resolves to a private, loopback or link-local address unless it is listed here or in the platform-wide SSRF allow-list. The host of a reused sign-in provider is always allowed.'
          )}
        </p>
        <FieldError message={errors.allowedHosts} />
      </div>

      <div>
        <label htmlFor="pd-tls-ca" className={LABEL_CLASS}>
          {t(`${K}.tlsCa`, 'Trusted certificates')}
        </label>
        <textarea
          id="pd-tls-ca"
          rows={2}
          spellCheck={false}
          value={form.tlsCa}
          onChange={e => update({ tlsCa: e.target.value })}
          placeholder="pca-1-verwaltung-23"
          aria-describedby="pd-tls-ca-help"
          aria-invalid={errors.tlsCa ? 'true' : undefined}
          className={MONO_INPUT_CLASS}
        />
        <p id="pd-tls-ca-help" className={HELP_CLASS}>
          {t(
            `${K}.tlsCaHelp`,
            "Only for a CA that the iHub server does not trust already. One name per line: the file contents/config/certs/<name>.pem on the server. When set, only these certificates verify the server's certificate. Leave empty to use the public roots and the server's operating system certificate store. Verification stays on unless the host is on the platform's SSL whitelist."
          )}
        </p>
        <FieldError message={errors.tlsCa} />
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
        <button
          type="button"
          onClick={() => setTlsOpen(open => !open)}
          aria-expanded={tlsOpen}
          aria-controls="pd-tls-settings"
          className="inline-flex items-center min-h-[24px] text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-blue-500 rounded-sm"
        >
          <Icon name={tlsOpen ? 'chevron-up' : 'chevron-down'} size="sm" className="mr-1" />
          {t(`${K}.tlsSettings`, 'TLS versions and cipher suites')}
        </button>
        <div id="pd-tls-settings" hidden={!tlsOpen} className="mt-3 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {versionSelect(
              'tlsMinVersion',
              'pd-tls-min-version',
              t(`${K}.tlsMinVersion`, 'Minimum TLS version')
            )}
            {versionSelect(
              'tlsMaxVersion',
              'pd-tls-max-version',
              t(`${K}.tlsMaxVersion`, 'Maximum TLS version')
            )}
          </div>
          <div>
            <label htmlFor="pd-tls-ciphers" className={LABEL_CLASS}>
              {t(`${K}.tlsCiphers`, 'Cipher suites')}
            </label>
            <input
              id="pd-tls-ciphers"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.tlsCiphers}
              onChange={e => update({ tlsCiphers: e.target.value })}
              aria-describedby="pd-tls-ciphers-help"
              className={MONO_INPUT_CLASS}
            />
            <p id="pd-tls-ciphers-help" className={HELP_CLASS}>
              {t(
                `${K}.tlsCiphersHelp`,
                "An OpenSSL cipher list. Empty: Node's defaults. These are the only TLS settings a directory may change; a reused sign-in provider's values for them apply unless set here."
              )}
            </p>
          </div>
        </div>
      </div>
    </EditorSection>
  );
}

export default NetworkSection;
