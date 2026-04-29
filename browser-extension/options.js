const $ = id => document.getElementById(id);

function send(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, resp =>
      resolve(resp || { ok: false, error: 'No response' })
    );
  });
}

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status status-' + kind;
}

async function refreshAuthState() {
  const resp = await send({ type: 'auth-status' });
  $('signed-in-state').textContent = resp?.signedIn
    ? 'You are signed in to iHub.'
    : 'You are not signed in yet.';
}

async function init() {
  // Show the redirect URI we'll use, so admins can add it to the allowlist.
  const redirect = chrome.identity.getRedirectURL();
  $('redirect-uri').textContent = redirect.endsWith('/') ? redirect + 'cb' : redirect + '/cb';

  const resp = await send({ type: 'get-base-url' });
  const baked = Boolean(resp?.baked);

  if (baked && resp.baseUrl) {
    // Packaged-download build: hide the URL editor and show the baked-in URL.
    $('baked-section').hidden = false;
    $('baked-base-url').textContent = resp.baseUrl;
    $('unpacked-section').hidden = true;
  } else {
    // Unpacked dev build: let the user point at any iHub instance.
    $('unpacked-section').hidden = false;
    $('baked-section').hidden = true;
    if (resp?.ok && resp.baseUrl) {
      $('base-url').value = resp.baseUrl;
    }
    $('save-btn').addEventListener('click', async () => {
      const value = $('base-url').value.trim();
      setStatus('Saving…');
      const r = await send({ type: 'set-base-url', baseUrl: value });
      if (!r.ok) {
        setStatus(r.error || 'Failed to save', 'error');
        return;
      }
      // Try fetching runtime config to verify the URL points at an iHub instance
      const cfg = await send({ type: 'get-runtime-config' });
      if (!cfg.ok) {
        setStatus(
          'Saved, but could not load extension config: ' + (cfg.error || 'unknown error'),
          'warn'
        );
        return;
      }
      setStatus('Saved. You can sign in now.', 'success');
    });
  }

  $('signin-btn').addEventListener('click', async () => {
    setStatus('Opening sign-in window…');
    const r = await send({ type: 'sign-in' });
    if (!r.ok) {
      setStatus(r.error || 'Sign-in failed', 'error');
      return;
    }
    setStatus('Signed in.', 'success');
    refreshAuthState();
  });

  $('signout-btn').addEventListener('click', async () => {
    const r = await send({ type: 'sign-out' });
    setStatus(r.ok ? 'Signed out.' : r.error || 'Sign-out failed', r.ok ? 'success' : 'error');
    refreshAuthState();
  });

  refreshAuthState();
}

init();
