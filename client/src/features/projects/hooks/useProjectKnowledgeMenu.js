// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useProjectsAvailability } from './useProjects';
import { chatKnowledgeModes } from '../utils/knowledgeModes';

/**
 * What the chat's "+" menu needs to offer the knowledge mode of the chat
 * (#3538), or `null` when there is nothing to choose: user projects are off,
 * the chat has no project, it takes no mode (`projectContext.knowledgeMode`
 * absent), or the platform allows fewer than two of the modes a chat may pick
 * (`auto` is always allowed, so one means no choice).
 *
 * @param {Object|null} projectContext - The chat's `projectContext`.
 * @returns {{value: string, modes: string[], onChange: (mode: string) => void,
 *   disabled: boolean, projectCount: number}|null}
 */
export function useProjectKnowledgeMenu(projectContext) {
  const { userProjectsEnabled, knowledgeModes } = useProjectsAvailability();
  const {
    containerProjectId = null,
    value = [],
    disabled = false,
    knowledgeMode
  } = projectContext || {};
  const projectCount = (containerProjectId ? 1 : 0) + value.length;
  if (!userProjectsEnabled || !knowledgeMode || projectCount === 0) return null;
  const current = knowledgeMode.value || '';
  const modes = chatKnowledgeModes(knowledgeModes, current);
  if (modes.length < 2) return null;
  return {
    value: current,
    modes,
    onChange: knowledgeMode.set,
    disabled: Boolean(disabled || knowledgeMode.saving),
    projectCount
  };
}

export default useProjectKnowledgeMenu;
