import React, { useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import { initializeBasePath, getBasePath } from './utils/runtimeBasePath';
import Layout from './shared/components/Layout';
import AppsList from './features/apps/pages/AppsList';
import PromptsList from './features/prompts/pages/PromptsList';
import AppChat from './features/apps/pages/AppChat';
import AppCanvas from './features/canvas/pages/AppCanvas';
import NotFound from './pages/error/NotFound';
import Unauthorized from './pages/error/Unauthorized';
import Forbidden from './pages/error/Forbidden';
import ServerError from './pages/error/ServerError';
import UnifiedPage from './pages/UnifiedPage';
// Lazy load admin components
const AdminHome = React.lazy(() => import('./features/admin/pages/AdminHome'));
const AdminUsageReports = React.lazy(() => import('./features/admin/pages/AdminUsageReports'));
const AdminSystemPage = React.lazy(() => import('./features/admin/pages/AdminSystemPage'));
const AdminAppsPage = React.lazy(() => import('./features/admin/pages/AdminAppsPage'));
const AdminAppEditPage = React.lazy(() => import('./features/admin/pages/AdminAppEditPage'));
const AdminShortLinks = React.lazy(() => import('./features/admin/pages/AdminShortLinks'));
const AdminShortLinkEditPage = React.lazy(
  () => import('./features/admin/pages/AdminShortLinkEditPage')
);
const AdminModelEditPage = React.lazy(() => import('./features/admin/pages/AdminModelEditPage'));
const AdminModelsPage = React.lazy(() => import('./features/admin/pages/AdminModelsPage'));
const AdminPromptsPage = React.lazy(() => import('./features/admin/pages/AdminPromptsPage'));
const AdminPromptEditPage = React.lazy(() => import('./features/admin/pages/AdminPromptEditPage'));
const AdminSourcesPage = React.lazy(() => import('./features/admin/pages/AdminSourcesPage'));
const AdminSourceEditPage = React.lazy(() => import('./features/admin/pages/AdminSourceEditPage'));
const AdminPagesPage = React.lazy(() => import('./features/admin/pages/AdminPagesPage'));
const AdminPageEditPage = React.lazy(() => import('./features/admin/pages/AdminPageEditPage'));
const AdminAuthPage = React.lazy(() => import('./features/admin/pages/AdminAuthPage'));
const AdminUsersPage = React.lazy(() => import('./features/admin/pages/AdminUsersPage'));
const AdminUserEditPage = React.lazy(() => import('./features/admin/pages/AdminUserEditPage'));
const AdminGroupsPage = React.lazy(() => import('./features/admin/pages/AdminGroupsPage'));
const AdminGroupEditPage = React.lazy(() => import('./features/admin/pages/AdminGroupEditPage'));
const AdminUICustomization = React.lazy(
  () => import('./features/admin/pages/AdminUICustomization')
);
const IntegrationsPage = React.lazy(() => import('./features/settings/pages/IntegrationsPage'));
import AppProviders from './features/apps/components/AppProviders';
import { withSafeRoute } from './shared/components/SafeRoute';
import useSessionManagement from './shared/hooks/useSessionManagement';
import { useUIConfig } from './shared/contexts/UIConfigContext';
import { usePlatformConfig } from './shared/contexts/PlatformConfigContext';
import DocumentTitle from './shared/components/DocumentTitle';
import { AdminAuthProvider } from './features/admin/hooks/useAdminAuth';
import { AuthProvider } from './shared/contexts/AuthContext';
import MarkdownRenderer from './shared/components/MarkdownRenderer';
// Lazy load Teams features (only needed in Microsoft Teams environment)
const TeamsWrapper = React.lazy(() => import('./features/teams/TeamsWrapper'));
const TeamsAuthStart = React.lazy(() => import('./features/teams/TeamsAuthStart'));
const TeamsAuthEnd = React.lazy(() => import('./features/teams/TeamsAuthEnd'));

// Create safe versions of components that need error boundaries
const SafeAppsList = withSafeRoute(AppsList);
const SafeAppChat = withSafeRoute(AppChat);
const SafeAppCanvas = withSafeRoute(AppCanvas);
const SafeUnifiedPage = withSafeRoute(UnifiedPage);
const SafePromptsList = withSafeRoute(PromptsList);

// Loading component for lazy-loaded admin components
const AdminLoading = () => (
  <div className="flex items-center justify-center p-8">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    <span className="ml-3 text-gray-600">Loading admin panel...</span>
  </div>
);

// Helper to wrap lazy admin components with suspense and error boundary
const LazyAdminRoute = ({ component: Component }) => (
  <Suspense fallback={<AdminLoading />}>
    <Component />
  </Suspense>
);

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;

  // Initialize runtime base path detection on app start
  useEffect(() => {
    initializeBasePath();
  }, []);

  // Get base path for React Router
  const basename = getBasePath();

  return (
    <AppProviders>
      <AuthProvider>
        <AdminAuthProvider>
          <Suspense
            fallback={
              <div className="flex items-center justify-center min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            }
          >
            <TeamsWrapper>
              <BrowserRouter basename={basename}>
                {/* Global markdown renderer for Mermaid diagrams and other markdown features */}
                <MarkdownRenderer />
                {/* Document title management - must be inside Router for useLocation/useParams */}
                <DocumentTitle />

                <Routes>
                  {/* Teams authentication routes */}
                  <Route
                    path="/teams/auth-start"
                    element={
                      <Suspense fallback={<AdminLoading />}>
                        <TeamsAuthStart />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/teams/auth-end"
                    element={
                      <Suspense fallback={<AdminLoading />}>
                        <TeamsAuthEnd />
                      </Suspense>
                    }
                  />
                  <Route path="/teams/tab" element={<Layout />}>
                    <Route index element={<SafeAppsList />} />
                  </Route>

                  {/* Regular application routes */}
                  <Route path="/" element={<Layout />}>
                    <Route index element={<SafeAppsList />} />
                    {uiConfig?.promptsList?.enabled !== false && (
                      <Route path="prompts" element={<SafePromptsList />} />
                    )}
                    <Route path="apps/:appId" element={<SafeAppChat />} />
                    <Route path="apps/:appId/canvas" element={<SafeAppCanvas />} />
                    <Route path="pages/:pageId" element={<SafeUnifiedPage />} />
                    {showAdminPage('home') && (
                      <Route path="admin" element={<LazyAdminRoute component={AdminHome} />} />
                    )}
                    {showAdminPage('usage') && (
                      <Route
                        path="admin/usage"
                        element={<LazyAdminRoute component={AdminUsageReports} />}
                      />
                    )}
                    {showAdminPage('system') && (
                      <Route
                        path="admin/system"
                        element={<LazyAdminRoute component={AdminSystemPage} />}
                      />
                    )}
                    {showAdminPage('apps') && (
                      <Route
                        path="admin/apps"
                        element={<LazyAdminRoute component={AdminAppsPage} />}
                      />
                    )}
                    {showAdminPage('apps') && (
                      <Route
                        path="admin/apps/:appId"
                        element={<LazyAdminRoute component={AdminAppEditPage} />}
                      />
                    )}
                    {showAdminPage('shortlinks') && (
                      <Route
                        path="admin/shortlinks"
                        element={<LazyAdminRoute component={AdminShortLinks} />}
                      />
                    )}
                    {showAdminPage('shortlinks') && (
                      <Route
                        path="admin/shortlinks/:code"
                        element={<LazyAdminRoute component={AdminShortLinkEditPage} />}
                      />
                    )}
                    {showAdminPage('models') && (
                      <Route
                        path="admin/models"
                        element={<LazyAdminRoute component={AdminModelsPage} />}
                      />
                    )}
                    {showAdminPage('models') && (
                      <Route
                        path="admin/models/:modelId"
                        element={<LazyAdminRoute component={AdminModelEditPage} />}
                      />
                    )}
                    {showAdminPage('pages') && (
                      <Route
                        path="admin/pages"
                        element={<LazyAdminRoute component={AdminPagesPage} />}
                      />
                    )}
                    {showAdminPage('pages') && (
                      <Route
                        path="admin/pages/:pageId"
                        element={<LazyAdminRoute component={AdminPageEditPage} />}
                      />
                    )}
                    {showAdminPage('prompts') && (
                      <Route
                        path="admin/prompts"
                        element={<LazyAdminRoute component={AdminPromptsPage} />}
                      />
                    )}
                    {showAdminPage('prompts') && (
                      <Route
                        path="admin/prompts/:promptId"
                        element={<LazyAdminRoute component={AdminPromptEditPage} />}
                      />
                    )}
                    {showAdminPage('sources') && (
                      <Route
                        path="admin/sources"
                        element={<LazyAdminRoute component={AdminSourcesPage} />}
                      />
                    )}
                    {showAdminPage('sources') && (
                      <Route
                        path="admin/sources/:id"
                        element={<LazyAdminRoute component={AdminSourceEditPage} />}
                      />
                    )}
                    {showAdminPage('auth') && (
                      <Route
                        path="admin/auth"
                        element={<LazyAdminRoute component={AdminAuthPage} />}
                      />
                    )}
                    {showAdminPage('users') && (
                      <Route
                        path="admin/users"
                        element={<LazyAdminRoute component={AdminUsersPage} />}
                      />
                    )}
                    {showAdminPage('users') && (
                      <Route
                        path="admin/users/:userId"
                        element={<LazyAdminRoute component={AdminUserEditPage} />}
                      />
                    )}
                    {showAdminPage('groups') && (
                      <Route
                        path="admin/groups"
                        element={<LazyAdminRoute component={AdminGroupsPage} />}
                      />
                    )}
                    {showAdminPage('groups') && (
                      <Route
                        path="admin/groups/:groupId"
                        element={<LazyAdminRoute component={AdminGroupEditPage} />}
                      />
                    )}
                    {showAdminPage('ui') && (
                      <Route
                        path="admin/ui"
                        element={<LazyAdminRoute component={AdminUICustomization} />}
                      />
                    )}
                    <Route
                      path="settings/integrations"
                      element={<LazyAdminRoute component={IntegrationsPage} />}
                    />
                    <Route path="unauthorized" element={<Unauthorized />} />
                    <Route path="forbidden" element={<Forbidden />} />
                    <Route path="server-error" element={<ServerError />} />
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </TeamsWrapper>
          </Suspense>
        </AdminAuthProvider>
      </AuthProvider>
    </AppProviders>
  );
}
export default App;
