import { useAdminAuth } from '../hooks/useAdminAuth';
import { useAuth } from '../../../shared/contexts/AuthContext';
import Icon from '../../../shared/components/Icon';
import { buildPath } from '../../../utils/runtimeBasePath';

const AdminAuth = ({ children }) => {
  const { isAuthenticated, authRequired, isLoading } = useAdminAuth();
  const { isAuthenticated: userIsAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Checking authentication...</p>
        </div>
      </div>
    );
  }

  // If authentication is not required, or user is authenticated, show children
  if (!authRequired || isAuthenticated) {
    return <div>{children}</div>;
  }

  // Show access denied message
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-red-100">
            <Icon name="shield-exclamation" className="h-6 w-6 text-red-600" />
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Admin Access Required
          </h2>
          <div className="mt-2 text-center text-sm text-gray-600">
            <p>Admin access requires authentication with admin privileges.</p>
            {userIsAuthenticated ? (
              <p className="mt-1 text-red-600">
                Your account does not have admin access. Contact your administrator.
              </p>
            ) : (
              <p className="mt-1 text-blue-600">
                Please log in with an admin account to access the admin panel.
              </p>
            )}
          </div>
        </div>

        {/* Show return/login link */}
        {!userIsAuthenticated && (
          <div className="mt-6 text-center">
            <a href={buildPath('/')} className="text-indigo-600 hover:text-indigo-500 font-medium">
              ← Return to login
            </a>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminAuth;
