// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchChatArtifact, fetchChatArtifacts } from '../../../api';
import ArtifactViewer from '../components/ArtifactViewer';
import { isOpenable } from '../utils/artifactFiles';

/**
 * One artifact of the signed-in user's chat on its own page
 * (`/artifacts/:chatId/:artifactId`): the immersive viewer as a whole page,
 * what "Open in new tab" opens. It loads this iHub page, which frames the
 * artifact like the in-chat viewer does — never the artifact's own bytes as a
 * `blob:` document, which would run its scripts on the iHub origin.
 *
 * @returns {JSX.Element}
 */
export default function ArtifactPage() {
  const { chatId, artifactId } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState({ status: 'loading', items: [] });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', items: [] });
    fetchChatArtifacts(chatId)
      .then(result => {
        if (active) setState({ status: 'ready', items: result?.items || [] });
      })
      .catch(() => {
        if (active) setState({ status: 'error', items: [] });
      });
    return () => {
      active = false;
    };
  }, [chatId]);

  const openable = useMemo(() => state.items.filter(isOpenable), [state.items]);
  const artifact = openable.find(item => item.id === artifactId) || null;
  const getBlob = useCallback(item => fetchChatArtifact(chatId, item.id), [chatId]);

  if (state.status === 'loading') {
    return (
      <p className="p-6 text-sm text-gray-600 dark:text-gray-300" role="status">
        {t('chatArtifacts.previewLoading', 'Loading preview…')}
      </p>
    );
  }
  if (state.status === 'error' || !artifact) {
    return (
      <p className="p-6 text-sm text-red-700 dark:text-red-400" role="alert">
        {t('chatArtifacts.pageNotFound', 'This file could not be found.')}
      </p>
    );
  }

  return (
    <ArtifactViewer
      mode="page"
      artifact={artifact}
      artifacts={openable}
      onSelect={item =>
        navigate(`/artifacts/${encodeURIComponent(chatId)}/${encodeURIComponent(item.id)}`, {
          replace: true
        })
      }
      getBlob={getBlob}
    />
  );
}
