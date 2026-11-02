// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../../../shared/components/Icon';

const K = 'admin.integrations.editors.peopleDirectory.transport';

/** Badge tones: text colours meet 4.5:1 on their own background in both themes. */
const TONES = {
  success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  neutral: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
};

/**
 * How a directory connection is secured, as a badge. Plain text is a warning:
 * the search terms and the returned records are personal data.
 *
 * @param {Object} props
 * @param {'ldaps'|'starttls'|'plaintext'|'unknown'|string} props.transport
 */
function TransportBadge({ transport }) {
  const { t } = useTranslation();
  const badge = (tone, icon, text, title) => (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
      title={title}
      data-testid="transport-badge"
    >
      {icon && <Icon name={icon} size="xs" />}
      {text}
    </span>
  );
  switch (transport) {
    case 'ldaps':
      return badge('success', 'lock-closed', t(`${K}.ldaps`, 'Encrypted (LDAPS)'));
    case 'starttls':
      return badge('success', 'lock-closed', t(`${K}.starttls`, 'Encrypted (StartTLS)'));
    case 'plaintext':
      return badge(
        'warning',
        'exclamation-triangle',
        t(`${K}.plaintext`, 'Plain text'),
        t(`${K}.plaintextHint`, 'Search terms and results cross the network unencrypted.')
      );
    default:
      return badge('neutral', null, t(`${K}.unknown`, 'Not known yet'));
  }
}

export default TransportBadge;
