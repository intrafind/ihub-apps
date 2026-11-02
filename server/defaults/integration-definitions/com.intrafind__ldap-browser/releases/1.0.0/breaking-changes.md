# LDAP browser 1.0.0 — breaking changes

Config migration V204 created the browser installations from the people directories:

- Every `com.intrafind/ldap-directory` installation with `browse` on got an LDAP browser
  installation `<directory id>-browser` (a suffix when the id was taken), enabled like the
  directory, with the browse settings moved over (`browseBase` → `baseDn`, `browseMaxResults`
  → `maxResults`, `browseBindMode`/`browseBindDn`/`browseBindPasswordRef` →
  `bindMode`/`bindDn`/`bindPasswordRef`, `browseDenyAttributes` → `denyAttributes`).
- `browseGroups` is gone: the groups that were listed there (default `admins`) are granted the
  browser installation in `permissions.integrations`. Groups that hold `*` there may use it too.
- The browse tool ids changed from `<directory id>__browse_*` to `<browser id>__browse_*`; the
  `ldapBrowse` tool reference is retired. App bindings and `tools` entries were rewritten to
  bind the browser installations (or `com.intrafind/ldap-browser`).
