import React, { useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import { initializeBasePath, getBasePath } from './utils/runtimeBasePath';
import Layout from './shared/components/Layout';
import AppsList from './features/apps/pages/AppsList';
import PromptsList from './features/prompts/pages/PromptsList';
import AppRouterWrapper from './features/apps/components/AppRouterWrapper';
// Lazy load workflow components
const WorkflowsPage = React.lazy(() => import('./features/workflows/pages/WorkflowsPage'));
const WorkflowExecutionPage = React.lazy(
  () => import('./features/workflows/pages/WorkflowExecutionPage')
);
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
const AdminProvidersPage = React.lazy(() => import('./features/admin/pages/AdminProvidersPage'));
const AdminProviderEditPage = React.lazy(
  () => import('./features/admin/pages/AdminProviderEditPage')
);
const AdminProviderCreatePage = React.lazy(
  () => import('./features/admin/pages/AdminProviderCreatePage')
);
const AdminPromptsPage = React.lazy(() => import('./features/admin/pages/AdminPromptsPage'));
const AdminPromptEditPage = React.lazy(() => import('./features/admin/pages/AdminPromptEditPage'));
const AdminToolsPage = React.lazy(() => import('./features/admin/pages/AdminToolsPage'));
const AdminToolEditPage = React.lazy(() => import('./features/admin/pages/AdminToolEditPage'));
const AdminSkillsPage = React.lazy(() => import('./features/admin/pages/AdminSkillsPage'));
const AdminSkillEditPage = React.lazy(() => import('./features/admin/pages/AdminSkillEditPage'));
const AdminWorkflowsPage = React.lazy(() => import('./features/admin/pages/AdminWorkflowsPage'));
const AdminWorkflowEditPage = React.lazy(
  () => import('./features/admin/pages/AdminWorkflowEditPage')
);
const AdminWorkflowExecutionsPage = React.lazy(
  () => import('./features/admin/pages/AdminWorkflowExecutionsPage')
);
const AdminSourcesPage = React.lazy(() => import('./features/admin/pages/AdminSourcesPage'));
const AdminSourceEditPage = React.lazy(() => import('./features/admin/pages/AdminSourceEditPage'));
const AdminPagesPage = React.lazy(() => import('./features/admin/pages/AdminPagesPage'));
const AdminPageEditPage = React.lazy(() => import('./features/admin/pages/AdminPageEditPage'));
const AdminAuthPage = React.lazy(() => import('./features/admin/pages/AdminAuthPage'));
const AdminOAuthClientsPage = React.lazy(
  () => import('./features/admin/pages/AdminOAuthClientsPage')
);
const AdminOAuthClientEditPage = React.lazy(
  () => import('./features/admin/pages/AdminOAuthClientEditPage')
);
const AdminUsersPage = React.lazy(() => import('./features/admin/pages/AdminUsersPage'));
const AdminUserEditPage = React.lazy(() => import('./features/admin/pages/AdminUserEditPage'));
const AdminUserViewPage = React.lazy(() => import('./features/admin/pages/AdminUserViewPage'));
const AdminGroupsPage = React.lazy(() => import('./features/admin/pages/AdminGroupsPage'));
const AdminGroupEditPage = React.lazy(() => import('./features/admin/pages/AdminGroupEditPage'));
const AdminUICustomization = React.lazy(
  () => import('./features/admin/pages/AdminUICustomization')
);
const AdminLoggingPage = React.lazy(() => import('./features/admin/pages/AdminLoggingPage'));
const AdminFeaturesPage = React.lazy(() => import('./features/admin/pages/AdminFeaturesPage'));
const AdminMarketplacePage = React.lazy(
  () => import('./features/admin/pages/AdminMarketplacePage')
);
const AdminMarketplaceRegistriesPage = React.lazy(
  () => import('./features/admin/pages/AdminMarketplaceRegistriesPage')
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
import useFeatureFlags from './shared/hooks/useFeatureFlags';
// Lazy load Teams features (only needed in Microsoft Teams environment)
const TeamsWrapper = React.lazy(() => import('./features/teams/TeamsWrapper'));
const TeamsAuthStart = React.lazy(() => import('./features/teams/TeamsAuthStart'));
const TeamsAuthEnd = React.lazy(() => import('./features/teams/TeamsAuthEnd'));

// Create safe versions of components that need error boundaries
const SafeAppsList = withSafeRoute(AppsList);
const SafeAppRouterWrapper = withSafeRoute(AppRouterWrapper);
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
  const featureFlags = useFeatureFlags();
  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;

  // Initialize runtime base path detection on app start
  useEffect(() => {
    initializeBasePath();
  }, []);

  // Prevent default drag and drop behavior globally to avoid files opening in browser
  useEffect(() => {
    const preventDefaults = e => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Prevent default behavior for drag and drop events on the window
    window.addEventListener('dragover', preventDefaults);
    window.addEventListener('drop', preventDefaults);

    return () => {
      window.removeEventListener('dragover', preventDefaults);
      window.removeEventListener('drop', preventDefaults);
    };
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
                    {uiConfig?.promptsList?.enabled !== false &&
                      featureFlags.isEnabled('promptsLibrary', true) && (
                        <Route path="prompts" element={<SafePromptsList />} />
                      )}
                    {/* Workflow routes - conditionally rendered based on feature flag */}
                    {featureFlags.isEnabled('workflows', true) && (
                      <>
                        <Route
                          path="workflows"
                          element={<LazyAdminRoute component={WorkflowsPage} />}
                        />
                        <Route
                          path="workflows/executions/:executionId"
                          element={<LazyAdminRoute component={WorkflowExecutionPage} />}
                        />
                      </>
                    )}
                    <Route path="apps/:appId" element={<SafeAppRouterWrapper />} />
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
                    {showAdminPage('logging') && (
                      <Route
                        path="admin/logging"
                        element={<LazyAdminRoute component={AdminLoggingPage} />}
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
                    {showAdminPage('providers') && (
                      <Route
                        path="admin/providers"
                        element={<LazyAdminRoute component={AdminProvidersPage} />}
                      />
                    )}
                    {showAdminPage('providers') && (
                      <Route
                        path="admin/providers/new"
                        element={<LazyAdminRoute component={AdminProviderCreatePage} />}
                      />
                    )}
                    {showAdminPage('providers') && (
                      <Route
                        path="admin/providers/:providerId"
                        element={<LazyAdminRoute component={AdminProviderEditPage} />}
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
                    {showAdminPage('tools') && (
                      <Route
                        path="admin/tools"
                        element={<LazyAdminRoute component={AdminToolsPage} />}
                      />
                    )}
                    {showAdminPage('tools') && (
                      <Route
                        path="admin/tools/:toolId"
                        element={<LazyAdminRoute component={AdminToolEditPage} />}
                      />
                    )}
                    {showAdminPage('skills') && (
                      <Route
                        path="admin/skills"
                        element={<LazyAdminRoute component={AdminSkillsPage} />}
                      />
                    )}
                    {showAdminPage('skills') && (
                      <Route
                        path="admin/skills/:skillName"
                        element={<LazyAdminRoute component={AdminSkillEditPage} />}
                      />
                    )}
                    {showAdminPage('workflows') && (
                      <Route
                        path="admin/workflows"
                        element={<LazyAdminRoute component={AdminWorkflowsPage} />}
                      />
                    )}
                    {showAdminPage('workflows') && (
                      <Route
                        path="admin/workflows/new"
                        element={<LazyAdminRoute component={AdminWorkflowEditPage} />}
                      />
                    )}
                    {showAdminPage('workflows') && (
                      <Route
                        path="admin/workflows/executions"
                        element={<LazyAdminRoute component={AdminWorkflowExecutionsPage} />}
                      />
                    )}
                    {showAdminPage('workflows') && (
                      <Route
                        path="admin/workflows/:id"
                        element={<LazyAdminRoute component={AdminWorkflowEditPage} />}
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
                    <Route
                      path="admin/oauth/clients"
                      element={<LazyAdminRoute component={AdminOAuthClientsPage} />}
                    />
                    <Route
                      path="admin/oauth/clients/:clientId"
                      element={<LazyAdminRoute component={AdminOAuthClientEditPage} />}
                    />
                    {showAdminPage('users') && (
                      <Route
                        path="admin/users"
                        element={<LazyAdminRoute component={AdminUsersPage} />}
                      />
                    )}
                    {showAdminPage('users') && (
                      <Route
                        path="admin/users/:userId/view"
                        element={<LazyAdminRoute component={AdminUserViewPage} />}
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
                    {showAdminPage('features') && (
                      <Route
                        path="admin/features"
                        element={<LazyAdminRoute component={AdminFeaturesPage} />}
                      />
                    )}
                    {featureFlags.isEnabled('marketplace', false) && (
                      <Route
                        path="admin/marketplace"
                        element={<LazyAdminRoute component={AdminMarketplacePage} />}
                      />
                    )}
                    {featureFlags.isEnabled('marketplace', false) && (
                      <Route
                        path="admin/marketplace/registries"
                        element={<LazyAdminRoute component={AdminMarketplaceRegistriesPage} />}
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
