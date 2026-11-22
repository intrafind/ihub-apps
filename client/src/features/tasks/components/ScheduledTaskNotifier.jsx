// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useToasts } from '../../../shared/components/ToastHost';
import { useScheduledTaskNotifications } from '../hooks/useScheduledTasks';
import { runChatLink } from '../utils/taskFormat';

const STORAGE_KEY = 'ihub.scheduledTasks.toastedRuns';
const MAX_REMEMBERED = 200;
/** Most runs toasted from one poll; the others are listed on the Tasks page. */
const MAX_TOASTED = 3;

function readToasted() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function rememberToasted(ids) {
  try {
    const list = [...readToasted(), ...ids].slice(-MAX_REMEMBERED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode: the toast may show again next time, nothing worse.
  }
}

/**
 * A toast for scheduled runs that finished while the user was away — once
 * per run and browser, on the next page load (and when the slow poll finds
 * one). The runs stay listed as new on the Tasks page until their chat is
 * opened. The toasts are the page's `ToastHost`'s: a run that waits for the
 * owner's approval stays until it is closed, the others close by themselves.
 *
 * @returns {null}
 */
export default function ScheduledTaskNotifier() {
  const { t } = useTranslation();
  const location = useLocation();
  const { items } = useScheduledTaskNotifications();
  const { show } = useToasts();

  const fresh = useMemo(() => {
    const toasted = readToasted();
    return items.filter(item => !toasted.has(item.id));
    // `items` is the dependency; the stored set is read at compute time.
  }, [items]);

  useEffect(() => {
    if (fresh.length === 0) return;
    rememberToasted(fresh.map(item => item.id));
    // Not on the page that already lists them.
    if (location.pathname.startsWith('/tasks')) return;
    for (const item of fresh.slice(0, MAX_TOASTED)) {
      const waiting = item.status === 'awaiting_approval';
      const failed = item.status === 'failed';
      let status = t('scheduledTasks.toast.finished', 'finished');
      if (failed) status = t('scheduledTasks.toast.failed', 'failed');
      if (waiting) status = t('scheduledTasks.toast.awaitingApproval', 'needs your approval');
      const chatLink = runChatLink(item.appId, item.chatId);
      const links = [];
      if (chatLink && !waiting) {
        links.push({ label: t('scheduledTasks.openChat', 'Open chat'), to: chatLink });
      }
      links.push({ label: t('scheduledTasks.openTask', 'Open task'), to: `/tasks/${item.taskId}` });
      show({
        id: `scheduled-run:${item.id}`,
        text: t('scheduledTasks.toast.title', '"{{name}}" {{status}}', {
          name: item.taskName,
          status
        }),
        tone: failed ? 'danger' : 'info',
        icon: failed ? 'exclamation-triangle' : 'calendar',
        links,
        needsYou: waiting
      });
    }
  }, [fresh, location.pathname, show, t]);

  return null;
}
