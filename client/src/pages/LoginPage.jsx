import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../shared/contexts/AuthContext.jsx';
import LoginForm from '../features/auth/components/LoginForm.jsx';

const LoginPage = () => {
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Redirect authenticated users immediately (handles NTLM return and already-logged-in users)
  useEffect(() => {
    if (!isLoading && user) {
      const storedReturnUrl = sessionStorage.getItem('authReturnUrl');
      if (storedReturnUrl) {
        sessionStorage.removeItem('authReturnUrl');
        window.location.href = storedReturnUrl;
      } else if (returnUrl) {
        window.location.href = returnUrl;
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <LoginForm />
    </div>
  );
};

export default LoginPage;
