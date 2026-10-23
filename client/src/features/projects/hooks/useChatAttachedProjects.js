// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setChatAttachedProjects } from '../../../api';
import { projectErrorMessage } from '../utils/projectErrors';

/** Most projects a chat may have attached (the server's `MAX_ATTACHED`). */
export const MAX_ATTACHED_PROJECTS = 10;

/**
 * The projects a chat draws on besides its own container: ticking and
 * removing them. Changes to a stored chat are saved at once; for a chat that
 * is not stored yet the list is kept by the caller and rides on the next
 * message (`projects`).
 *
 * @param {Object} options
 * @param {string|null} options.chatId
 * @param {boolean} options.stored - The chat exists server-side, so a change is saved now.
 * @param {string[]} options.value - The attached project ids.
 * @param {(ids: string[]) => void} options.onChange
 * @returns {{toggle: (id: string) => Promise<void>, saving: boolean, error: string|null, full: boolean}}
 */
export function useChatAttachedProjects({ chatId, stored, value, onChange }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const apply = async next => {
    setError(null);
    if (!stored || !chatId) {
      onChange(next);
      return;
    }
    setSaving(true);
    try {
      const result = await setChatAttachedProjects(chatId, next);
      onChange(
        Array.isArray(result?.chat?.attachedProjectIds) ? result.chat.attachedProjectIds : next
      );
    } catch (err) {
      setError(projectErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const toggle = id =>
    apply(value.includes(id) ? value.filter(entry => entry !== id) : [...value, id]);

  return { toggle, saving, error, full: value.length >= MAX_ATTACHED_PROJECTS };
}
