// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, useContext } from 'react';

/**
 * The auth context object, on its own so that a component which only needs to
 * know whether someone is signed in can read it without importing the
 * provider — and with it the API client — into its module graph.
 * `AuthContext.jsx` provides it.
 */
export const AuthContext = createContext();

/**
 * The auth context, or null outside an `AuthProvider` — for components that
 * are also rendered where no provider is mounted and only need to know
 * whether someone is signed in.
 *
 * @returns {Object|null}
 */
export function useOptionalAuth() {
  return useContext(AuthContext) || null;
}

/**
 * Who is viewing, for data that differs per user (the integrations picker,
 * the user's defaults): `null` while authentication is still resolving, a new
 * value when the viewer signs in or out, and `''` outside an `AuthProvider`
 * (an embedded host or a test), where there is only one viewer.
 *
 * @returns {string|null}
 */
export function useViewerKey() {
  const auth = useOptionalAuth();
  if (!auth) return '';
  if (auth.isLoading) return null;
  return `${auth.isAuthenticated ? 'auth' : 'anon'}:${auth.user?.id ?? ''}`;
}
