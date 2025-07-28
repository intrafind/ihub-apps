// Auth components
export { default as LoginForm } from './components/LoginForm.jsx';
export { default as AuthGuard } from './components/AuthGuard.jsx';
export { default as UserAuthMenu } from './components/UserAuthMenu.jsx';
// Legacy export for backward compatibility
export { default as UserMenu } from './components/UserAuthMenu.jsx';

// Auth hooks
export { useAuth } from './hooks/useAuth.js';

// Auth context
export { AuthProvider, useAuth as useAuthContext } from '../../shared/contexts/AuthContext.jsx';
