// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import DirectoryBadge from './DirectoryBadge';

/**
 * How a directory connection is secured, as a badge. Plain text is a warning:
 * the search terms and the returned records are personal data.
 *
 * @param {Object} props
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'|string} props.transport
 */
function TransportBadge({ transport }) {
  const { t } = useTranslation();
  switch (transport) {
    case 'ldaps':
      return (
        <DirectoryBadge tone="success" icon="lock-closed">
          {t('admin.peopleDirectories.transport.ldaps', 'Encrypted (LDAPS)')}
        </DirectoryBadge>
      );
    case 'starttls':
      return (
        <DirectoryBadge tone="success" icon="lock-closed">
          {t('admin.peopleDirectories.transport.starttls', 'Encrypted (StartTLS)')}
        </DirectoryBadge>
      );
    case 'plaintext':
      return (
        <DirectoryBadge
          tone="warning"
          icon="exclamation-triangle"
          title={t(
            'admin.peopleDirectories.transport.plaintextHint',
            'Search terms and results cross the network unencrypted.'
          )}
        >
          {t('admin.peopleDirectories.transport.plaintext', 'Plain text')}
        </DirectoryBadge>
      );
    default:
      return (
        <DirectoryBadge tone="neutral">
          {t('admin.peopleDirectories.transport.unknown', 'Not known yet')}
        </DirectoryBadge>
      );
  }
}

export default TransportBadge;
