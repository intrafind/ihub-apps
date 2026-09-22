import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
// Import the i18n instance before rendering the app
import './i18n/i18n';
import { exposeCacheForDebugging } from './utils/cache';

// Dev builds put the API cache on `window.appCache` for devtools inspection.
if (import.meta.env.DEV) {
  exposeCacheForDebugging();
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
