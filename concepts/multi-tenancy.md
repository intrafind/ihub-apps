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
     _Possible approaches_: domain or subdomain mapping, path prefixes, or custom headers.
2. **Configuration Storage**
   - Where will per-tenant configuration reside?
     _Possible approaches_: separate directories under `contents` or configuration records in a database.
3. **Configuration Inheritance**
   - How should overrides be merged with the root configuration?
     _Possible answer_: shallow merges so unspecified options fall back to the parent.
4. **Tenant-Specific Content**
   - Which files are tenant specific (apps, models, tools, UI text)?
     _Impact_: influences directory layout and caching logic.
5. **API Keys and Secrets**
   - Are API keys shared or per tenant?
     _Possible answer_: store them in the tenant configuration with environment variables as a fallback.
6. **Data Isolation**
   - Should usage logs or uploads be separated per tenant?
     _Possible answer_: add tenant IDs to data records or maintain per-tenant files.
7. **Authentication & Authorization**
   - How are users mapped to tenants?
     _Possible approaches_: identity provider claims or origin-based mapping.
8. **Admin Interface**
   - What capabilities must the admin interface provide?
     _Possible answer_: listing tenants, editing configuration, and managing inheritance.
9. **Deployment Strategy**
   - Will all tenants run in one server or separate instances?
     _Impact_: affects environment variables and caching scope.
10. **Caching and Performance**
    - How should caching handle multiple tenants?
      _Possible answer_: include the tenant ID in cache keys or use separate cache directories.
11. **Backward Compatibility**
    - How will existing single-tenant deployments migrate?
      _Possible answer_: treat the current configuration as the root tenant and add tenant-specific directories over time.

### Questions to Clarify

Answer these topics before adding multi-tenancy support:

1. **What is the initial tenant hierarchy?**  
   Begin with a root tenant. Create sub-tenants for different teams or environments as needed.
2. **Where will tenant-specific configuration be stored?**  
   Add a tenant ID to configuration files or database tables and merge parent settings with child overrides when loading configuration.
3. **How is a tenant determined for each request?**  
   Use the domain name or a request header to resolve the tenant ID.
4. **Is there an admin UI for managing tenants?**  
   Provide a basic interface to create and configure tenants.
5. **What level of configuration inheritance is required?**  
   Keep it simple—child tenants override only necessary fields and inherit the rest.

### Relationship to Authentication

Tenant selection may depend on the authenticated user or domain. Implement authentication and authorization first so the tenant context can be resolved reliably.
