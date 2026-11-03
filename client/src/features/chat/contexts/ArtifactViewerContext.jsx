// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * What a message bubble or the Files drawer may do with an artifact: open it
 * in the immersive viewer. Provided by the chat pages (the owner's chat and a
 * shared chat) through `ArtifactViewerHost`; outside them there is no viewer
 * and `useArtifactViewer()` returns null, so cards stay plain.
 *
 * `openArtifact(descriptor, siblings?)` — the descriptor is what a card carries:
 * `{ id, name?, kind?, mimeType, bytes?, data? }`. A live-turn file carries its
 * bytes inline as base64 `data`; a stored one is fetched by id. `siblings` is
 * the list the viewer steps through; by default the artifacts of the chat.
 *
 * @type {import('react').Context<{ openArtifact: (artifact: Object, siblings?: Object[]) => void }|null>}
 */
const ArtifactViewerContext = createContext(null);

export default ArtifactViewerContext;

/**
 * @returns {{ openArtifact: (artifact: Object, siblings?: Object[]) => void }|null}
 */
export function useArtifactViewer() {
  return useContext(ArtifactViewerContext);
}
