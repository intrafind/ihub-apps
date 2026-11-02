# LDAP browser 1.0.0

- First version of the built-in definition **LDAP browser**: lets administrators ask about an
  LDAP directory in plain words and see the raw entries — attributes, branches, group members.
- An installation names a **People directory (LDAP)** installation and reuses its connection:
  URL, TLS settings, trusted certificates, allowed hosts, base DN and bind account. Its own
  settings are the browse base, the result limit, further attributes to withhold and an optional
  separate (read-only) bind account.
- Three read-only actions: `browse_search`, `browse_read` and `browse_children` (tool ids
  `<browser id>__browse_*`). A binding without `actions` binds all three.
- Who may browse is the installation's group grant (`permissions.integrations`). Personal API
  keys, OAuth clients and agents never browse, and the tools are never offered over the MCP
  gateway. Every call is written to the audit log.
