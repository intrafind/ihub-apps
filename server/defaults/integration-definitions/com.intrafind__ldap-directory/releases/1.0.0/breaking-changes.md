# People directory (LDAP) 1.0.0 — breaking changes

Config migration V198 moved the directories into installations:

- Every directory of `config/peopleDirectories.json` became an installation under the same id;
  the file is removed. Bind passwords stay credential references.
- Apps that listed `peopleDirectories` or a directory in `tools` or `requiredIntegrations` bind
  the installations under `integrations` instead.

Config migration V205 moved the admin LDAP browser out of the directory:

- The install fields `browse`, `browseGroups`, `browseBase`, `browseMaxResults`,
  `browseBindMode`, `browseBindDn`, `browseBindPasswordRef` and `browseDenyAttributes` and the
  actions `browse_search`, `browse_read` and `browse_children` are gone from this definition.
- A directory with the browser switched on got an installation of **LDAP browser**
  (`com.intrafind/ldap-browser`) named `<directory id>-browser`, which reuses the directory's
  connection. The browse tools are now `<browser id>__browse_*`.
- The shipped People search app binds `type:people-directory` instead of this definition.
