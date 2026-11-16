---
description: "Read users' LDAP groups, map them to iHub groups such as admins, check the result and fix what does not map."
audience: admin
type: how-to
adminPage: /admin/groups
---

# LDAP Group Lookup and Mapping

When an LDAP user logs in, iHub reads the groups the user belongs to in the directory and maps
them to iHub groups through the `mappings` of each group. The iHub groups decide which apps,
models and prompts the user sees, and whether the user can open the admin area. This page covers
the three parts: set up the lookup, map the groups, and check the result.

The provider itself (URL, presets, bind account, TLS) is described in
[LDAP and NTLM Authentication](ldap-ntlm-authentication.md#configuration). The same mapping also
applies to NTLM users whose groups are read through an LDAP provider, see
[LDAP Group Lookup for NTLM Users](ldap-ntlm-authentication.md#ldap-group-lookup-for-ntlm-users).

## Set up group lookup

A provider reads group membership only when it knows where groups live. Edit the provider in
**Admin → Authentication → LDAP**, or in `ldapAuth.providers` in `contents/config/platform.json`:

```json
{
  "ldapAuth": {
    "enabled": true,
    "providers": [
      {
        "name": "corporate-ldap",
        "url": "ldaps://ldap.example.com:636",
        "preset": "openldap",
        "baseDn": "dc=example,dc=org",
        "adminDn": "cn=admin,dc=example,dc=org",
        "adminPasswordRef": "ldap_corporate-ldap",
        "defaultGroups": ["users"]
      }
    ]
  }
}
```

The settings that matter for group lookup:

| Setting                        | What it does for groups                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseDn` / `groupSearchBase`   | Where groups are searched. `groupSearchBase` defaults to `baseDn`. **With neither set, no group search runs at all.** Name a narrower subtree, such as `ou=groups,dc=example,dc=org`, with `groupSearchBase`.                                                              |
| `preset`                       | `openldap` (default) sets `groupClass` to `groupOfNames`; `activeDirectory` sets it to `group`. See [Directory Presets](ldap-ntlm-authentication.md#directory-presets).                                                                                                    |
| `groupClass`                   | Object class of group entries. Set it explicitly for any other schema, such as `groupOfUniqueNames`.                                                                                                                                                                       |
| `groupMemberAttribute`         | Group attribute that lists the members. Default `member`.                                                                                                                                                                                                                  |
| `groupMemberUserAttribute`     | User attribute that the group entries reference. Default `dn`.                                                                                                                                                                                                             |
| `adminDn` + `adminPasswordRef` | Bind account used for the search. `adminPasswordRef` is the id of a credential profile (**Admin → Credentials**). Without a bind account, groups are only found if users may search them themselves. See [Bind Credentials](ldap-ntlm-authentication.md#bind-credentials). |
| `defaultGroups`                | iHub groups every user of this provider gets, in addition to the mapped ones.                                                                                                                                                                                              |

iHub takes each group's name from its `cn` (or `name` / `displayName`), not its full DN. A group
`cn=IT-Admin,ou=groups,dc=example,dc=org` is mapped as `IT-Admin`.

Changes saved in the admin UI apply from the next login. If you edit `platform.json` by hand,
restart the server.

## Map LDAP groups to iHub groups

Each iHub group lists the external group names that grant it in its `mappings` array. Set them in
**Admin → Groups → (group) → External Group Mappings**, or in `contents/config/groups.json`:

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "name": "Admins",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": true
      },
      "mappings": ["IT-Admin", "Administrators", "Domain Admins"]
    },
    "users": {
      "id": "users",
      "name": "Users",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["*"],
        "adminAccess": false
      },
      "mappings": ["Domain Users", "Employees"]
    }
  }
}
```

Changes to `groups.json` reload automatically; no restart is needed.

How the mapping behaves:

- Names match **exactly and case-sensitively**: `IT-Admin` and `it-admin` are different groups.
  Copy the names from the [login test](#verify-the-setup) or the logs.
- Wildcards are not supported. List every group by name.
- One LDAP group can appear in the `mappings` of several iHub groups, and several LDAP groups can
  map to one iHub group.
- A user in several mapped groups gets all of them; their permissions are merged.
- Every logged-in user also gets the `authenticated` group, plus the provider's `defaultGroups`.
- If none of the user's LDAP groups is mapped, the user also gets the `anonymous` group.

How mapping and group inheritance work in general is in
[Group Mapping](ldap-ntlm-authentication.md#group-mapping).

### Grant admin access

1. Add the LDAP group of your administrators to the `mappings` of the `admins` group.
2. Make sure the `admins` group has `"adminAccess": true` in its permissions.
3. Log in as a member of that LDAP group and open `/admin`.

> [!WARNING]
> The `admins` group shipped in a fresh `contents/` already maps `IT-Admin`, `IT-Admins`,
> `Platform-Admin` and `Platform-Admins`, and `users` maps `Employees` and `Staff`. If your
> directory has groups with these names, their members get those rights as soon as LDAP is on.
> Replace the lists with your own group names.

### Example: several permission levels

```json
{
  "groups": {
    "admins": {
      "id": "admins",
      "permissions": { "apps": ["*"], "prompts": ["*"], "models": ["*"], "adminAccess": true },
      "mappings": ["Platform-Admins", "IT-Management"]
    },
    "power-users": {
      "id": "power-users",
      "permissions": {
        "apps": ["*"],
        "prompts": ["*"],
        "models": ["gpt-4", "claude-3-opus"],
        "adminAccess": false
      },
      "mappings": ["Advanced-Users", "Developers"]
    },
    "users": {
      "id": "users",
      "permissions": {
        "apps": ["chat", "translator"],
        "prompts": ["general"],
        "models": ["gpt-3.5-turbo"],
        "adminAccess": false
      },
      "mappings": ["All-Employees"]
    }
  }
}
```

### Example: Active Directory

The `activeDirectory` preset sets `sAMAccountName` as the username attribute and `group` as the
group class, so the provider needs no more than this:

```json
{
  "name": "active-directory",
  "url": "ldaps://ad.example.com:636",
  "preset": "activeDirectory",
  "baseDn": "dc=example,dc=com",
  "adminDn": "svc-ihub@example.com",
  "adminPasswordRef": "ldap_active-directory",
  "defaultGroups": ["users"]
}
```

```json
{
  "groups": {
    "admins": { "mappings": ["Domain Admins", "Enterprise Admins", "IT-Admin"] },
    "users": { "mappings": ["Domain Users"] }
  }
}
```

## Verify the setup

### Test a login

**Admin → Authentication → LDAP → Test a login** runs the whole login path for one username
without creating a session, against the configuration currently in the form, saved or not. It
reports the LDAP groups the directory returned, which of them have no mapping, and the internal
groups the user would end up in. With a bind account configured it needs no password. The steps it
reports are listed in [Testing a Login](ldap-ntlm-authentication.md#testing-a-login).

Start here: it answers the first three questions of the [troubleshooting](#troubleshooting)
section in one place.

### Read the server logs

For a real login, or where the admin UI is not reachable, read the server log. Logs are JSON by
default (see [Logging](logging.md)); filter on `"component":"LdapAuth"` and
`"component":"Authorization"`. A successful lookup looks like this:

```json
{"component":"LdapAuth","level":"info","message":"LDAP Auth: extracted LDAP groups for user","username":"john.doe","groupCount":3,"groups":"IT-Admin, Employees, VPN-Users"}
{"component":"Authorization","level":"warn","message":"External group has no mapping in groups configuration","externalGroup":"VPN-Users"}
{"component":"LdapAuth","level":"info","message":"LDAP Auth: mapped LDAP groups to internal groups","username":"john.doe","ldapGroupCount":3,"internalGroupCount":2,"internalGroups":"admins, users"}
```

| Message                                                                       | Level | Meaning                                                                                          |
| ----------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `LDAP Auth: group search enabled`                                             | info  | Group search runs; shows `groupSearchBase` and `groupClass`.                                     |
| `LDAP Auth: group search not configured, no baseDn or groupSearchBase is set` | warn  | No groups are read for this provider.                                                            |
| `LDAP Auth: extracted LDAP groups for user`                                   | info  | The LDAP groups found (`groupCount`, `groups`). Copy names from here.                            |
| `LDAP Auth: no groups found in LDAP response for user`                        | warn  | The search returned nothing. See [No Groups Retrieved](#no-groups-retrieved-from-ldap).          |
| `LDAP: could not extract group name from group object`                        | warn  | A group entry had no `cn`, `name` or `displayName`.                                              |
| `External group has no mapping in groups configuration`                       | warn  | One LDAP group (`externalGroup`) is not in any `mappings`.                                       |
| `External groups have no mapping`                                             | warn  | Summary of all unmapped groups (`unmappedGroups`).                                               |
| `LDAP Auth: mapped LDAP groups to internal groups`                            | info  | The mapped iHub groups (`internalGroups`), before `authenticated` and `defaultGroups` are added. |
| `External group mapped to internal groups`                                    | debug | Which iHub groups one LDAP group mapped to.                                                      |
| `No groups mapped, assigning anonymous group`                                 | debug | None of the user's LDAP groups is mapped.                                                        |

Unmapped groups are normal for LDAP groups iHub does not need. Act when an important group, such
as your admin group, is among them.

To see the `debug` messages, set the log level to `debug` in **Admin → System → Logging
Configuration**, or in `platform.json`:

```json
{
  "logging": {
    "level": "debug"
  }
}
```

### Look up group names in the directory

To see a user's groups outside iHub, query the directory with `ldapsearch`. `memberOf` lists the
group DNs; map the `cn` part.

```bash
# OpenLDAP and other directories
ldapsearch -x -H ldaps://ldap.example.com:636 \
  -D "cn=admin,dc=example,dc=org" \
  -w "password" \
  -b "ou=people,dc=example,dc=org" \
  "(uid=testuser)" memberOf

# Active Directory
ldapsearch -x -H ldaps://ad.example.com:636 \
  -D "admin@example.com" \
  -w "password" \
  -b "dc=example,dc=com" \
  "(sAMAccountName=testuser)" memberOf
```

## Troubleshooting

### No Groups Retrieved from LDAP

**Symptom:** the login test shows no LDAP groups, or the log has
`LDAP Auth: no groups found in LDAP response for user` or
`LDAP Auth: group search not configured, no baseDn or groupSearchBase is set`.

1. Set `baseDn`, or `groupSearchBase` for a narrower subtree such as
   `ou=groups,dc=example,dc=org`. Without either, no group search runs.
2. Check that `groupClass` matches the directory schema: `groupOfNames` or `groupOfUniqueNames`
   for OpenLDAP, `group` for Active Directory. Set `preset` or `groupClass` accordingly.
3. Check `groupMemberAttribute` and `groupMemberUserAttribute` if your groups list members in a
   different attribute than `member`, or by something other than the user's DN.
4. Check that the bind account (`adminDn`, `adminPasswordRef`) may read the group subtree.
5. Confirm with [`ldapsearch`](#look-up-group-names-in-the-directory) that the user is a member
   of at least one group.

### Groups Not Mapped to Internal Groups

**Symptom:** LDAP groups are found, but the log shows
`External group has no mapping in groups configuration` for the groups you expected to map, or
`internalGroupCount` is 0.

1. Copy the group names exactly from the login test or the
   `LDAP Auth: extracted LDAP groups for user` log entry.
2. Add them to the `mappings` of the right iHub group. Watch the case and typos.
3. Use the group's `cn`, not its full DN.
4. Validate `groups.json` if you edited it by hand: `jq . contents/config/groups.json` fails on
   invalid JSON.

### Admin Access Not Working

**Symptom:** the user can log in but `/admin` returns 403 or redirects away.

1. Check the user's internal groups in the login test, or `internalGroups` in the
   `LDAP Auth: mapped LDAP groups to internal groups` log entry. It must include `admins`; if it
   shows only `users` or nothing, the admin group is not mapped.
2. Check that the `admins` group's `mappings` contains the user's LDAP group, spelled exactly.
3. Check that the `admins` group has `"adminAccess": true`.
4. Log in with a known member of that LDAP group and open `/admin` again.

### User Has Only Default Groups

**Symptom:** the user gets `anonymous` and `authenticated` but none of the groups you expect; at
`debug` level the log shows `No groups mapped, assigning anonymous group`.

1. Map at least one of the user's LDAP groups, see
   [Groups Not Mapped](#groups-not-mapped-to-internal-groups).
2. To give every user of the provider a base set of rights regardless of mappings, set
   `defaultGroups` on the provider, for example `"defaultGroups": ["users"]`.
3. If no LDAP groups are found at all, see [No Groups Retrieved](#no-groups-retrieved-from-ldap).

Connection, bind and TLS errors are covered in
[LDAP and NTLM Authentication → Troubleshooting](ldap-ntlm-authentication.md#ldap-issues).
