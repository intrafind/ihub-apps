// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * An app's usage guide (issue #2838): pre-written "how to use this app" text
 * from the app's configuration, shown without a model call.
 *
 * Reads `app.usageGuide.content`, which comes with the app's details
 * (`GET /api/apps/:appId`) — the app list leaves it out.
 *
 * @param {Object} app
 * @param {string} currentLanguage
 * @returns {{available: boolean, question: string, content: string}}
 */
export default function useUsageGuide(app, currentLanguage) {
  const { t } = useTranslation();
  const content = getLocalizedContent(app?.usageGuide?.content, currentLanguage)?.trim() || '';
  const question =
    getLocalizedContent(app?.usageGuide?.question, currentLanguage)?.trim() ||
    t('usageGuide.question', 'How do I use this app?');
  return { available: content !== '', question, content };
}
