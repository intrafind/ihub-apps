// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DirectoryBadge from './DirectoryBadge';
import { certificateExpiryState, formatCertificateDate } from '../../utils/peopleDirectories';

/**
 * Badges for a certificate: expiry (from 90 days before), CA and self-signed.
 *
 * @param {Object} props
 * @param {Object} props.certificate - A certificate description from the store or a preview
 */
export function CertificateBadges({ certificate }) {
  const { t } = useTranslation();
  const expiry = certificateExpiryState(certificate);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {expiry === 'expired' && (
        <DirectoryBadge tone="danger" icon="exclamation-triangle">
          {t('admin.peopleDirectories.certificates.expired', 'Expired')}
        </DirectoryBadge>
      )}
      {expiry === 'expiringSoon' && (
        <DirectoryBadge tone="warning" icon="exclamation-triangle">
          {t('admin.peopleDirectories.certificates.expiresIn', 'Expires in {{count}} days', {
            count: certificate.daysUntilExpiry
          })}
        </DirectoryBadge>
      )}
      {certificate.ca && (
        <DirectoryBadge tone="info">
          {t('admin.peopleDirectories.certificates.ca', 'CA')}
        </DirectoryBadge>
      )}
      {certificate.selfSigned && (
        <DirectoryBadge tone="neutral">
          {t('admin.peopleDirectories.certificates.selfSigned', 'Self-signed (root)')}
        </DirectoryBadge>
      )}
    </span>
  );
}

/**
 * The facts an admin checks before trusting a certificate: subject, issuer,
 * validity, serial number and SHA-256 fingerprint.
 *
 * @param {Object} props
 * @param {Object} props.certificate - A certificate description from the store or a preview
 */
function CertificateDetails({ certificate }) {
  const { t, i18n } = useTranslation();
  const rows = [
    [t('admin.peopleDirectories.certificates.subject', 'Subject'), certificate.subject, 'pre'],
    [t('admin.peopleDirectories.certificates.issuer', 'Issuer'), certificate.issuer, 'pre'],
    [
      t('admin.peopleDirectories.certificates.validity', 'Valid'),
      t('admin.peopleDirectories.certificates.validityRange', '{{from}} to {{to}}', {
        from: formatCertificateDate(certificate.validFrom, i18n.language) || '—',
        to: formatCertificateDate(certificate.validTo, i18n.language) || '—'
      })
    ],
    [
      t('admin.peopleDirectories.certificates.serialNumber', 'Serial number'),
      certificate.serialNumber,
      'mono'
    ],
    [
      t('admin.peopleDirectories.certificates.fingerprint', 'SHA-256 fingerprint'),
      certificate.fingerprint256,
      'mono'
    ]
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 text-sm sm:grid-cols-4">
      {rows.map(([label, value, style]) => (
        <div key={label} className="contents">
          <dt className="font-medium text-gray-700 dark:text-gray-300">{label}</dt>
          <dd
            className={`text-gray-900 dark:text-gray-100 break-all sm:col-span-3 ${
              style === 'pre' ? 'whitespace-pre-line' : ''
            } ${style === 'mono' ? 'font-mono text-xs leading-5' : ''}`}
          >
            {value || '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default CertificateDetails;
