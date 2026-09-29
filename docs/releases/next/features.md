# Features — Unreleased

## Proxy Auth: Look Up User Groups From LDAP

When a reverse proxy identifies the user but cannot forward group memberships,
proxy authentication can now query an LDAP or Active Directory server for the
user's groups and merge them with any groups already supplied via header or JWT.

- New **LDAP Group Lookup Provider** setting on **Admin → Authentication** for
  proxy auth, mirroring the existing NTLM option. Pick any configured entry from
  `ldapAuth.providers` — `ldapAuth.enabled` does not need to be on.
- Results are cached per user (default 10 minutes, configurable) so the directory
  server is not queried on every request. Set the TTL to 0 to disable caching.
- LDAP groups are combined with groups from `X-Forwarded-Groups` and JWT `groups`
  claims before the usual external → internal mapping in `groups.json`.
- If the lookup fails, the request still succeeds using the header/JWT groups.

## Outlook Add-in: Choose Which Apps the Add-in Offers

Admins can now see and change which apps the Outlook add-in offers right on **Admin → Office
Integration**. The new **Available Apps** card shows at a glance whether the add-in offers all apps
or is limited to a selection, and lets you switch between the two and pick the apps without leaving
the page.

- Limits set earlier on the add-in's OAuth client (**Allowed Apps**) show up on the card unchanged —
  it is the same setting, now reachable from the page where you configure the add-in. A link leads
  on to the OAuth client for **Allowed Models** and **Allowed Prompts**.
- Choosing **Only selected apps** with nothing selected cannot be saved: an empty list would mean
  no restriction at all.
- The **Start Page** card warns when its default chat app or a default app is not on the list,
  because the task pane skips apps the add-in does not offer.
- Changes apply to signed-in users right away; no new sign-in or manifest redeploy is needed.
