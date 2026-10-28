// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { commonNameOf, formatCertificateDate } from '../../utils/peopleDirectories';
import { CALLOUT_CLASS } from './formStyles';

/**
 * The certificate chain a directory server sent, as the connection test
 * reports it: subject, issuer, validity and SHA-256 fingerprint of each
 * certificate, and — when verification failed — the issuer iHub does not
 * trust.
 *
 * iHub never adds a trust anchor by itself. The admin compares the missing
 * issuer's fingerprint with the publisher's and uploads it on the
 * Certificates tab. The chain starts folded when the connection succeeded.
 *
 * @param {Object} props
 * @param {Array<{subject?: string, issuer?: string, validFrom?: string, validTo?: string, fingerprint256?: string}>} props.chain
 * @param {string|{subjectCN?: string, subject?: string}} [props.missingIssuer] - The issuer
 *   that is not trusted, as its subject or a certificate-like description
 * @param {boolean} [props.defaultOpen=true] - Whether the chain starts unfolded
 */
function CertificateChain({ chain, missingIssuer, defaultOpen = true }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const issuerSubject =
    typeof missingIssuer === 'string'
      ? missingIssuer
      : missingIssuer?.subjectCN || missingIssuer?.subject || missingIssuer?.name || '';
  const issuerName = commonNameOf(issuerSubject);

  return (
    <div className="space-y-3">
      {issuerName && (
        <div className={CALLOUT_CLASS.warning} role="note">
          {t(
            'admin.peopleDirectories.test.missingIssuer',
            'The issuer "{{issuer}}" is not trusted. Get its certificate from the publisher, compare the fingerprint, upload it on the Certificates tab and select it under Network → Trusted certificates.',
            { issuer: issuerName }
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-controls={listId}
        className="inline-flex items-center gap-1 min-h-[24px] rounded-sm text-sm font-semibold text-gray-900 dark:text-gray-100 hover:underline focus:outline-hidden focus:ring-2 focus:ring-blue-500"
      >
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" />
        {t(
          'admin.peopleDirectories.test.chainTitle',
          'Certificate chain sent by the server ({{count}})',
          {
            count: chain.length
          }
        )}
      </button>
      <ol id={listId} hidden={!open} className="space-y-2">
        {chain.map(certificate => (
          <li
            key={[certificate.fingerprint256, certificate.subject, certificate.validTo].join('|')}
            className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
          >
            <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.certificates.subject', 'Subject')}
              </dt>
              <dd className="whitespace-pre-line break-all text-gray-900 dark:text-gray-100 sm:col-span-3">
                {certificate.subject || '—'}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.certificates.issuer', 'Issuer')}
              </dt>
              <dd className="whitespace-pre-line break-all text-gray-900 dark:text-gray-100 sm:col-span-3">
                {certificate.issuer || '—'}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.certificates.validity', 'Valid')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100 sm:col-span-3">
                {t('admin.peopleDirectories.certificates.validityRange', '{{from}} to {{to}}', {
                  from: formatCertificateDate(certificate.validFrom, i18n.language) || '—',
                  to: formatCertificateDate(certificate.validTo, i18n.language) || '—'
                })}
              </dd>
              <dt className="font-medium text-gray-700 dark:text-gray-300">
                {t('admin.peopleDirectories.certificates.fingerprint', 'SHA-256 fingerprint')}
              </dt>
              <dd className="font-mono break-all text-gray-900 dark:text-gray-100 sm:col-span-3">
                {certificate.fingerprint256 || '—'}
              </dd>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default CertificateChain;
