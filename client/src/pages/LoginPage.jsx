import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../shared/contexts/AuthContext.jsx';
import { getSafeReturnPath } from '../utils/safeUrl';

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  const returnUrl = searchParams.get('returnUrl');

  // Store returnUrl in sessionStorage on mount so auth callbacks can redirect back.
  // Only set if not already stored — preserves the original URL through NTLM multi-step flow.
  useEffect(() => {
    if (returnUrl && !sessionStorage.getItem('authReturnUrl')) {
      sessionStorage.setItem('authReturnUrl', returnUrl);
    }
  }, []); // eslint-disable-line @eslint-react/exhaustive-deps

  // Open the auth gate — the single login dialog for the whole app — full-page
  // for the dedicated /login route. After a successful gate login the gate
  // dispatches `authGateSuccess`, AuthContext refreshes, and the effect below
  // redirects to the stored returnUrl.
  useEffect(() => {
    if (!isLoading && !user && window.__authGate) {
      window.__authGate.show();
    }
  }, [isLoading, user]);

  // Redirect authenticated users immediately (handles NTLM return and already-logged-in users).
  // Both return URLs are untrusted input, so only a path on this app is followed;
  // anything else lands on the app root.
  useEffect(() => {
    if (!isLoading && user) {
      const storedReturnUrl = sessionStorage.getItem('authReturnUrl');
      if (storedReturnUrl) {
        sessionStorage.removeItem('authReturnUrl');
        window.location.href = getSafeReturnPath(storedReturnUrl);
      } else if (returnUrl) {
        window.location.href = getSafeReturnPath(returnUrl);
      } else {
        navigate('/');
      }
    }
  }, [user, isLoading, returnUrl, navigate]);

  // Show spinner while auth state is loading or after login redirect
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // If user is authenticated we'll redirect — don't flash the form
  if (user) {
    return null;
  }

  // The auth gate (full-page overlay) renders the login UI on top of this page.
  // It is inlined into every index.html entry that renders this route (see
  // vite-plugin-auth-gate.js), so window.__authGate is always defined here —
  // just show a spinner underneath while it loads.
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}
