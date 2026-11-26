// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * What a message bubble, a source card or the page may do with the workspace
 * pane of a chat. Provided by the chat pages (the owner's chat, a shared chat,
 * the Outlook Files view) through `ArtifactViewerHost`; outside them there is
 * no pane and `useArtifactViewer()` returns null, so cards stay plain.
 *
 * - `openArtifact(descriptor)` — the descriptor is what a card carries:
 *   `{ id, name?, kind?, mimeType, bytes?, data? }`. A live-turn file carries its
 *   bytes inline as base64 `data`; a stored one is fetched by id.
 * - `openFile(id)` — an uploaded file of the chat.
 * - `openFiles(tab?)` — the Files index.
 * - `openSource(source, { passages, initialPassageIndex }?)` — a cited source,
 *   read-only. Returns false where the pane cannot show sources (the sheet
 *   fallback), so the caller opens `DocumentPreviewModal` instead.
 * - `sourcesInPane` — whether `openSource` works here.
 * - `activeId` — the id of the item open in the pane, for a card's active state.
 * - `shareArtifact(descriptor)` — the share dialog for one stored artifact; only
 *   present when the chat can be shared.
 * - `openArtifactInApp(descriptor)` — "Use in app…": the app picker for one
 *   stored artifact; only present where another app's chat can be opened.
 * - `copyArtifactToProject(descriptor)` — "Copy to project…" for one stored
 *   artifact; only present where user projects are on. The card still checks
 *   `canCopyArtifactToProject` (no pictures, unless projects recognize their text).
 * - `imageTextRecognition` — `{ apps, projects }` (`useImageTextRecognition`):
 *   whether a picture may be used in an app or copied to a project because the
 *   server recognizes its text (#3986). Absent: neither.
 *
 * @type {import('react').Context<Object|null>}
 */
const ArtifactViewerContext = createContext(null);

export default ArtifactViewerContext;

/**
 * @returns {{ openArtifact: Function, openFile?: Function, openFiles?: Function,
 *   openSource?: Function, sourcesInPane?: boolean, activeId?: string|null,
 *   shareArtifact?: Function|null, openArtifactInApp?: Function|null,
 *   copyArtifactToProject?: Function|null,
 *   imageTextRecognition?: {apps: boolean, projects: boolean} }|null}
 */
export function useArtifactViewer() {
  return useContext(ArtifactViewerContext);
}
