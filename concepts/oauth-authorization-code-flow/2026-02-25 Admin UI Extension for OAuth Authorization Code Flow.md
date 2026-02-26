# Admin UI Extension for OAuth Authorization Code Flow

**Date:** 2026-02-25
**Feature:** OAuth Authorization Code Flow — Admin UI
**Task:** Task 4 in the OAuth Authorization Code Flow implementation

---

## Summary

This document describes the Admin UI changes made to support the OAuth Authorization Code
Flow. Two existing admin pages were extended to allow administrators to configure the new
OAuth 2.0 grant types, redirect URIs, client types, and related consent settings.

---

## Files Changed

### 1. `client/src/features/admin/pages/AdminOAuthClientEditPage.jsx`

The OAuth client create/edit form was extended with a new "OAuth 2.0 Authorization Code
Flow" section.

#### State additions

Two new local state variables were added directly after `availableModels`:

```js
const [redirectUriInput, setRedirectUriInput] = useState('');
const [postLogoutUriInput, setPostLogoutUriInput] = useState('');
```

These drive the controlled text inputs used to stage a URI before it is added to the list.

#### `formData` shape extension

The following fields were added to the initial `useState` object and to the `loadClient`
setter so that both "create" and "edit" modes work correctly:

| Field                   | Type       | Default                    | Purpose                                               |
| ----------------------- | ---------- | -------------------------- | ----------------------------------------------------- |
| `clientType`            | `string`   | `'confidential'`           | Whether the client can keep a secret (server-side)    |
| `grantTypes`            | `string[]` | `['client_credentials']`   | Which OAuth 2.0 grant types are enabled               |
| `redirectUris`          | `string[]` | `[]`                       | Allowed callback URIs for the authorization_code flow |
| `postLogoutRedirectUris`| `string[]` | `[]`                       | Allowed URIs to redirect to after logout              |
| `consentRequired`       | `boolean`  | `true`                     | Whether to show the consent screen to the user        |
| `trusted`               | `boolean`  | `false`                    | Trusted clients skip the consent screen automatically |

#### New handler functions

Three handler functions were added after `handleModelsChange`:

- **`handleRedirectUriAdd(field, value)`** — Validates the URI (must start with `https://`
  or `http://localhost`) and appends it to the named array field. Shows an `alert` if
  validation fails.
- **`handleRedirectUriRemove(field, index)`** — Removes the URI at `index` from the named
  array field.
- **`handleGrantTypeToggle(grantType)`** — Toggles a grant type string in/out of the
  `grantTypes` array.

#### New form section

A new section titled "OAuth 2.0 Authorization Code Flow" was inserted immediately before
the "Submit buttons" section. It contains:

1. **Client Type** — A `<select>` between `confidential` and `public`.
2. **Grant Types** — Three checkboxes: `client_credentials`, `authorization_code`,
   `refresh_token`.
3. **Redirect URIs** (visible only when `authorization_code` is checked) — A dynamic list
   with add/remove controls. Validates HTTPS or localhost.
4. **Post-Logout Redirect URIs** (visible only when `authorization_code` is checked) — Same
   pattern as Redirect URIs.
5. **Consent flags** (visible only when `authorization_code` is checked) — Two checkboxes:
   `consentRequired` and `trusted`.

All user-facing strings use `t('admin.auth.oauth.*')` i18n keys with English fallbacks.

---

### 2. `client/src/features/admin/pages/AdminOAuthClientsPage.jsx`

Two additional badge `<span>` elements were added to the client list item, directly after
the existing Active/Suspended badge:

```jsx
{client.clientType && (
  <span className="... bg-blue-100 text-blue-800">
    {client.clientType}
  </span>
)}
{(client.grantTypes || []).includes('authorization_code') && (
  <span className="... bg-purple-100 text-purple-800">
    {t('admin.auth.oauth.badgeAuthCode', 'auth-code')}
  </span>
)}
```

- The **blue badge** shows the client type (`confidential` / `public`) when present.
- The **purple badge** shows `auth-code` whenever the `authorization_code` grant type is
  enabled for the client.

---

## i18n Keys Introduced

All keys live under `admin.auth.oauth`:

| Key                          | Default (EN)                                             |
| ---------------------------- | -------------------------------------------------------- |
| `authCodeSection`            | OAuth 2.0 Authorization Code Flow                        |
| `clientType`                 | Client Type                                              |
| `clientTypeConfidential`     | Confidential (server-side apps with client secret)       |
| `clientTypePublic`           | Public (SPAs, mobile apps - PKCE required)               |
| `grantTypes`                 | Grant Types                                              |
| `grantClientCredentials`     | Client Credentials (machine-to-machine)                  |
| `grantAuthorizationCode`     | Authorization Code (user login with PKCE)                |
| `grantRefreshToken`          | Refresh Token (long-lived sessions)                      |
| `redirectUris`               | Redirect URIs                                            |
| `redirectUriPlaceholder`     | https://yourapp.com/callback                             |
| `redirectUriHint`            | Must use HTTPS (or http://localhost for development)     |
| `postLogoutRedirectUris`     | Post-Logout Redirect URIs                                |
| `postLogoutUriPlaceholder`   | https://yourapp.com/logged-out                           |
| `consentRequired`            | Require user consent screen                              |
| `trustedClient`              | Trusted client (skip consent screen)                     |
| `badgeAuthCode`              | auth-code                                                |

---

## Continuing the Work (Junior Developer Notes)

- The form data fields (`clientType`, `grantTypes`, `redirectUris`, etc.) are already sent
  to the server via `JSON.stringify(formData)` in `handleSubmit`. The server-side schema
  (Task 2, `V007` migration) already accepts these fields.
- The `authorization_code` grant flow on the server side (authorize endpoint, PKCE
  validation, token exchange) is handled by Task 5 and Task 6.
- Consent screen rendering is Task 9.
- No routing changes were needed for this task; the edit page uses the existing
  `/admin/oauth/clients/:clientId` route.
- Run `npm run lint:fix && npm run format:fix` before committing to satisfy the pre-commit
  hook.
