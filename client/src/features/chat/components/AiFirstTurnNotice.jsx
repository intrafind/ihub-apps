// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { resolveFirstTurnNotice } from '../../../../../shared/aiDisclosure.js';

/**
 * Passive "you are chatting with an AI" notice for the empty chat (EU AI Act
 * Art. 50(1)). Pure UI: it is never a message, never sent to the model and
 * never stored. The parent renders it only while the chat is empty, so it
 * unmounts with the first message. Not a live region: it is page content, not
 * an announcement.
 */
function AiFirstTurnNotice({ app }) {
  const { t, i18n } = useTranslation();
  const { platformConfig } = usePlatformConfig();
  // Until the platform config has loaded there is nothing to resolve against;
  // render nothing rather than flash the built-in text before an admin's own.
  if (!platformConfig) return null;

  const { visible, text } = resolveFirstTurnNotice({
    platform: platformConfig.aiDisclosure,
    app,
    language: i18n.language,
    t: key => t(key)
  });
  if (!visible) return null;

  const html = DOMPurify.sanitize(marked.parseInline(text), {
    ADD_ATTR: ['target', 'rel']
  });

  return (
    <p
      role="note"
      data-testid="ai-first-turn-notice"
      className="mt-6 mx-auto max-w-md px-4 flex items-start justify-center gap-2 text-center text-sm leading-5 text-gray-600 dark:text-gray-400 [&_a]:font-medium [&_a]:text-indigo-700 dark:[&_a]:text-indigo-300 [&_a]:underline [&_a]:underline-offset-2"
    >
      <Icon
        name="information-circle"
        size="sm"
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400"
      />
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </p>
  );
}

export default AiFirstTurnNotice;
