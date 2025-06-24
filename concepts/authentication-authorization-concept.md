## Authentication and Authorization Concept

This concept outlines a simple approach for adding an authentication and authorization layer to the AI Hub Apps platform.

### Objectives
- Allow anonymous and authenticated users.
- Control access to apps and features through role‐based or group‐based permissions.
- Map user information and group memberships from external identity providers.

### Supported Authentication Methods
- **OIDC with Microsoft Entra** – primary method for receiving user identity and groups.
- **OAuth 2.0 providers** (e.g., Google, Facebook) – optional additional sign‐in options.
- **Local accounts** for development or fallback scenarios.
- Other identity systems (e.g., SAML or LDAP) can be integrated later if needed.

### Authorization Approach
1. Assign each user to one or more groups or roles provided by the identity provider.
2. Define which apps and features are available to each group.
3. Grant anonymous users access only to public apps (e.g., the chat app).
4. Give authenticated users additional capabilities based on their groups, including administrative rights where applicable.

### Implementation Steps
1. Choose an authentication library compatible with the existing stack (Passport.js, NextAuth, etc.).
2. Implement OIDC login with Microsoft Entra to receive user profile and group data.
3. Add middleware to check authentication state (anonymous vs authenticated).
4. Map incoming groups or roles to application permissions.
5. Apply authorization checks around app routes and administrative features.
6. Extend support for OAuth 2.0 providers or other methods as required.

### Design Notes
- Keep the initial version focused on Entra OIDC to reduce complexity.
- Store role and group mappings in configuration files or environment variables.
- Structure the code so additional authentication providers can be plugged in easily later.

### Questions to Clarify

Before starting implementation, these topics should be answered:

1. **Which identity provider(s) will be used initially?**  
   Start with OIDC via Microsoft Entra as the primary method. Other OAuth providers can be integrated later.
2. **Will anonymous access be permitted, and to which apps?**  
   Yes. Anonymous users can only use public apps such as the basic chat app.
3. **How will user roles/groups be mapped to app features?**  
   Map the groups or roles received from the identity provider to permissions stored in configuration files or environment variables.
4. **Which authentication library should be used with the Express server?**  
   Evaluate Passport.js or NextAuth.js for integration with OIDC.
5. **Where will user profiles and tokens be stored?**  
   Initially in memory or sessions; persist them in a database if the project grows.
6. **How will failures be handled (e.g., expired tokens)?**  
   Return localized error codes similar to the existing API error handling.
7. **Do we need local accounts for development?**  
   Yes. Local accounts remain a supported fallback.
8. **How will the front end handle login/logout?**  
   Replace the current random session ID with real authentication tokens obtained during login.

### Impact on Existing Code

- Add middleware to authenticate incoming requests and check permissions.
- Update client-side session utilities to store authentication tokens instead of only a random ID.
- Usage tracking can include tenant and user identifiers once authentication is in place.

### Implementation Order

Implement authentication and authorization before multi-tenancy. Resolving user identity first allows the system to determine the tenant context for configuration overrides.

