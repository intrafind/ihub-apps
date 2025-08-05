import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
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
import AdminHome from './features/admin/pages/AdminHome';
import AdminUsageReports from './features/admin/pages/AdminUsageReports';
import AdminSystemPage from './features/admin/pages/AdminSystemPage';
import AdminAppsPage from './features/admin/pages/AdminAppsPage';
import AdminAppEditPage from './features/admin/pages/AdminAppEditPage';
import AdminShortLinks from './features/admin/pages/AdminShortLinks';
import AdminShortLinkEditPage from './features/admin/pages/AdminShortLinkEditPage';
import AdminModelEditPage from './features/admin/pages/AdminModelEditPage';
import AdminModelsPage from './features/admin/pages/AdminModelsPage';
import AdminPromptsPage from './features/admin/pages/AdminPromptsPage';
import AdminPromptEditPage from './features/admin/pages/AdminPromptEditPage';
import AdminSourcesPage from './features/admin/pages/AdminSourcesPage';
import AdminSourceEditPage from './features/admin/pages/AdminSourceEditPage';
import AdminPagesPage from './features/admin/pages/AdminPagesPage';
import AdminPageEditPage from './features/admin/pages/AdminPageEditPage';
import AdminAuthPage from './features/admin/pages/AdminAuthPage';
import AdminUsersPage from './features/admin/pages/AdminUsersPage';
import AdminUserEditPage from './features/admin/pages/AdminUserEditPage';
import AdminGroupsPage from './features/admin/pages/AdminGroupsPage';
import AdminGroupEditPage from './features/admin/pages/AdminGroupEditPage';
import AdminUICustomization from './features/admin/pages/AdminUICustomization';
import AppProviders from './features/apps/components/AppProviders';
import { withSafeRoute } from './shared/components/SafeRoute';
import useSessionManagement from './shared/hooks/useSessionManagement';
import { useUIConfig } from './shared/contexts/UIConfigContext';
import { usePlatformConfig } from './shared/contexts/PlatformConfigContext';
import DocumentTitle from './shared/components/DocumentTitle';
import { AdminAuthProvider } from './features/admin/hooks/useAdminAuth';
import { AuthProvider } from './shared/contexts/AuthContext';
import MarkdownRenderer from './shared/components/MarkdownRenderer';
import TeamsWrapper from './features/teams/TeamsWrapper';
import TeamsAuthStart from './features/teams/TeamsAuthStart';
import TeamsAuthEnd from './features/teams/TeamsAuthEnd';

// Create safe versions of components that need error boundaries
const SafeAppsList = withSafeRoute(AppsList);
const SafeAppChat = withSafeRoute(AppChat);
const SafeAppCanvas = withSafeRoute(AppCanvas);
const SafeUnifiedPage = withSafeRoute(UnifiedPage);
const SafeAdminHome = withSafeRoute(AdminHome);
const SafeAdminUsage = withSafeRoute(AdminUsageReports);
const SafeAdminSystem = withSafeRoute(AdminSystemPage);
const SafeAdminApps = withSafeRoute(AdminAppsPage);
const SafeAdminAppEdit = withSafeRoute(AdminAppEditPage);
const SafeAdminShortLinks = withSafeRoute(AdminShortLinks);
const SafeAdminShortLinkEdit = withSafeRoute(AdminShortLinkEditPage);
const SafeAdminModels = withSafeRoute(AdminModelsPage);
const SafeAdminModelEdit = withSafeRoute(AdminModelEditPage);
const SafeAdminPrompts = withSafeRoute(AdminPromptsPage);
const SafeAdminPromptEdit = withSafeRoute(AdminPromptEditPage);
const SafeAdminSources = withSafeRoute(AdminSourcesPage);
const SafeAdminSourceEdit = withSafeRoute(AdminSourceEditPage);
const SafeAdminPages = withSafeRoute(AdminPagesPage);
const SafeAdminPageEdit = withSafeRoute(AdminPageEditPage);
const SafeAdminAuth = withSafeRoute(AdminAuthPage);
const SafeAdminUsers = withSafeRoute(AdminUsersPage);
const SafeAdminUserEdit = withSafeRoute(AdminUserEditPage);
const SafeAdminGroups = withSafeRoute(AdminGroupsPage);
const SafeAdminGroupEdit = withSafeRoute(AdminGroupEditPage);
const SafeAdminUICustomization = withSafeRoute(AdminUICustomization);
const SafePromptsList = withSafeRoute(PromptsList);

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;

  return (
    <AppProviders>
      <AuthProvider>
        <AdminAuthProvider>
          <TeamsWrapper>
            <BrowserRouter>
              {/* Global markdown renderer for Mermaid diagrams and other markdown features */}
              <MarkdownRenderer />
              {/* Document title management - must be inside Router for useLocation/useParams */}
              <DocumentTitle />

              <Routes>
                {/* Teams authentication routes */}
                <Route path="/teams/auth-start" element={<TeamsAuthStart />} />
                <Route path="/teams/auth-end" element={<TeamsAuthEnd />} />
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
                  {showAdminPage('home') && <Route path="admin" element={<SafeAdminHome />} />}
                  {showAdminPage('usage') && (
                    <Route path="admin/usage" element={<SafeAdminUsage />} />
                  )}
                  {showAdminPage('system') && (
                    <Route path="admin/system" element={<SafeAdminSystem />} />
                  )}
                  {showAdminPage('apps') && <Route path="admin/apps" element={<SafeAdminApps />} />}
                  {showAdminPage('apps') && (
                    <Route path="admin/apps/:appId" element={<SafeAdminAppEdit />} />
                  )}
                  {showAdminPage('shortlinks') && (
                    <Route path="admin/shortlinks" element={<SafeAdminShortLinks />} />
                  )}
                  {showAdminPage('shortlinks') && (
                    <Route path="admin/shortlinks/:code" element={<SafeAdminShortLinkEdit />} />
                  )}
                  {showAdminPage('models') && (
                    <Route path="admin/models" element={<SafeAdminModels />} />
                  )}
                  {showAdminPage('models') && (
                    <Route path="admin/models/:modelId" element={<SafeAdminModelEdit />} />
                  )}
                  {showAdminPage('pages') && (
                    <Route path="admin/pages" element={<SafeAdminPages />} />
                  )}
                  {showAdminPage('pages') && (
                    <Route path="admin/pages/:pageId" element={<SafeAdminPageEdit />} />
                  )}
                  {showAdminPage('prompts') && (
                    <Route path="admin/prompts" element={<SafeAdminPrompts />} />
                  )}
                  {showAdminPage('prompts') && (
                    <Route path="admin/prompts/:promptId" element={<SafeAdminPromptEdit />} />
                  )}
                  {showAdminPage('sources') && (
                    <Route path="admin/sources" element={<SafeAdminSources />} />
                  )}
                  {showAdminPage('sources') && (
                    <Route path="admin/sources/:id" element={<SafeAdminSourceEdit />} />
                  )}
                  {showAdminPage('auth') && <Route path="admin/auth" element={<SafeAdminAuth />} />}
                  {showAdminPage('users') && (
                    <Route path="admin/users" element={<SafeAdminUsers />} />
                  )}
                  {showAdminPage('users') && (
                    <Route path="admin/users/new" element={<SafeAdminUserEdit />} />
                  )}
                  {showAdminPage('users') && (
                    <Route path="admin/users/:userId/edit" element={<SafeAdminUserEdit />} />
                  )}
                  {showAdminPage('groups') && (
                    <Route path="admin/groups" element={<SafeAdminGroups />} />
                  )}
                  {showAdminPage('groups') && (
                    <Route path="admin/groups/:groupId" element={<SafeAdminGroupEdit />} />
                  )}
                  {showAdminPage('ui') && (
                    <Route path="admin/ui" element={<SafeAdminUICustomization />} />
                  )}
                  <Route path="unauthorized" element={<Unauthorized />} />
                  <Route path="forbidden" element={<Forbidden />} />
                  <Route path="server-error" element={<ServerError />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </TeamsWrapper>
        </AdminAuthProvider>
      </AuthProvider>
    </AppProviders>
  );
}
export default App;
