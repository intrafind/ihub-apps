// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import { useProjectsConfig } from '../../projects/hooks/useProjects';
import {
  recognizableImageTypes,
  textRecognitionAvailable
} from '../../upload/utils/textRecognition';

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
 * - `appImageTypes` / `projectImageTypes`: the image types the engine reads
 *   (an OCR integration may read fewer than a model).
 *
 * Pass them to `canUseArtifactInApp(artifact, { textRecognition: apps, imageTypes: appImageTypes })`
 * and `canCopyArtifactToProject(artifact, { textRecognition: projects, imageTypes: projectImageTypes })`.
 *
 * @returns {{apps: boolean, projects: boolean, appImageTypes: string[], projectImageTypes: string[]}}
 */
export default function useImageTextRecognition() {
  const { platformConfig } = usePlatformConfig() || {};
  const { config } = useProjectsConfig();
  const apps = textRecognitionAvailable(platformConfig?.uploads);
  const projects = config?.textRecognition?.enabled === true;
  const appTypes = platformConfig?.uploads?.textRecognition?.imageTypes;
  const projectTypes = config?.textRecognition?.imageTypes;
  return useMemo(
    () => ({
      apps,
      projects,
      appImageTypes: recognizableImageTypes({ imageTypes: appTypes }),
      projectImageTypes: recognizableImageTypes({ imageTypes: projectTypes })
    }),
    [apps, projects, appTypes, projectTypes]
  );
}
