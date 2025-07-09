import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import PromptsList from './pages/PromptsList';
import AppChat from './pages/AppChat';
import AppCanvas from './pages/AppCanvas';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import WidgetPage from './pages/WidgetPage';
import AdminUsageReports from './pages/AdminUsageReports';
import AdminSystemPage from './pages/AdminSystemPage';
import AdminAppsPage from './pages/AdminAppsPage';
import AdminAppEditPage from './pages/AdminAppEditPage';
import AdminModelEditPage from './pages/AdminModelEditPage';
import AdminModelsPage from './pages/AdminModelsPage';
import AppProviders from './components/AppProviders';
import { withErrorBoundary } from './components/ErrorBoundary';
import useSessionManagement from './hooks/useSessionManagement';
import { useUIConfig } from './components/UIConfigContext';
import DocumentTitle from './components/DocumentTitle';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeAppCanvas = withErrorBoundary(AppCanvas);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);
const SafeWidgetPage = withErrorBoundary(WidgetPage);
const SafeAdminUsage = withErrorBoundary(AdminUsageReports);
const SafeAdminSystem = withErrorBoundary(AdminSystemPage);
const SafeAdminApps = withErrorBoundary(AdminAppsPage);
const SafeAdminAppEdit = withErrorBoundary(AdminAppEditPage);
const SafeAdminModels = withErrorBoundary(AdminModelsPage);
const SafeAdminModelEdit = withErrorBoundary(AdminModelEditPage);
const SafePromptsList = withErrorBoundary(PromptsList);

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();

  return (
    <AppProviders>
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
            <Route path="admin/usage" element={<SafeAdminUsage />} />
            <Route path="admin/system" element={<SafeAdminSystem />} />
            <Route path="admin/apps" element={<SafeAdminApps />} />
            <Route path="admin/apps/:appId" element={<SafeAdminAppEdit />} />
            <Route path="admin/models" element={<SafeAdminModels />} />
            <Route path="admin/models/:modelId" element={<SafeAdminModelEdit />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;