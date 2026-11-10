// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { answerIndex, uploadedKeyOf } from '../utils/workspaceItems';

/** How long to wait before asking once more for an answer's files the list lacks. */
const RELIST_DELAY_MS = 1500;

/**
 * The generated and the uploaded files of a chat, read while the workspace
 * pane is open, so the Files index and the title switcher show the same list.
 *
 * The generated list is read again when an answer that produced a file
 * finishes; the uploaded one when the questions name other files or one was
 * deleted (`reloadUploaded`).
 *
 * @param {Object} params
 * @param {{ list: () => Promise<{ items: Object[] }> }|null} params.artifacts
 * @param {{ list: () => Promise<{ items: Object[] }> }|null} params.uploaded
 * @param {Object[]} params.messages
 * @param {boolean} params.enabled - The pane is open.
 * @returns {{ generated: { status: string, items: Object[] }, uploaded: { status: string,
 *   items: Object[] }, reloadUploaded: () => void }}
 */
export default function useWorkspaceLists({ artifacts, uploaded, messages, enabled }) {
  const [generated, setGenerated] = useState({ status: 'idle', items: [] });
  const [uploadedList, setUploadedList] = useState({ status: 'idle', items: [] });
  const [uploadedReload, setUploadedReload] = useState(0);
  const listKey = useMemo(() => answerIndex(messages).producedRuns.join(','), [messages]);
  const uploadedKey = useMemo(() => uploadedKeyOf(messages), [messages]);

  useEffect(() => {
    if (!enabled || !artifacts) return undefined;
    let active = true;
    let retry = null;
    const expected = listKey ? listKey.split(',') : [];
    setGenerated(previous =>
      previous.status === 'ready' ? previous : { ...previous, status: 'loading' }
    );
    const load = attempt =>
      artifacts
        .list()
        .then(result => {
          if (!active) return;
          const list = Array.isArray(result?.items) ? result.items : [];
          // An answer that just finished is stored a moment after the client
          // sees it end: ask once more when its files are not listed yet.
          const listed = new Set(list.map(item => item.runId).filter(Boolean));
          if (attempt === 0 && expected.some(runId => !listed.has(runId))) {
            retry = setTimeout(() => void load(1), RELIST_DELAY_MS);
          }
          setGenerated({ status: 'ready', items: list });
        })
        .catch(() => {
          if (active) setGenerated({ status: 'error', items: [] });
        });
    // `load` ends in its own catch: nothing is left to await here.
    void load(0);
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
    };
  }, [enabled, artifacts, listKey]);

  useEffect(() => {
    if (!enabled || !uploaded) return undefined;
    let active = true;
    setUploadedList(previous =>
      previous.status === 'ready' ? previous : { ...previous, status: 'loading' }
    );
    uploaded
      .list()
      .then(result => {
        if (active) {
          setUploadedList({
            status: 'ready',
            items: Array.isArray(result?.items) ? result.items : []
          });
        }
      })
      .catch(error => {
        if (!active) return;
        // A chat the server does not have yet has no files.
        const missing = error?.status === 404 || error?.response?.status === 404;
        setUploadedList(missing ? { status: 'ready', items: [] } : { status: 'error', items: [] });
      });
    return () => {
      active = false;
    };
  }, [enabled, uploaded, uploadedKey, uploadedReload]);

  const reloadUploaded = useCallback(() => setUploadedReload(value => value + 1), []);
  return { generated, uploaded: uploadedList, reloadUploaded };
}
