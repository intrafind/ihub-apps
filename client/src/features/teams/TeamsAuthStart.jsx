import { useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as microsoftTeams from '@microsoft/teams-js';

/**
 * Teams Authentication Start Page
 * This page is loaded in the authentication popup window
 */
function TeamsAuthStart() {
  const { t } = useTranslation();

  useEffect(() => {
    // Initialize Teams SDK
    microsoftTeams.initialize();

    // Get the authentication parameters from Teams
    microsoftTeams.getContext(context => {
      // Build the Azure AD login URL
      const authUrl = buildAuthUrl(context);

      // Redirect to Azure AD for authentication
      window.location.href = authUrl;
    });
  }, [buildAuthUrl]);

  const buildAuthUrl = useCallback(context => {
    const params = new URLSearchParams({
      client_id: process.env.REACT_APP_AAD_CLIENT_ID || context.clientId,
      response_type: 'token',
      response_mode: 'fragment',
      scope: 'https://graph.microsoft.com/User.Read openid profile email',
      redirect_uri: `${window.location.origin}/teams/auth-end`,
      nonce: generateNonce(),
      state: generateState(),
      login_hint: context.loginHint || context.userPrincipalName,
      domain_hint: 'organizations'
    });

    const tenantId = process.env.REACT_APP_AAD_TENANT_ID || context.tid || 'common';
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }, []);

  const generateNonce = () => {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  };

  const generateState = () => {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  };

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
