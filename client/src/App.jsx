import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import { HeaderColorProvider } from './components/HeaderColorContext';
import { UIConfigProvider } from './components/UIConfigContext';
import ErrorBoundaryFallback, { withErrorBoundary } from './components/ErrorBoundary';
// Import session management
import { getSessionId, renewSession, getSessionInfo } from './utils/sessionManager';
import axios from 'axios';
// Import i18n configuration
import './i18n/i18n';

// Apply error boundary to individual routes that might fail
const SafeAppsList = withErrorBoundary(AppsList);
const SafeAppChat = withErrorBoundary(AppChat);
const SafeDirectChat = withErrorBoundary(DirectChat);
const SafeMarkdownPage = withErrorBoundary(MarkdownPage);

function App() {
  // Initialize session when app loads
  useEffect(() => {
    // Get or create a session ID
    const sessionId = getSessionId();
    
    // Log application load with session ID
    const logSessionStart = async () => {
      try {
        // Get session information for logging
        const sessionInfo = getSessionInfo();
        console.log('Application loaded with session ID:', sessionId);
        
        // Send session start to server
        await axios.post('/api/session/start', {
          type: 'app_loaded',
          sessionId,
          metadata: sessionInfo
        });
      } catch (error) {
        console.error('Failed to log session start:', error);
      }
    };
    
    logSessionStart();
    
    // Set up session renewal timer
    const renewalTimer = setInterval(() => {
      renewSession();
    }, 60 * 60 * 1000); // Check once per hour
    
    return () => {
      clearInterval(renewalTimer);
    };
  }, []);

  return (
    <ErrorBoundaryFallback>
      <UIConfigProvider>
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
      </UIConfigProvider>
    </ErrorBoundaryFallback>
  );
}

export default App;