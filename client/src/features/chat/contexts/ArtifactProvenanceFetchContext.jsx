// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * Where a rendered message asks what the provider embedded in a stored image.
 *
 * Like `ArtifactFetchContext` for the bytes: the owner's chat route by default
 * (`null`), and a shared chat provides the share's route, because its viewer is
 * not the owner.
 *
 * @type {React.Context<((chatId: string, artifactId: string) => Promise<Object>)|null>}
 */
export const ArtifactProvenanceFetchContext = createContext(null);

/**
 * The provenance fetcher the nearest provider supplied, or null for the default.
 *
 * @returns {((chatId: string, artifactId: string) => Promise<Object>)|null}
 */
export function useArtifactProvenanceFetcher() {
  return useContext(ArtifactProvenanceFetchContext);
}

export default ArtifactProvenanceFetchContext;
