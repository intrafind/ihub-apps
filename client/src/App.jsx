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
// Import i18n configuration
import './i18n/i18n';

function App() {
  return (
    <HeaderColorProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<AppsList />} />
            <Route path="apps/:appId" element={<AppChat />} />
            <Route path="chat/:modelId" element={<DirectChat />} />
            <Route path="page/:pageId" element={<MarkdownPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </HeaderColorProvider>
  );
}

export default App;