import { useEffect, useState, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import './App.css';
import { initializeBasePath, getBasePath } from './utils/runtimeBasePath';
import lazyWithRetry from './utils/lazyWithRetry';
import Layout from './shared/components/Layout';
import AppsList from './features/apps/pages/AppsList';
import PromptsList from './features/prompts/pages/PromptsList';
import AppRouterWrapper from './features/apps/components/AppRouterWrapper';
// Lazy load workflow components
const WorkflowsPage = lazyWithRetry(() => import('./features/workflows/pages/WorkflowsPage'));
const SetupWizard = lazyWithRetry(() => import('./features/setup/SetupWizard'));
const WorkflowExecutionPage = lazyWithRetry(
  () => import('./features/workflows/pages/WorkflowExecutionPage')
);
// Lazy load canvas (pulls in react-quill/ajv — vendor-forms chunk, ~370KB)
const AppCanvas = lazyWithRetry(() => import('./features/canvas/pages/AppCanvas'));
import NotFound from './pages/error/NotFound';
import Unauthorized from './pages/error/Unauthorized';
import Forbidden from './pages/error/Forbidden';
import ServerError from './pages/error/ServerError';
import UnifiedPage from './pages/UnifiedPage';
import LoginPage from './pages/LoginPage';
// Lazy load admin components
const AdminHome = lazyWithRetry(() => import('./features/admin/pages/AdminHome'));
const AdminUsageReports = lazyWithRetry(() => import('./features/admin/pages/AdminUsageReports'));
const AdminSystemPage = lazyWithRetry(() => import('./features/admin/pages/AdminSystemPage'));
const AdminAppsPage = lazyWithRetry(() => import('./features/admin/pages/AdminAppsPage'));
const AdminAppEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminAppEditPage'));
const AdminShortLinks = lazyWithRetry(() => import('./features/admin/pages/AdminShortLinks'));
const AdminShortLinkEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminShortLinkEditPage')
);
const AdminModelEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminModelEditPage'));
const AdminModelsPage = lazyWithRetry(() => import('./features/admin/pages/AdminModelsPage'));
const AdminProvidersPage = lazyWithRetry(() => import('./features/admin/pages/AdminProvidersPage'));
const AdminProviderEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminProviderEditPage')
);
const AdminProviderCreatePage = lazyWithRetry(
  () => import('./features/admin/pages/AdminProviderCreatePage')
);
const AdminPromptsPage = lazyWithRetry(() => import('./features/admin/pages/AdminPromptsPage'));
const AdminPromptEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminPromptEditPage')
);
const AdminToolsPage = lazyWithRetry(() => import('./features/admin/pages/AdminToolsPage'));
const AdminToolEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminToolEditPage'));
const AdminSkillsPage = lazyWithRetry(() => import('./features/admin/pages/AdminSkillsPage'));
const AdminSkillEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminSkillEditPage'));
const AdminWorkflowsPage = lazyWithRetry(() => import('./features/admin/pages/AdminWorkflowsPage'));
const AdminWorkflowEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminWorkflowEditPage')
);
const AdminWorkflowExecutionsPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminWorkflowExecutionsPage')
);
const AdminSourcesPage = lazyWithRetry(() => import('./features/admin/pages/AdminSourcesPage'));
const AdminSourceEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminSourceEditPage')
);
const AdminPagesPage = lazyWithRetry(() => import('./features/admin/pages/AdminPagesPage'));
const AdminPageEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminPageEditPage'));
const AdminAuthPage = lazyWithRetry(() => import('./features/admin/pages/AdminAuthPage'));
const AdminOAuthPage = lazyWithRetry(() => import('./features/admin/pages/AdminOAuthPage'));
const AdminOAuthClientsPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminOAuthClientsPage')
);
const AdminOAuthClientEditPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminOAuthClientEditPage')
);
const AdminOAuthServerPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminOAuthServerPage')
);
const AdminUsersPage = lazyWithRetry(() => import('./features/admin/pages/AdminUsersPage'));
const AdminUserEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminUserEditPage'));
const AdminUserViewPage = lazyWithRetry(() => import('./features/admin/pages/AdminUserViewPage'));
const AdminGroupsPage = lazyWithRetry(() => import('./features/admin/pages/AdminGroupsPage'));
const AdminGroupEditPage = lazyWithRetry(() => import('./features/admin/pages/AdminGroupEditPage'));
const AdminUICustomization = lazyWithRetry(
  () => import('./features/admin/pages/AdminUICustomization')
);
const AdminLoggingPage = lazyWithRetry(() => import('./features/admin/pages/AdminLoggingPage'));
const AdminFeaturesPage = lazyWithRetry(() => import('./features/admin/pages/AdminFeaturesPage'));
const AdminOfficeIntegrationPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminOfficeIntegrationPage')
);
const AdminMarketplacePage = lazyWithRetry(
  () => import('./features/admin/pages/AdminMarketplacePage')
);
const AdminMarketplaceRegistriesPage = lazyWithRetry(
  () => import('./features/admin/pages/AdminMarketplaceRegistriesPage')
);
const IntegrationsPage = lazyWithRetry(() => import('./features/settings/pages/IntegrationsPage'));
const OcrPage = lazyWithRetry(() => import('./features/tools/pages/OcrPage'));
const JobListPage = lazyWithRetry(() => import('./features/tools/pages/JobListPage'));
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
const TeamsWrapper = lazyWithRetry(() => import('./features/teams/TeamsWrapper'));
const TeamsAuthStart = lazyWithRetry(() => import('./features/teams/TeamsAuthStart'));
const TeamsAuthEnd = lazyWithRetry(() => import('./features/teams/TeamsAuthEnd'));

// Create safe versions of components that need error boundaries
const SafeAppsList = withSafeRoute(AppsList);
const SafeAppRouterWrapper = withSafeRoute(AppRouterWrapper);
const SafeAppCanvas = withSafeRoute(AppCanvas);
const SafeUnifiedPage = withSafeRoute(UnifiedPage);
const SafePromptsList = withSafeRoute(PromptsList);

// Detect Teams environment without loading the Teams SDK (~484KB)
function useIsTeamsEnvironment() {
  const [isTeams] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return (
      params.has('loginHint') ||
      params.has('userObjectId') ||
      params.has('theme') ||
      params.has('isTeams') ||
      window.name === 'embedded' ||
      window.location.hostname === 'teams.microsoft.com'
    );
  });
  return isTeams;
}

// Loading component for lazy-loaded admin components
function AdminLoading() {
  return (
    <div className="flex items-center justify-center p-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <span className="ml-3 text-gray-600">Loading admin panel...</span>
    </div>
  );
}

// Helper to wrap lazy admin components with suspense and error boundary
function LazyAdminRoute({ component: Component }) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Component />
    </Suspense>
  );
}

/**
 * Checks setup status and redirects when unconfigured.
 * Reads the setup.configured flag from the platform config (included in /api/auth/status)
 * which is already fetched on every page load — no extra API call needed.
 *
 * When unconfigured, always redirects to /setup — the setup wizard handles
 * authentication internally as one of its steps.
 *
 * If the user explicitly skipped setup this session, the redirect is suppressed
 * until the next session/tab. The setup_configured flag is set after wizard completion
 * as a fast-path so navigation back to '/' doesn't re-trigger the redirect before the
 * refreshed platform config arrives.
 */
function SetupCheck({ children }) {
  const navigate = useNavigate();
  const { platformConfig, isLoading: platformLoading } = usePlatformConfig();
  // User deliberately chose "Skip" this session — don't redirect again until next session
  const sessionSkipped = !!sessionStorage.getItem('setup_skipped');
  // Fast-path: wizard just completed in this session
  const sessionConfigured = !!sessionStorage.getItem('setup_configured');

  // Derive setup state: null = still loading, true/false = known
  const setupConfigured =
    sessionConfigured || sessionSkipped
      ? true
      : platformLoading || !platformConfig
        ? null
        : (platformConfig.setup?.configured ?? true);

  useEffect(() => {
    if (setupConfigured === null) return;
    if (!setupConfigured) {
      navigate('/setup', { replace: true });
    }
  }, [setupConfigured, navigate]);

  if (setupConfigured === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return children;
}

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;
  const isTeams = useIsTeamsEnvironment();

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

  const loadingSpinner = (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  // Router content shared between Teams and non-Teams paths
  const routerContent = (
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

        {/* Standalone login page — rendered outside Layout (no sidebar/header) */}
        <Route path="login" element={<LoginPage />} />

        {/* First-run setup wizard — rendered outside Layout */}
        <Route
          path="setup"
          element={
            <Suspense fallback={<AdminLoading />}>
              <SetupWizard />
            </Suspense>
          }
        />

        {/* Regular application routes */}
        <Route path="/" element={<Layout />}>
          <Route
            index
            element={
              <SetupCheck>
                <SafeAppsList />
              </SetupCheck>
            }
          />
          {uiConfig?.promptsList?.enabled !== false &&
            featureFlags.isEnabled('promptsLibrary', true) && (
              <Route path="prompts" element={<SafePromptsList />} />
            )}
          {/* Workflow routes - conditionally rendered based on feature flag */}
          {featureFlags.isEnabled('workflows', true) && (
            <>
              <Route path="workflows" element={<LazyAdminRoute component={WorkflowsPage} />} />
              <Route
                path="workflows/executions/:executionId"
                element={<LazyAdminRoute component={WorkflowExecutionPage} />}
              />
            </>
          )}
          <Route path="apps/:appId" element={<SafeAppRouterWrapper />} />
          <Route
            path="apps/:appId/canvas"
            element={
              <Suspense fallback={<AdminLoading />}>
                <SafeAppCanvas />
              </Suspense>
            }
          />
          <Route path="pages/:pageId" element={<SafeUnifiedPage />} />
          {showAdminPage('home') && (
            <Route path="admin" element={<LazyAdminRoute component={AdminHome} />} />
          )}
          {showAdminPage('usage') && (
            <Route path="admin/usage" element={<LazyAdminRoute component={AdminUsageReports} />} />
          )}
          {showAdminPage('system') && (
            <Route path="admin/system" element={<LazyAdminRoute component={AdminSystemPage} />} />
          )}
          {showAdminPage('logging') && (
            <Route path="admin/logging" element={<LazyAdminRoute component={AdminLoggingPage} />} />
          )}
          {showAdminPage('apps') && (
            <Route path="admin/apps" element={<LazyAdminRoute component={AdminAppsPage} />} />
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
            <Route path="admin/models" element={<LazyAdminRoute component={AdminModelsPage} />} />
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
            <Route path="admin/pages" element={<LazyAdminRoute component={AdminPagesPage} />} />
          )}
          {showAdminPage('pages') && (
            <Route
              path="admin/pages/:pageId"
              element={<LazyAdminRoute component={AdminPageEditPage} />}
            />
          )}
          {showAdminPage('prompts') && (
            <Route path="admin/prompts" element={<LazyAdminRoute component={AdminPromptsPage} />} />
          )}
          {showAdminPage('prompts') && (
            <Route
              path="admin/prompts/:promptId"
              element={<LazyAdminRoute component={AdminPromptEditPage} />}
            />
          )}
          {showAdminPage('tools') && (
            <Route path="admin/tools" element={<LazyAdminRoute component={AdminToolsPage} />} />
          )}
          {showAdminPage('tools') && (
            <Route
              path="admin/tools/:toolId"
              element={<LazyAdminRoute component={AdminToolEditPage} />}
            />
          )}
          {showAdminPage('skills') && (
            <Route path="admin/skills" element={<LazyAdminRoute component={AdminSkillsPage} />} />
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
            <Route path="admin/sources" element={<LazyAdminRoute component={AdminSourcesPage} />} />
          )}
          {showAdminPage('sources') && (
            <Route
              path="admin/sources/:id"
              element={<LazyAdminRoute component={AdminSourceEditPage} />}
            />
          )}
          {showAdminPage('auth') && (
            <Route path="admin/auth" element={<LazyAdminRoute component={AdminAuthPage} />} />
          )}
          <Route path="admin/oauth" element={<LazyAdminRoute component={AdminOAuthPage} />} />
          <Route
            path="admin/oauth/clients"
            element={<LazyAdminRoute component={AdminOAuthClientsPage} />}
          />
          <Route
            path="admin/oauth/clients/:clientId"
            element={<LazyAdminRoute component={AdminOAuthClientEditPage} />}
          />
          <Route
            path="admin/oauth/server"
            element={<LazyAdminRoute component={AdminOAuthServerPage} />}
          />
          {showAdminPage('users') && (
            <Route path="admin/users" element={<LazyAdminRoute component={AdminUsersPage} />} />
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
            <Route path="admin/groups" element={<LazyAdminRoute component={AdminGroupsPage} />} />
          )}
          {showAdminPage('groups') && (
            <Route
              path="admin/groups/:groupId"
              element={<LazyAdminRoute component={AdminGroupEditPage} />}
            />
          )}
          {showAdminPage('ui') && (
            <Route path="admin/ui" element={<LazyAdminRoute component={AdminUICustomization} />} />
          )}
          {showAdminPage('features') && (
            <Route
              path="admin/features"
              element={<LazyAdminRoute component={AdminFeaturesPage} />}
            />
          )}
          <Route
            path="admin/office-integration"
            element={<LazyAdminRoute component={AdminOfficeIntegrationPage} />}
          />
          {featureFlags.isEnabled('marketplace', true) && (
            <Route
              path="admin/marketplace"
              element={<LazyAdminRoute component={AdminMarketplacePage} />}
            />
          )}
          {featureFlags.isEnabled('marketplace', true) && (
            <Route
              path="admin/marketplace/registries"
              element={<LazyAdminRoute component={AdminMarketplaceRegistriesPage} />}
            />
          )}
          <Route
            path="settings/integrations"
            element={<LazyAdminRoute component={IntegrationsPage} />}
          />
          {featureFlags.isEnabled('toolsService', true) && (
            <>
              <Route path="tools/ocr-ai" element={<LazyAdminRoute component={OcrPage} />} />
              <Route path="tools/jobs" element={<LazyAdminRoute component={JobListPage} />} />
            </>
          )}
          <Route path="unauthorized" element={<Unauthorized />} />
          <Route path="forbidden" element={<Forbidden />} />
          <Route path="server-error" element={<ServerError />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );

  return (
    <AppProviders>
      <AuthProvider>
        <AdminAuthProvider>
          {isTeams ? (
            <Suspense fallback={loadingSpinner}>
              <TeamsWrapper>{routerContent}</TeamsWrapper>
            </Suspense>
          ) : (
            routerContent
          )}
        </AdminAuthProvider>
      </AuthProvider>
    </AppProviders>
  );
}
export default App;
