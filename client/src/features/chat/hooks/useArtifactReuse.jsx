// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Suspense, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import lazyWithRetry from '../../../utils/lazyWithRetry';
import { useProjectsAvailability } from '../../projects/hooks/useProjects';
import { canCopyArtifactToProject } from '../../projects/utils/projectImport';
import { openAppWithAttachment } from '../openAppWithAttachment';
import { artifactDisplayName } from '../utils/artifactFiles';
import {
  CHAT_ARTIFACT_SOURCE,
  artifactAttachment,
  artifactRef,
  canUseArtifactInApp
} from '../utils/useInApp';

// Loaded when first opened: most chats never use them.
const UseInAppDialog = lazyWithRetry(() => import('../components/UseInAppDialog'));
const CopyToProjectDialog = lazyWithRetry(
  () => import('../../projects/components/CopyToProjectDialog')
);

/**
 * "Use in app…" and "Copy to project…" for the generated files of one chat
 * (the owner's chat page) or one share (a shared chat, a shared file): the
 * handlers the workspace pane and the cards call, and the dialogs
 * they open. Every page that shows artifacts mounts the same flow through it.
 *
 * - **Use in app**: never for pictures or ZIP archives (`canUseArtifactInApp`); the app picker; the chosen app opens a new chat with a copy
 *   of the file attached (`openAppWithAttachment`). `onUseInCurrentApp` lets the
 *   page that *is* that app start the new chat itself.
 * - **Copy to project**: the project dialog, which then says how many documents
 *   were added, what was skipped and why, and links to the project. Offered only
 *   where user projects are on, never for pictures.
 *
 * @param {Object} options
 * @param {{chatId?: string, shareId?: string}|null} options.owner - Where the artifacts live
 *   (`artifactRef`). Without one nothing is offered.
 * @param {boolean} [options.enabled=true] - Whether the page may offer the actions at all
 *   (a signed-in viewer, not an embedded chat).
 * @param {string} [options.currentAppId] - The app of the page.
 * @param {(attachment: Object) => void} [options.onUseInCurrentApp] - Picking `currentAppId`.
 * @returns {{onUseInApp: ((artifact: Object) => void)|null,
 *   onCopyToProject: ((artifact: Object) => void)|null,
 *   menuItems: (artifact: Object, t: Function) => Array<Object>, elements: JSX.Element}}
 *   `menuItems` are ⋯ items (`PaneHeader`'s `MenuAction`) for a viewer outside a workspace
 *   pane (a shared file page); `elements` are the dialogs, to render once.
 *
 * @example
 * const reuse = useArtifactReuse({ owner: { chatId }, enabled: !embedded });
 * <ArtifactViewerHost onUseInApp={reuse.onUseInApp} onCopyToProject={reuse.onCopyToProject}>
 * {reuse.elements}
 */
export default function useArtifactReuse({
  owner,
  enabled = true,
  currentAppId = null,
  onUseInCurrentApp = null
}) {
  const navigate = useNavigate();
  const { userProjectsEnabled } = useProjectsAvailability();
  const [attachment, setAttachment] = useState(null);
  const [copyTarget, setCopyTarget] = useState(null);
  const chatId = owner?.chatId || null;
  const shareId = owner?.shareId || null;
  const active = Boolean(enabled && (chatId || shareId));

  const onUseInApp = useMemo(
    () =>
      active
        ? artifact =>
            setAttachment(
              artifactAttachment({ chatId, shareId }, artifact, artifactDisplayName(artifact))
            )
        : null,
    [active, chatId, shareId]
  );

  const onCopyToProject = useMemo(
    () =>
      active && userProjectsEnabled
        ? artifact => {
            const ref = artifactRef({ chatId, shareId }, artifact?.id);
            if (!ref) return;
            setCopyTarget({
              source: { kind: CHAT_ARTIFACT_SOURCE, ref },
              name: artifactDisplayName(artifact)
            });
          }
        : null,
    [active, userProjectsEnabled, chatId, shareId]
  );

  const handleSelect = useCallback(
    app => {
      const picked = attachment;
      setAttachment(null);
      if (!picked || !app?.id) return;
      if (app.id === currentAppId && onUseInCurrentApp) onUseInCurrentApp(picked);
      else openAppWithAttachment({ navigate, appId: app.id, attachment: picked });
    },
    [attachment, currentAppId, onUseInCurrentApp, navigate]
  );

  const menuItems = useCallback(
    (artifact, t) => [
      ...(onUseInApp && canUseArtifactInApp(artifact)
        ? [
            {
              key: 'use-in-app',
              icon: 'chat-bubble-left-right',
              label: t('chatArtifacts.useInApp', 'Use in app…'),
              onClick: () => onUseInApp(artifact),
              testId: 'artifact-viewer-use-in-app'
            }
          ]
        : []),
      ...(onCopyToProject && canCopyArtifactToProject(artifact)
        ? [
            {
              key: 'copy-to-project',
              icon: 'folder',
              label: t('chatArtifacts.copyToProject', 'Copy to project…'),
              onClick: () => onCopyToProject(artifact),
              testId: 'artifact-viewer-copy-to-project'
            }
          ]
        : [])
    ],
    [onUseInApp, onCopyToProject]
  );

  const elements = (
    <>
      {attachment && (
        <Suspense fallback={null}>
          <UseInAppDialog
            isOpen
            attachment={attachment}
            onClose={() => setAttachment(null)}
            onSelect={handleSelect}
          />
        </Suspense>
      )}
      {copyTarget && (
        <Suspense fallback={null}>
          <CopyToProjectDialog
            isOpen
            source={copyTarget.source}
            fileName={copyTarget.name}
            onClose={() => setCopyTarget(null)}
          />
        </Suspense>
      )}
    </>
  );

  return { onUseInApp, onCopyToProject, menuItems, elements };
}
