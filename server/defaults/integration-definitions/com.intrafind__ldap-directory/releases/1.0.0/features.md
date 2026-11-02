# People directory (LDAP) 1.0.0

- First version of the built-in definition **People directory (LDAP)** (formerly "LDAP people
  directory"). Each installation is one LDAP or Active Directory directory: the company directory
  reusing an LDAP sign-in provider, or an external one such as x500.bund.de.
- Three read-only actions per directory, named and described after it: `search_people`,
  `get_person` and, with units on, `list_units` (tool ids `<id>__search_people`, …).
- The definition is of type `people-directory`, like the Microsoft Entra ID directory: an app
  that binds `type:people-directory` uses every people directory, the shipped People search app
  included.
- A dedicated editor (Admin → Integrations → the directory → Settings): source, access, network,
  model-facing name and description, limits, search and mapping, with a connection test that
  runs a sample search.
