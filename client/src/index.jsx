import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';
// Import the i18n instance before rendering the app
import './i18n/i18n';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
