# Multi-Tenancy Concept

This document outlines a simple approach to introduce multi-tenancy to the application. The goal is to allow configuration on a per-tenant basis while keeping the system easy to manage.

## Overview
- **Tenants**: The system supports a root tenant and any number of nested sub-tenants. Each tenant can have child tenants, forming a tree structure.
- **Configuration Inheritance**: Configuration values cascade from parent to child. A child tenant can override any configuration option from its parent, while unspecified options fall back to the parent's value.

## Steps to Implement
1. **Tenant Model**
   - Add a tenant identifier to relevant database tables or configuration files.
   - Store parent-child relationships to represent the hierarchy.
2. **Configuration Storage**
   - Keep configuration records associated with a tenant ID.
   - When loading configuration, merge the parent's settings with the child's overrides.
3. **Request Context**
   - Determine the tenant for each request (e.g., from the domain name or request headers).
   - Load the effective configuration for that tenant using the inheritance logic.
4. **Administration Tools**
   - Provide a way to manage tenants and their configurations in the admin interface.
5. **Default Root Tenant**
   - Use the root tenant as the base configuration. All new tenants inherit from it automatically.

## Keep It Simple
- Start with basic configuration fields and expand as needed.
- Avoid complex permission schemes until the core hierarchy works reliably.

## Key Questions to Answer

Before implementing multi-tenancy, clarify these points. Each item lists possible approaches or answers to guide decisions.

1. **Tenant Identification**
   - How will the server determine which tenant a request belongs to?
     *Possible approaches*: domain or subdomain mapping, path prefixes, or custom headers.
2. **Configuration Storage**
   - Where will per-tenant configuration reside?
     *Possible approaches*: separate directories under `contents` or configuration records in a database.
3. **Configuration Inheritance**
   - How should overrides be merged with the root configuration?
     *Possible answer*: shallow merges so unspecified options fall back to the parent.
4. **Tenant-Specific Content**
   - Which files are tenant specific (apps, models, tools, UI text)?
     *Impact*: influences directory layout and caching logic.
5. **API Keys and Secrets**
   - Are API keys shared or per tenant?
     *Possible answer*: store them in the tenant configuration with environment variables as a fallback.
6. **Data Isolation**
   - Should usage logs or uploads be separated per tenant?
     *Possible answer*: add tenant IDs to data records or maintain per-tenant files.
7. **Authentication & Authorization**
   - How are users mapped to tenants?
     *Possible approaches*: identity provider claims or origin-based mapping.
8. **Admin Interface**
   - What capabilities must the admin interface provide?
     *Possible answer*: listing tenants, editing configuration, and managing inheritance.
9. **Deployment Strategy**
   - Will all tenants run in one server or separate instances?
     *Impact*: affects environment variables and caching scope.
10. **Caching and Performance**
    - How should caching handle multiple tenants?
      *Possible answer*: include the tenant ID in cache keys or use separate cache directories.
11. **Backward Compatibility**
    - How will existing single-tenant deployments migrate?
      *Possible answer*: treat the current configuration as the root tenant and add tenant-specific directories over time.

