import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as microsoftTeams from '@microsoft/teams-js';
import { apiClient } from '../../api/client';

/**
 * Teams Authentication Start Page
 * This page is loaded in the authentication popup window
 */
function TeamsAuthStart() {
  const { t } = useTranslation();

  const generateNonce = () => {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  };

  const generateState = () => {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  };

  const buildAuthUrl = useCallback(async context => {
    let clientId = context.clientId;
    let tenantId = context.tid;

    try {
      const { data } = await apiClient.get('/auth/teams/client-config');
      clientId = data.clientId || clientId;
      tenantId = data.tenantId || tenantId;
    } catch (err) {
      console.warn('Failed to fetch Teams client config:', err);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'token',
      response_mode: 'fragment',
      scope: 'https://graph.microsoft.com/User.Read openid profile email',
      redirect_uri: `${window.location.origin}/teams/auth-end`,
      nonce: generateNonce(),
      state: generateState(),
      login_hint: context.loginHint || context.userPrincipalName,
      domain_hint: 'organizations'
    });

    return `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/authorize?${params.toString()}`;
  }, []);

  useEffect(() => {
    // Initialize Teams SDK
    microsoftTeams.initialize();

    // Get the authentication parameters from Teams
    microsoftTeams.getContext(context => {
      // Build the Azure AD login URL
      buildAuthUrl(context).then(authUrl => {
        // Redirect to Azure AD for authentication
        window.location.href = authUrl;
      });
    });
  }, [buildAuthUrl]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">{t('teams.auth.redirecting')}</p>
      </div>
    </div>
  );
}

export default TeamsAuthStart;
