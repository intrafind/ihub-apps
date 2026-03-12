// Auth components
export { default as LoginForm } from './components/LoginForm';
export { default as AuthGuard } from './components/AuthGuard';
export { default as UserAuthMenu } from './components/UserAuthMenu';
// Legacy export for backward compatibility
export { default as UserMenu } from './components/UserAuthMenu';

// Auth hooks
export { useAuth } from './hooks/useAuth.js';

// Auth context
export { AuthProvider, useAuth as useAuthContext } from '../../shared/contexts/AuthContext';
