# OAuth2 Multi-Tenancy Final Concept

This document finalizes the approach for implementing multi-tenancy in **AI Hub**.
It incorporates lessons learned from Airweave's Auth0 based design and expands on
our earlier `multi-tenancy.md` concept.

## Key Findings from Airweave

- Airweave models each tenant as an **Organization** stored in PostgreSQL.
- A `UserOrganization` table records membership and role (`owner`, `admin`,
  `member`).
- Auth0 Organizations are created and managed through the Auth0 Management API.
  Users are invited via OAuth2 and can belong to multiple orgs.
- Organization endpoints provide CRUD operations, member invitations, role
  management and the ability for a user to set their primary organization.
- On login, the backend syncs the user's Auth0 organizations so that local data
  matches the external IdP.
- Collection data, credentials and vector namespaces are stored with an
  `organization_id` ensuring complete isolation of tenant data.

## Gaps in the Existing AI Hub Concept

Our earlier `multi-tenancy.md` covers hierarchical configuration inheritance but
lacks a concrete OAuth2 workflow or membership model. It also does not describe
how users are attached to tenants or how connectors store credentials per
organization.

## Final Design for AI Hub

1. **Organization Model**
   - Table `organization` with fields `id`, `name`, `description`, and optional
     `external_org_id` for IdP integration.
   - Table `user_organization` linking users to organizations with a role and
     `is_primary` flag.
2. **OAuth2 Integration**
   - Use an external OIDC provider that supports organizations (Auth0, Azure AD
     or similar). During login we obtain the user's organization context.
   - Implement an optional management client (similar to Airweave's
     `Auth0ManagementClient`) to create organizations, invite members and manage
     roles when the provider supports it.
   - Store access and refresh tokens per organization for connectors. Rotate
     tokens automatically.
3. **Configuration Inheritance**
   - Retain the hierarchy from `multi-tenancy.md`. Each organization inherits
     from the root tenant unless overridden.
   - Configuration files under `contents/<tenant_id>` override defaults in
     `contents/root`.
4. **API and Admin Endpoints**
   - CRUD endpoints for organizations, membership management and invitations.
   - Endpoints to list and manage connectors, collections and search namespaces
     scoped to the current organization.
5. **Request Context**
   - Determine the active tenant from the authenticated user or from a domain
     alias. The organization ID is included in access tokens and used to load the
     correct configuration.
6. **Data Isolation**
   - All vector stores, caches and uploaded files include the organization ID in
     their keys or directory paths.
   - Background sync jobs operate per organization, ensuring separation of
     credentials and data.
7. **Migration Strategy**
   - Treat the current single-tenant setup as the root organization.
   - Gradually introduce organization records and update existing data with a
     default `organization_id`.

## Benefits Over the Initial Concept

- Defines a concrete membership model and OAuth2 flow.
- Leverages external IdP features for secure organization management.
- Provides clear API endpoints for admin tasks.
- Ensures every stored item is isolated by organization.

This plan brings AI Hub's multi-tenancy on par with Airweave's capabilities while
keeping our configuration inheritance approach.
