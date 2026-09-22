import { useAuth } from '../contexts/AuthContext';

/**
 * Identity of the current viewer for permission-scoped data (apps, models).
 * Returns `null` while authentication is still resolving so callers can wait
 * for one authenticated request instead of an anonymous one followed by a
 * refetch, and a new key whenever the viewer signs in or out so cached,
 * permission-filtered lists are reloaded for the new identity.
 */
export default function useAuthKey() {
  const { user, isAuthenticated, isLoading } = useAuth();
  return isLoading ? null : `${isAuthenticated ? 'auth' : 'anon'}:${user?.id ?? ''}`;
}
