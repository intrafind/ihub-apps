import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import PromptsList from './pages/PromptsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import WidgetPage from './pages/WidgetPage';
import AdminUsageReports from './pages/AdminUsageReports';
import AppProviders from './components/AppProviders';
import { withErrorBoundary } from './components/ErrorBoundary';
import useSessionManagement from './utils/useSessionManagement';
import { useUIConfig } from './components/UIConfigContext';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeDirectChat = withErrorBoundary(DirectChat);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);
const SafeWidgetPage = withErrorBoundary(WidgetPage);
const SafeAdminUsage = withErrorBoundary(AdminUsageReports);
const SafePromptsList = withErrorBoundary(PromptsList);

function App() {
  // Use the custom hook for session management
  useSessionManagement();
  const { uiConfig } = useUIConfig();

  return (
    <AppProviders>
      <BrowserRouter>
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
            <Route path="chat/:modelId" element={<SafeDirectChat />} />
            <Route path="pages/:pageId" element={<SafeMarkdownPage />} />
            <Route path="admin/usage" element={<SafeAdminUsage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;