import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import MarkdownPage from './pages/MarkdownPage';
import { HeaderColorProvider } from './components/HeaderColorContext';
import './App.css';

function App() {
  return (
    <HeaderColorProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<AppsList />} />
            <Route path="apps/:appId" element={<AppChat />} />
            <Route path="models/:modelId" element={<DirectChat />} />
            {/* Dynamic route for markdown pages defined in ui.json */}
            <Route path="page/:pageId" element={<MarkdownPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Router>
    </HeaderColorProvider>
  );
}

export default App;