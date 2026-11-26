// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useProjectsConfig } from '../../projects/hooks/useProjects';
import { textRecognitionAvailable } from '../../upload/utils/textRecognition';

/**
 * Where a generated picture can go because the server recognizes the text of
 * images (#3986), for "Use in app…" and "Copy to project…":
 *
 * - `apps`: a text recognition model is set
 *   (`platformConfig.uploads.textRecognition.available`); the app picker then
 *   lists the apps whose chats use it (`appsAcceptingFile`).
 * - `projects`: projects recognize the text of images
 *   (`GET /api/projects/_config` → `textRecognition.enabled`). Read only where
 *   user projects are on; the configuration is loaded once per viewer.
 *
 * Pass them to `canUseArtifactInApp(artifact, { textRecognition: apps })` and
 * `canCopyArtifactToProject(artifact, { textRecognition: projects })`.
 *
 * @returns {{apps: boolean, projects: boolean}}
 */
export default function useImageTextRecognition() {
  const { platformConfig } = usePlatformConfig() || {};
  const { config } = useProjectsConfig();
  const apps = textRecognitionAvailable(platformConfig?.uploads);
  const projects = config?.textRecognition?.enabled === true;
  return useMemo(() => ({ apps, projects }), [apps, projects]);
}
