import { loginUser, createUser } from '../middleware/localAuth.js';
import { createAuthorizationMiddleware } from '../utils/authorization.js';

export default function registerAuthRoutes(app) {
  
  /**
   * Local authentication login
   */
  app.post('/api/auth/login', async (req, res) => {
    try {
      const platform = app.get('platform') || {};
      const localAuthConfig = platform.localAuth || {};
      
      if (!localAuthConfig.enabled) {
        return res.status(400).json({ error: 'Local authentication is not enabled' });
      }
      
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      
      const result = await loginUser(username, password, localAuthConfig);
      
      res.json({
        success: true,
        user: result.user,
        token: result.token,
        expiresIn: result.expiresIn
      });
      
    } catch (error) {
      console.error('Login error:', error);
      res.status(401).json({ 
        success: false, 
        error: error.message || 'Authentication failed' 
      });
    }
  });
  
  /**
   * Get current user information
   */
  app.get('/api/auth/user', (req, res) => {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    res.json({
      success: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        groups: req.user.groups,
        permissions: req.user.permissions,
        isAdmin: req.user.isAdmin,
        authenticated: req.user.authenticated,
        authMethod: req.user.authMethod
      }
    });
  });
  
  /**
   * Logout (client-side token removal, but we can track it)
   */
  app.post('/api/auth/logout', (req, res) => {
    // For stateless JWT, logout is primarily client-side
    // But we can log the event for analytics
    
    if (req.user && req.user.id !== 'anonymous') {
      console.log(`User ${req.user.id} logged out`);
    }
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
  
  /**
   * Create new user (admin only)
   */
  app.post('/api/auth/users', 
    createAuthorizationMiddleware({ requireAdmin: true }),
    async (req, res) => {
      try {
        const platform = app.get('platform') || {};
        const localAuthConfig = platform.localAuth || {};
        
        if (!localAuthConfig.enabled) {
          return res.status(400).json({ error: 'Local authentication is not enabled' });
        }
        
        const userData = req.body;
        const usersFilePath = localAuthConfig.usersFile || 'contents/config/users.json';
        
        const newUser = await createUser(userData, usersFilePath);
        
        res.status(201).json({
          success: true,
          user: newUser
        });
        
      } catch (error) {
        console.error('User creation error:', error);
        res.status(400).json({ 
          success: false, 
          error: error.message || 'Failed to create user' 
        });
      }
    }
  );
  
  /**
   * Get authentication status and configuration
   */
  app.get('/api/auth/status', (req, res) => {
    const platform = app.get('platform') || {};
    const authConfig = platform.auth || {};
    const proxyAuthConfig = platform.proxyAuth || {};
    const localAuthConfig = platform.localAuth || {};
    const oidcAuthConfig = platform.oidcAuth || {};
    
    const status = {
      authMode: authConfig.mode || 'proxy',
      allowAnonymous: authConfig.allowAnonymous ?? true,
      authenticated: req.user && req.user.id !== 'anonymous',
      user: req.user && req.user.id !== 'anonymous' ? {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        groups: req.user.groups,
        isAdmin: req.user.isAdmin,
        authMethod: req.user.authMethod
      } : null,
      authMethods: {
        proxy: {
          enabled: proxyAuthConfig.enabled ?? false,
          userHeader: proxyAuthConfig.userHeader,
          groupsHeader: proxyAuthConfig.groupsHeader
        },
        local: {
          enabled: localAuthConfig.enabled ?? false
        },
        oidc: {
          enabled: oidcAuthConfig.enabled ?? false,
          providers: oidcAuthConfig.providers?.map(p => ({
            name: p.name,
            displayName: p.displayName
          })) || []
        }
      }
    };
    
    res.json(status);
  });
}