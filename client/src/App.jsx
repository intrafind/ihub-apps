import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import PromptsList from './pages/PromptsList';
import AppChat from './pages/AppChat';
import AppCanvas from './pages/AppCanvas';
import NotFound from './pages/NotFound';
import Unauthorized from './pages/Unauthorized';
import Forbidden from './pages/Forbidden';
import ServerError from './pages/ServerError';
import MarkdownPage from './pages/MarkdownPage';
import WidgetPage from './pages/WidgetPage';
import AdminHome from './pages/admin/AdminHome';
import AdminUsageReports from './pages/admin/AdminUsageReports';
import AdminSystemPage from './pages/admin/AdminSystemPage';
import AdminAppsPage from './pages/admin/AdminAppsPage';
import AdminAppEditPage from './pages/admin/AdminAppEditPage';
import AdminShortLinks from './pages/admin/AdminShortLinks';
import AdminShortLinkEditPage from './pages/admin/AdminShortLinkEditPage';
import AdminModelEditPage from './pages/admin/AdminModelEditPage';
import AdminModelsPage from './pages/admin/AdminModelsPage';
import AdminPromptsPage from './pages/admin/AdminPromptsPage';
import AdminPromptEditPage from './pages/admin/AdminPromptEditPage';
import AppProviders from './components/AppProviders';
import { withErrorBoundary } from './components/ErrorBoundary';
import useSessionManagement from './hooks/useSessionManagement';
import { useUIConfig } from './components/UIConfigContext';
import { usePlatformConfig } from './components/PlatformConfigContext';
import DocumentTitle from './components/DocumentTitle';
import { AdminAuthProvider } from './hooks/useAdminAuth';
import { configureMarked } from './components/MarkdownRenderer';

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
  const showAdminPage = (key) => adminPages[key] !== false;

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
              {showAdminPage('home') && (
                <Route path="admin" element={<SafeAdminHome />} />
              )}
              {showAdminPage('usage') && (
                <Route path="admin/usage" element={<SafeAdminUsage />} />
              )}
              {showAdminPage('system') && (
                <Route path="admin/system" element={<SafeAdminSystem />} />
              )}
              {showAdminPage('apps') && (
                <Route path="admin/apps" element={<SafeAdminApps />} />
              )}
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
}export default App;