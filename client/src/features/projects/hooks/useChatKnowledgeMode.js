// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setChatKnowledgeMode } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';

/**
 * The knowledge mode of the open chat (#3538): how its projects reach the model,
 * switched from the project chip. A change to a stored chat is saved at once;
 * for a chat that is not stored yet the mode is kept by the caller and rides on
 * the first message (`knowledgeMode`). An empty value is the projects' own.
 *
 * @param {Object} options
 * @param {string|null} options.chatId
 * @param {boolean} options.stored - The chat exists server-side, so a change is saved now.
 * @param {string} options.value - The chat's mode, '' for none.
 * @param {(mode: string) => void} options.onChange
 * @returns {{set: (mode: string) => Promise<void>, saving: boolean, error: string|null}}
 */
export function useChatKnowledgeMode({ chatId, stored, value, onChange }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  // A failure belongs to the chat it happened in.
  const [failure, setFailure] = useState(null);
  const error = failure?.chatId === chatId ? (failure?.message ?? null) : null;
  const currentChatIdRef = useRef(chatId);
  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  const set = async mode => {
    setFailure(null);
    if (!stored || !chatId) {
      onChange(mode);
      return;
    }
    setSaving(true);
    const origin = chatId;
    try {
      const chat = await setChatKnowledgeMode(origin, mode || null);
      if (currentChatIdRef.current !== origin) return;
      onChange(typeof chat?.knowledgeMode === 'string' ? chat.knowledgeMode : '');
    } catch (err) {
      if (currentChatIdRef.current === origin) {
        setFailure({ chatId: origin, message: projectErrorMessage(err, t) });
      }
    } finally {
      setSaving(false);
    }
  };

  return { set, saving, error, value };
}
