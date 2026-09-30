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
