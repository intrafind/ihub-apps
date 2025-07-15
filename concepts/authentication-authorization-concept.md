## Authentication and Authorization Concept

This concept outlines a hybrid approach for adding an authentication and authorization layer to the AI Hub Apps platform, supporting both local Active Directory (AD) and OIDC with Microsoft Entra.

### Objectives

- Allow anonymous and authenticated users.
- Control access to apps and features through role‐based or group‐based permissions.
- Map user information and group memberships from external identity providers.

### Supported Authentication Methods

- **OIDC with Microsoft Entra** – primary method for receiving user identity and groups.
- **Local Active Directory (AD)** – via Windows Integrated Authentication (WIA), using libraries such as passport-waffle/passport-windowsauth (Node.js).
- **OAuth 2.0 providers** (e.g., Google, Facebook) – optional additional sign‐in options.
- **Local accounts** for development or fallback scenarios.
- Other identity systems (e.g., SAML or LDAP) can be integrated later if needed.

### Authorization Approach

1. Users are assigned to groups in the identity provider
2. 1 to many groups are mapped to our 1 to many groups on our side.
3. Apps are mapped to groups.
4. Grant anonymous users access only to specific apps via a specific group.

### Implementation Steps

1. Choose an authentication library compatible with the existing stack (e.g., Passport.js for Node.js, which supports both OIDC and Windows/AD strategies).
2. Implement OIDC login with Microsoft Entra to receive user profile and group data (using passport-azure-ad or passport-openidconnect).
3. Implement local Active Directory authentication using Windows Integrated Authentication (e.g., passport-waffle or passport-windowsauth for Node.js, Waffle for Java).
4. Allow users to select their authentication method (e.g., "Sign in with Entra" or "Sign in with Windows/AD"), or detect the environment to choose the appropriate strategy.
5. Add middleware to check authentication state (anonymous vs authenticated).
6. Normalize user profiles and group/role information from both OIDC and AD to a common format.
7. Map incoming groups to our own groups.
8. Apply authorization checks around app routes and administrative features.

### Design Notes

- Support both OIDC (Microsoft Entra) and local Active Directory (AD) authentication from the start.
- Use Passport.js (Node.js) or Waffle (Java) to enable multiple authentication strategies.
- Store group mappings in configuration files or environment variables.
- Normalize user and group data from both sources to a unified format for authorization.
- Structure the code so additional authentication providers can be plugged in easily later.
- it should also be possible to map all apps to a group, so not every individual one has to be specified
- our server should be stateless, which means it should not have any session and must be able to verify the authentication for every call. this will help us when we have to scale horizontally. this also means we have to generate an own token for the user after successful login. these tokens should have an expiration date and a salt, so we can make sure users have to login again after awhile as well as we can enforce a relogin for everyone.

### Questions to Clarify

Before starting implementation, these topics should be answered:

1. **Which identity provider(s) will be used initially?**  
   Support both OIDC via Microsoft Entra and local Active Directory (AD) via Windows Integrated Authentication.
2. **Will anonymous access be permitted, and to which apps?**  
   Yes. Anonymous users are handled like authenticated users. They are mapped to a specific group, which specifies which apps they can use.
3. **Which authentication library should be used with the Express server?**  
   Use Passport.js with both OIDC and Windows/AD strategies (e.g., passport-azure-ad, passport-openidconnect, passport-waffle, or passport-windowsauth).
4. **Where will user profiles and tokens be stored?**  
   Initially in memory or sessions; persist them in a database if the project grows.
5. **How will failures be handled (e.g., expired tokens, AD connection issues)?**  
   Return localized error codes similar to the existing API error handling.
6. **Do we need local accounts for development?**  
   Not yet.
7. **How will the front end handle login/logout?**  
   Replace the current random session ID with real authentication tokens obtained during login. Support both login flows in the UI.

### Impact on Existing Code

- Add middleware to authenticate incoming requests and check permissions for both OIDC and AD users.
- Update client-side session utilities to store authentication tokens instead of only a random ID, and support both login flows.
- Normalize user and group data from both authentication sources for consistent authorization checks.
- Usage tracking can include tenant and user identifiers once authentication is in place.
