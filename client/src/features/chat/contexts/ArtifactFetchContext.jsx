import { createContext, useContext } from 'react';

/**
 * Where a rendered message fetches the bytes of a stored artifact from.
 *
 * The chat bubble fetches a stored image through `fetchChatArtifact(chatId,
 * artifactId)`, which is the owner's route. A shared chat renders the same
 * bubbles from the same descriptors, but its viewer is not the owner and
 * reaches the bytes through the share instead — so the page that knows which
 * route applies provides the fetcher here, and the bubble asks rather than
 * assuming. `null` means the default, owner route.
 *
 * @type {React.Context<((chatId: string, artifactId: string) => Promise<Blob>)|null>}
 */
export const ArtifactFetchContext = createContext(null);

/**
 * The artifact fetcher the nearest provider supplied, or null for the default.
 *
 * @returns {((chatId: string, artifactId: string) => Promise<Blob>)|null}
 */
export function useArtifactFetcher() {
  return useContext(ArtifactFetchContext);
}

export default ArtifactFetchContext;
