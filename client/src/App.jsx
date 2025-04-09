import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import { HeaderColorProvider } from './components/HeaderColorContext';
import ErrorBoundaryFallback, { withErrorBoundary } from './components/ErrorBoundary';
// Import i18n configuration
import './i18n/i18n';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeDirectChat = withErrorBoundary(DirectChat);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);

function App() {
  return (
    <ErrorBoundaryFallback>
      <HeaderColorProvider>
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
      </HeaderColorProvider>
    </ErrorBoundaryFallback>
  );
}

export default App;