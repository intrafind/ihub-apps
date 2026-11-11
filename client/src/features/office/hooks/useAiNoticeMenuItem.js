// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { useAiAcknowledgement } from '../../../shared/hooks/useAiAcknowledgement';

/**
 * The pane menu's "AI-use notice" entry (as a list, to spread into the menu),
 * which reopens the notice to read it again or, when it is pending, to confirm
 * it. Empty while the feature is off or the pane has no acknowledgement gate.
 *
 * @returns {Array<{key: string, label: string, onClick: Function}>}
 */
export default function useAiNoticeMenuItem() {
  const { t } = useTranslation();
  const acknowledgement = useAiAcknowledgement();
  if (!acknowledgement?.available) return [];
  return [
    {
      key: 'aiNotice',
      label: t('office.menu.aiNotice', 'AI-use notice'),
      onClick: () => {
        void acknowledgement.review();
      }
    }
  ];
}
