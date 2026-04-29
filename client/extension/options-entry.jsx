/* global chrome */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import './extension.css';
import { getExtensionRedirectUri } from '../src/features/extension/extensionHost';

/**
 * Browser-extension options page. Two modes:
 *
 *   - Packaged (the iHub admin "Download Extension" flow rewrote
 *     runtime-config.js): show the locked-in iHub URL and a sign-out
 *     button. The user can't change the URL — they reinstall a
 *     different download instead.
 *   - Unpacked (developer side-loaded the source): show an editor for
 *     the iHub base URL plus a redirect-URI diagnostic that admins
 *     need when registering the extension's OAuth client.
 */
function OptionsApp() {
  const baked = globalThis.IHUB_RUNTIME_CONFIG;
  const isPackaged = Boolean(baked?.baseUrl);

  const [url, setUrl] = React.useState('');
  const [status, setStatus] = React.useState({ text: '', kind: 'info' });
  const [signedIn, setSignedIn] = React.useState(false);

  const redirectUri = React.useMemo(() => {
    try {
      return getExtensionRedirectUri();
    } catch {
      return '(chrome.identity unavailable)';
    }
  }, []);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const stored = await chrome.storage.local.get(['ihub_base_url', 'ihub_refresh_token']);
      if (!active) return;
      if (!isPackaged && stored.ihub_base_url) setUrl(stored.ihub_base_url);
      const access = await chrome.storage.session.get('ihub_access_token');
      if (!active) return;
      setSignedIn(Boolean(access.ihub_access_token || stored.ihub_refresh_token));
    })();
    return () => {
      active = false;
    };
  }, [isPackaged]);

  const onSave = async () => {
    const value = url.trim();
    if (!value || !/^https?:\/\//i.test(value)) {
      setStatus({ text: 'Base URL must start with http(s)://', kind: 'error' });
      return;
    }
    await chrome.storage.local.set({ ihub_base_url: value });
    await chrome.storage.local.remove('ihub_runtime_config');
    setStatus({ text: 'Saved.', kind: 'success' });
  };

  const onSignOut = async () => {
    await chrome.storage.session.remove('ihub_access_token');
    await chrome.storage.local.remove('ihub_refresh_token');
    setSignedIn(false);
    setStatus({ text: 'Signed out.', kind: 'success' });
  };

  return (
    <main
      style={{
        maxWidth: 480,
        margin: '0 auto',
        padding: 24,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        color: '#111827',
        lineHeight: 1.45
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>iHub Apps</h1>

      {isPackaged ? (
        <section style={{ marginTop: 16 }}>
          <p style={{ margin: '8px 0' }}>
            This extension is configured for: <code>{baked.baseUrl}</code>
          </p>
          <p style={{ margin: '8px 0', fontSize: 12, color: '#6b7280' }}>
            The iHub base URL was baked into this packaged build by your administrator. To switch
            instances, install a different download.
          </p>
        </section>
      ) : (
        <section style={{ marginTop: 16 }}>
          <p style={{ margin: '8px 0', fontSize: 13, color: '#4b5563' }}>
            Connect this extension to your iHub instance. Your administrator must enable the browser
            extension integration first.
          </p>
          <label htmlFor="base-url" style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>
            iHub base URL
          </label>
          <input
            id="base-url"
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://ihub.example.com"
            autoComplete="url"
            style={{
              width: '100%',
              padding: '8px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              font: 'inherit',
              marginTop: 4
            }}
          />
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            Use the same URL you visit in the browser, including any subpath.
          </p>
          <button
            type="button"
            onClick={onSave}
            style={{
              marginTop: 12,
              border: '1px solid #2563eb',
              background: '#2563eb',
              color: '#ffffff',
              borderRadius: 6,
              padding: '6px 12px',
              cursor: 'pointer',
              font: 'inherit'
            }}
          >
            Save
          </button>
        </section>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onSignOut}
          disabled={!signedIn}
          style={{
            border: '1px solid transparent',
            background: 'transparent',
            color: signedIn ? '#4b5563' : '#9ca3af',
            borderRadius: 6,
            padding: '6px 12px',
            cursor: signedIn ? 'pointer' : 'not-allowed',
            font: 'inherit'
          }}
        >
          Sign out
        </button>
      </div>

      {status.text && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 6,
            fontSize: 12,
            background:
              status.kind === 'error'
                ? '#fef2f2'
                : status.kind === 'success'
                  ? '#ecfdf5'
                  : '#f3f4f6',
            color:
              status.kind === 'error'
                ? '#dc2626'
                : status.kind === 'success'
                  ? '#047857'
                  : '#4b5563'
          }}
        >
          {status.text}
        </div>
      )}

      <details
        style={{
          marginTop: 24,
          padding: '8px 12px',
          border: '1px solid #e5e7eb',
          borderRadius: 6,
          background: '#f9fafb',
          fontSize: 12
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Diagnostics</summary>
        <p style={{ margin: '8px 0' }}>
          Redirect URI for OAuth client allowlist:
          <br />
          <code style={{ wordBreak: 'break-all', background: '#e5e7eb', padding: '1px 4px' }}>
            {redirectUri}
          </code>
        </p>
        <p style={{ margin: '8px 0', color: '#6b7280' }}>
          {signedIn ? 'You are signed in to iHub.' : 'You are not signed in yet.'}
        </p>
      </details>
    </main>
  );
}

const rootEl = document.getElementById('extension-root');
if (rootEl) createRoot(rootEl).render(<OptionsApp />);
