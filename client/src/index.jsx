// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
// Import the i18n instance before rendering the app
import { i18nService } from './i18n/i18n';
import { exposeCacheForDebugging } from './utils/cache';

// Dev builds put the API cache on `window.appCache` for devtools inspection.
if (import.meta.env.DEV) {
  exposeCacheForDebugging();
}

// The translations come from the API rather than the bundle, so hold the first
// render until they arrive (bounded by a timeout) to avoid a flash of untranslated text.
i18nService.whenReady().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
