import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import AppProviders from './components/AppProviders';
import { withErrorBoundary } from './components/ErrorBoundary';
import useSessionManagement from './utils/useSessionManagement';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeDirectChat = withErrorBoundary(DirectChat);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);

function App() {
  // Use the custom hook for session management
  useSessionManagement();

  return (
    <AppProviders>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<SafeAppsList />} />
            <Route path="apps/:appId" element={<SafeAppChat />} />
            <Route path="chat/:modelId" element={<SafeDirectChat />} />
            <Route path="page/:pageId" element={<SafeMarkdownPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;