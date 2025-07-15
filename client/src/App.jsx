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
import MarkdownPage from './pages/MarkdownPage';
import WidgetPage from './pages/WidgetPage';
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
import AppProviders from './features/apps/components/AppProviders';
import { withErrorBoundary } from './shared/components/ErrorBoundary';
import useSessionManagement from './shared/hooks/useSessionManagement';
import { useUIConfig } from './shared/contexts/UIConfigContext';
import { usePlatformConfig } from './shared/contexts/PlatformConfigContext';
import DocumentTitle from './shared/components/DocumentTitle';
import { AdminAuthProvider } from './features/admin/hooks/useAdminAuth';
import { configureMarked } from './shared/components/MarkdownRenderer';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeAppCanvas = withErrorBoundary(AppCanvas);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);
const SafeWidgetPage = withErrorBoundary(WidgetPage);
const SafeAdminHome = withErrorBoundary(AdminHome);
const SafeAdminUsage = withErrorBoundary(AdminUsageReports);
const SafeAdminSystem = withErrorBoundary(AdminSystemPage);
const SafeAdminApps = withErrorBoundary(AdminAppsPage);
const SafeAdminAppEdit = withErrorBoundary(AdminAppEditPage);
const SafeAdminShortLinks = withErrorBoundary(AdminShortLinks);
const SafeAdminShortLinkEdit = withErrorBoundary(AdminShortLinkEditPage);
const SafeAdminModels = withErrorBoundary(AdminModelsPage);
const SafeAdminModelEdit = withErrorBoundary(AdminModelEditPage);
const SafeAdminPrompts = withErrorBoundary(AdminPromptsPage);
const SafeAdminPromptEdit = withErrorBoundary(AdminPromptEditPage);
const SafePromptsList = withErrorBoundary(PromptsList);

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();
  const { platformConfig } = usePlatformConfig();
  const adminPages = platformConfig?.admin?.pages || {};
  const showAdminPage = key => adminPages[key] !== false;

  React.useEffect(() => {
    configureMarked();
  }, []);

  return (
    <AppProviders>
      <AdminAuthProvider>
        <BrowserRouter>
          {/* Document title management - must be inside Router for useLocation/useParams */}
          <DocumentTitle />

          <Routes>
            {/* Widget page should be outside of the regular Layout */}
            <Route path="/widget/chat" element={<SafeWidgetPage />} />

            {/* Regular application routes */}
            <Route path="/" element={<Layout />}>
              <Route index element={<SafeAppsList />} />
              {uiConfig?.promptsList?.enabled !== false && (
                <Route path="prompts" element={<SafePromptsList />} />
              )}
              <Route path="apps/:appId" element={<SafeAppChat />} />
              <Route path="apps/:appId/canvas" element={<SafeAppCanvas />} />
              <Route path="pages/:pageId" element={<SafeMarkdownPage />} />
              {showAdminPage('home') && <Route path="admin" element={<SafeAdminHome />} />}
              {showAdminPage('usage') && <Route path="admin/usage" element={<SafeAdminUsage />} />}
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
              {showAdminPage('prompts') && (
                <Route path="admin/prompts" element={<SafeAdminPrompts />} />
              )}
              {showAdminPage('prompts') && (
                <Route path="admin/prompts/:promptId" element={<SafeAdminPromptEdit />} />
              )}
              <Route path="unauthorized" element={<Unauthorized />} />
              <Route path="forbidden" element={<Forbidden />} />
              <Route path="server-error" element={<ServerError />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AdminAuthProvider>
    </AppProviders>
  );
}
export default App;
