import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import AppsList from './pages/AppsList';
import AppChat from './pages/AppChat';
import DirectChat from './pages/DirectChat';
import NotFound from './pages/NotFound';
import './App.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<AppsList />} />
          <Route path="apps/:appId" element={<AppChat />} />
          <Route path="models/:modelId" element={<DirectChat />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App; 