// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * What `WorkspaceLayout` needs from the host to place the pane next to the
 * chat: the pane element (only while it is docked or full screen in a split),
 * whether it is open and full screen, and a way to report the row's width
 * (the pane's limits depend on it).
 *
 * @type {import('react').Context<{
 *   pane: import('react').ReactNode,
 *   split: boolean,
 *   full: boolean,
 *   setContainerWidth: (width: number) => void
 * }|null>}
 */
const WorkspaceLayoutContext = createContext(null);

export default WorkspaceLayoutContext;

export function useWorkspaceLayout() {
  return useContext(WorkspaceLayoutContext);
}
