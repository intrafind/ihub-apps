// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useRef } from 'react';
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
    // A Set keeps each id once, at its first place: a repeat never pushes a real id out.
    const list = [...new Set([...readToasted(), ...ids])].slice(-MAX_REMEMBERED);
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
 * Each run is toasted once per page: a navigation or a language switch does
 * not bring back a toast the person closed.
 *
 * @returns {null}
 */
export default function ScheduledTaskNotifier() {
  const { t } = useTranslation();
  const location = useLocation();
  const { items } = useScheduledTaskNotifications();
  const { show } = useToasts();
  // The runs handled since the page loaded. `fresh` changes only with the next
  // poll, while the effect also runs on each navigation: without this a toast
  // the person closed would come back, and be said again.
  const handledRef = useRef(new Set());

  const fresh = useMemo(() => {
    const toasted = readToasted();
    return items.filter(item => !toasted.has(item.id));
    // `items` is the dependency; the stored set is read at compute time.
  }, [items]);

  useEffect(() => {
    const handled = handledRef.current;
    const unhandled = fresh.filter(item => !handled.has(item.id));
    if (unhandled.length === 0) return;
    for (const item of unhandled) handled.add(item.id);
    rememberToasted(unhandled.map(item => item.id));
    // Not on the page that already lists them.
    if (location.pathname.startsWith('/tasks')) return;
    for (const item of unhandled.slice(0, MAX_TOASTED)) {
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
