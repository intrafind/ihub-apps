# People directory: organization search, and an admin LDAP browser

Status: part 1 draft for review; part 2 implemented (see
`docs/people-directory-search.md`, "LDAP browser (for admins)"). Date: 2026-10-29.

Two independent parts that share the LDAP connection layer. They can be
planned and built separately; part 1 first.

1. **Organization search** (`search_units`, `get_unit`, `list_units(parent)`):
   mapped, safe for every user who may use the directory.
2. **Admin LDAP browser** (`browse_*` tools): raw LDAP entries for admins
   only. See "Part 2" at the end.

# Part 1: Search organizations and read their contact data

## Intent and why

The people directory tools (`server/services/peopleDirectory/`) let a chat
model look up **people**. A user also asks about **organizations**: "all THW
units", "how do I reach THW-Jugend?". Today the model cannot answer that:

- `<id>__list_units` returns only the direct children of the search base that
  are not people, as `{ unitId, name }`. It never returns units nested deeper,
  and it returns no contact data.
- `search_people` matches person entries only.

Observed on x500.bund.de (anonymous, 2026-10-29): `ou=THW` is a top-level
authority, but `THW- Bundesvereinigung e. V.` and `THW-Jugend e. V.` sit in
`cn=Liegenschaften` (82+ flat entries, 237+ organizationalUnit entries overall,
the server cuts anonymous results at 250). Each has an `ou=Hauptadresse` child
(`objectClass: ivbbRealEstate`) with the contact data (street, postalCode, l,
telephoneNumber, labeledURI). A user who asked for "all THW units" got only
`ou=THW`.

The goal is a natural-language interface in which the model finds
organizations by name anywhere in the tree, drills down, and reads contact
data on request. It must work for other LDAP systems (OpenLDAP, Active
Directory), not only x500.bund.de.

## Goals

1. Find units by name anywhere under the directory's search base.
2. Drill down: list the children of any unit.
3. Read one unit's contact data (address, phone, fax, e-mail, website, and a
   description when the directory has one).
4. Directory-specific knowledge (what a unit is, where its contact data lives,
   which attributes hold it) lives in the search preset and is overridable per
   directory, like the existing people mapping. No x500-specific code outside
   the `ivbb` preset.
5. Existing directories and existing tool calls behave exactly as before.

## Non-goals and anti-goals

- No contact data in search results. `search_units` returns names only, so one
  broad query never dumps addresses of dozens of organizations into the
  model's context. Contact data is fetched per unit with `get_unit`.
- No cache or mirror of the whole directory tree. The server cuts anonymous
  results (at least 250 units visible on x500.bund.de), so the full tree is
  not known and not assumed to fit. Search runs on the server.
- No write operations. Everything stays read-only.
- No new admin UI fields in this iteration (see "Left to the builder").
- Failure even if it technically works: the model gets a unit id that
  `search_people`'s `unit` argument or `get_unit` then rejects, or ids from one
  tool that are ambiguous in another.

## Behavior

The tools exist only for a directory with `units: true`, the flag that already
gates `list_units` and the `unit` argument. A directory without it offers none
of them and behaves exactly as before. Every preset (`openldap`,
`activeDirectory`, `ivbb`) defines a unit block, and a directory with no
preset resolves to the default `openldap` one, so `units: true` is the only
gate. Tool ids follow the existing scheme `<directoryId>__<action>`.

### `search_units`

Arguments: `query` (required, same word rules as `search_people`: at least 2
characters per word, at most `MAX_TOKENS` words, no wildcards), `parent`
(optional unitId; limits the search to that unit's subtree), `maxResults`
(optional, capped by the directory's `maxResults`).

Returns `{ directory, results, truncated, hint? }`; each result is
`{ unitId, name, path }` and nothing else.

- `name` is the unit's own name (its RDN value).
- `path` is the names of its ancestors below the search base, outermost first,
  e.g. `["Liegenschaften"]` for `THW-Jugend e. V.`; empty for a direct child of
  the base.
- Matching is a case-insensitive word match anywhere in the unit's name
  (`unitSearchAttributes` of the preset). Scope is the whole subtree below the
  search base, or below `parent`.
- Entries that are not units are never returned: people, and in `ivbb` the
  `ivbbRealEstate` address entries.
- `truncated: true` when the result limit or the server's size limit cut the
  list; the hint tells the model to narrow the query (same wording style as
  `search_people`). Zero matches gives a hint, as `search_people` does.

### `list_units`

Without arguments: unchanged (direct children of the search base, one-hour
cache, `{ unitId, name }`).

New optional argument `parent` (a unitId): returns the direct children of that
unit that are units, as `{ unitId, name }`, with `truncated`. Same limits and
size-limit handling as today.

### `get_unit`

Argument: `unitId` (required). Returns one object:

```
{ directory, unitId, name, path,
  contact: { street, postalCode, city, phone, fax, email, website } ,
  description, hasPeople }
```

- Contact fields the directory does not have are `null`. Every contact field
  is a string or `null`; several values of one field are joined with `"; "`,
  so the model always sees one type. Values such as the odd `-1610` extension
  fragment on THW-Jugend are returned as stored.
- `hasPeople` is `true` when `search_people` with `unit` set to this unitId
  can return anyone: any person anywhere in the unit's subtree, the same
  scope `search_people` uses. A unit with no `source: "child"` entry, or none
  matching `childFilter`, is not an error: its contact fields are all `null`.
- With `source: "child"`, the child is looked up one level below the unit
  only. If several match, the first in the order the server returns them is
  used.
- Unknown unit, or a unitId outside the directory's search base, gives the
  same style of error as `get_person` (`not_found` / argument error).

### Unit ids

A `unitId` is the unit's DN **relative to the search base**, e.g.
`ou=THW` or `ou=THW-Jugend e. V.,cn=Liegenschaften`. Today's ids are the
one-RDN case of this.

**Rule: every id that today's `list_units` returns stays valid in every
tool**, including containers that are not `organizationalUnit`, such as
`cn=Liegenschaften` on x500.bund.de.

- *What is accepted.* `parent` (of `list_units` and `search_units`),
  `get_unit` and `search_people`'s `unit` accept any entry inside the search
  base that exists and is not a person. This is the check `lookupUnit` does
  today (`isDnWithin` plus `(!personFilter)`), extended from one RDN to a
  multi-RDN relative DN. `unitFilter` is **not** used to validate ids.
- *What `unitFilter` decides.* Only what `search_units` returns and what
  `list_units(parent)` lists as children. The root `list_units` without
  arguments keeps today's filter `(!personFilter)`, so its output and its
  tests are unchanged.
- *A container as a unit.* `get_unit("cn=Liegenschaften")` works: it returns
  the name, path, `hasPeople`, and all-`null` contact data.
- *`search_people` with `unit`.* Unchanged semantics: the search runs over the
  unit's whole subtree (`scope: 'sub'`), and the existing matching of a bare
  name or single RDN against the root unit list stays as it is. A multi-RDN id
  is resolved by reading that entry (the `lookupUnit` approach), never by
  concatenating the argument into a DN: the RDNs are parsed and written back
  escaped. Bare names are not matched below the root, because a name can be
  ambiguous in a subtree; the model gets ids from `search_units`.
- *`path`.* Always relative to the search base, also when `parent` is given.

## Working with other LDAP systems

The preset (`server/services/peopleDirectory/presets.js`) gets a unit block,
and the directory entry may override each part, the same way
`attributeMapping` overrides the people mapping today:

- `unitFilter`: which entries are units.
  - `ivbb`: organizational units that are not address entries, i.e.
    `(&(objectClass=organizationalUnit)(!(objectClass=ivbbRealEstate)))`.
  - `openldap`: `(|(objectClass=organizationalUnit)(objectClass=organization))`.
  - `activeDirectory`: `(objectClass=organizationalUnit)`.
- `unitSearchAttributes`: the attributes a query is matched against. `ou`
  for all three presets (plus `o` for `openldap`).
- `unitContact`: where the contact data lives and how it maps.
  - `source: "self"` reads it from the unit entry (the default for `openldap`
    and `activeDirectory`).
  - `source: "child"` reads it from a child entry selected by `childFilter`
    (`ivbb`: `(objectClass=ivbbRealEstate)`; the first match is used).
  - `mapping`: output field to LDAP attribute(s), for example
    `street <- street`, `postalCode <- postalCode`, `city <- l`,
    `phone <- telephoneNumber`, `fax <- facsimileTelephoneNumber`,
    `email <- mail`, `website <- labeledURI`. Active Directory differs
    (`streetAddress`, `wwwHomePage`); the preset carries that.
  - `description`: attribute for the free-text description.

Everything x500-specific (the real-estate objectClass, the child entry) lives
in the `ivbb` preset values; the code only knows "unit", "self" and "child".

The attribute values above for `openldap` and `activeDirectory` are my
proposal from general LDAP schema knowledge, not verified against a running
server; the builder should check them against the sign-in presets in
`utils/ldapProviderConfig.js` and the existing tests.

## Constraints

- Same security posture as the existing tools: only mapped attributes are
  requested, never `*`; `FORBIDDEN_ATTRIBUTES` applies to the unit mapping
  too; filter values are escaped by the existing helpers; the bind mode,
  TLS rules, per-directory queue (`concurrency`, `requestDelayMs`) and
  `mayUseDirectory` access check are unchanged and apply to the new actions.
- `DIRECTORY_ACTIONS`, the runner's `OPERATIONS`, `buildDirectoryTools`
  (descriptions in `en` and `de`, like the existing actions) and the runner's
  result-count logging must cover the new actions.
- The ldapts client returns attribute values already decoded as UTF-8; the
  base64 seen in `ldapsearch` output for values with "ß" or umlauts is a
  display artifact of the CLI, not something this code decodes.
- Search on a public server must stay on indexed, name-like attributes (the
  existing reason `searchAttributes` for `ivbb` are only `cn sn givenName
  mail`). `ou` substring search worked against x500.bund.de on 2026-10-29
  (`(ou=*THW*)`); the builder re-checks the cost of a subtree substring
  search and falls back to prefix matching per word if the server pushes back.
- The default `people-directory` app's prompt and tool list mention units
  (`server/defaults/apps/people-directory.json`); apps follow their
  integration, so the new tools must be picked up without per-app config.
  The prompt should tell the model to search units first for questions about
  organizations, show names, and call `get_unit` only for the ones the user
  picks.
- Docs: `docs/people-directory-search.md`, the tool list in
  `docs/tool-calling.md`, and `examples/config/peopleDirectories.json`.
- Tests under `server/tests/peopleDirectory/`, using the injectable `connect`
  dependency, covering at least: a nested unit found under a flat container
  (the THW case), child-source and self-source contact reading, `parent`
  scoping, `truncated` handling, an id outside the search base, a directory
  without `units`, and that today's `list_units` output is unchanged.

## Decided by the user

- `search_units` returns names only; contact data comes from a separate call.
- The solution must work for other LDAP systems, not only x500.bund.de.
- The goal is a model that can drill down naturally and find units by itself.

## My calls (marked for review)

- Three tools: new `search_units` and `get_unit`, plus an optional `parent`
  on the existing `list_units`.
- Unit id = DN relative to the search base (backwards compatible).
- `hasPeople` on `get_unit`, and `path` on search results, so the model can
  tell same-named units apart and know when to switch to people.
- `description` is returned by `get_unit` only.
- No admin UI changes now; configuration through the directory's JSON entry.
- Ids returned by today's `list_units` stay valid everywhere; validation is
  "exists, non-person, inside the search base", not `unitFilter`.
- `search_people` with `unit` keeps its subtree scope and its root-level
  bare-name matching; multi-RDN ids are added.
- `units: true` is the only gate for the new tools.
- Contact fields are strings or `null`; several values are joined with `"; "`.
- A unit without a contact child returns all-`null` contact data, not an
  error.

## Left to the builder

- Exact function and file names, and how the unit block is validated in the
  directory schema (`peopleDirectorySchema`).
- How the relative DN is parsed, escaped and rebuilt, using `dn.js`.
- How `hasPeople` is computed (a one-result person search under the unit is
  the obvious approach).
- Whether a unit-children cache is worth it beyond the existing root cache.
- Whether the admin test (`testDirectory`) and the admin form show the new
  unit settings.

---

# Part 2: Admin LDAP browser

## Intent and why

Admins sometimes need to see what is really in an LDAP directory: which
attributes an entry has, how a branch is built, whether a group has the right
members. Today that means opening an LDAP client. The goal is a **natural-
language interface to an LDAP browser**: the admin asks in plain words, the
model builds the LDAP filter, runs the search, and shows the raw entries.

It is deliberately **not** part of people search. People search is mapped and
safe because it only ever requests named attributes and never `*`. A browser
is the opposite: raw entries, any attribute. Mixing the two would weaken the
guarantee that makes people search safe to give to every user. So the browser
gets its own tools, its own access list, and its own opt-in, and shares only
the connection layer (`connection.js`, `transport.js`, the SSRF and TLS rules,
the per-directory queue, the bind and its credential reference), so nobody
enters connection details twice.

The same concern is behind this part: listing the groups of arbitrary other
people is a privacy and social-engineering risk (group names reveal who sits
in security, HR or finance and who is privileged), so that kind of data belongs
behind an admin gate, not in the general people search.

## Goals

1. Admins can search any part of a directory and read any entry, as raw
   attributes, in natural language.
2. Only admins can: access is a separate list from the directory's `groups`,
   default `admins`, enforced at tool listing and again at call time.
3. No mapping, no preset needed: the browser works on any LDAP directory the
   platform can already connect to.
4. Known secret attributes never leave the server, and cannot be probed
   through a search filter either.
5. Every browser call is auditable.

## Non-goals and anti-goals

- No write operations of any kind.
- No attribute mapping and no `Person` shaping; the output is raw.
- No Entra / Microsoft Graph browser here. It would follow the same pattern
  later as its own admin-only tool; it is not part of this design.
- No admin UI editor for the browse settings in this iteration.
- Not offered to the general `people-directory` app or to non-admin users.
- Failure even if it technically works: a non-admin gets any browse tool or
  result; a secret attribute is returned or inferred through a filter; the
  shipped people-directory app suddenly carries the browse tools.

## Behavior

### Opt-in and access

A directory entry gets a `browse` block, absent or disabled by default:

```
"browse": {
  "enabled": true,
  "groups": ["admins"],
  "maxResults": 50,
  "base": "dc=example,dc=com",
  "bind": { "mode": "service", "dn": "...", "passwordRef": "..." },
  "denyAttributes": ["info"]
}
```

- `base` (optional): the DN the browser is confined to. **Default: the
  directory's `baseDn`** (the root of the directory), not the people
  `searchBase`. People search is usually narrowed to a branch such as
  `ou=people`, but the browser's main uses (groups, OU layout, other branches)
  live elsewhere. If the directory has no `baseDn`, `browse.base` is required.
  An admin can set it to a narrower branch to limit what the browser can see.
- `bind` (optional): a separate bind for the browser, same shape as the
  directory's `bind` (`anonymous`, or `service` with a credential reference).
  **Default: the directory's own bind.** Reusing it means the browser can read
  whatever that account can read; the deny list below is the only filter on
  top. An admin who has a read-only or reduced account for browsing should set
  it here. The documentation says plainly that, without it, the browser has the
  reach of the people-search account.
- `denyAttributes` (optional): extra attribute names to withhold, added to the
  built-in deny list. Sites keep secrets in custom attributes, and the built-in
  list is names only, so the guarantee is "known secrets plus what an admin
  adds", not "every secret".

- `enabled` (default `false`): the browse tools exist for this directory only
  when it is `true` and the directory itself is enabled and usable.
- `groups` (default `["admins"]`): who may use the browse tools. Resolved with
  the same group expansion and `inherits` handling as the existing `groups`
  (`expandUserGroups`, `mayUseDirectory`), but against this list. The
  directory's `groups` does not grant browse access, and `browse.groups` does
  not grant people-search access.
- `maxResults` (default 50): ceiling for one search, additionally capped by
  the directory's own server-side limits.
- A directory can be browse-only: if the schema does not allow an empty
  `groups` for "no one may use people search", the builder adds a clean way to
  express that (my call: an empty `groups` list means nobody).

### Tools

Tool ids follow the existing scheme: `<directoryId>__browse_search`,
`<directoryId>__browse_read`, `<directoryId>__browse_children`.

- `browse_search`: arguments `filter` (required, standard LDAP filter syntax
  per RFC 4515, for example `(&(objectClass=group)(cn=*admin*))`), `base`
  (optional DN, default the browse base), `scope` (`base`, `one` or `sub`;
  default `sub`), `attributes` (optional list of attribute names; default all
  user attributes), `maxResults`.
- `browse_read`: argument `dn` (required), `attributes` (optional). Returns
  one entry.
- `browse_children`: argument `dn` (optional, default the browse base).
  Returns the direct children as `{ dn, rdn, objectClass }`, without
  attributes, so a model can walk the tree without pulling data.

All DNs here are full DNs, as in any LDAP browser, and every one must lie
inside the **browse base** (`isDnWithin`, the check `get_person` uses against
the search base). A DN outside it is an argument error.

### Output

- An entry is `{ dn, attributes }`, where `attributes` maps each attribute name
  to a list of values, exactly as the server returned them (no mapping).
- Binary values are summarized as `[binary, N bytes]`; individual values over
  a length limit (about 500 characters) are cut with a note of the original
  length. The same presentation as `presentableEntry` in the runner is the
  starting point.
- The whole response has a size cap (about 30,000 characters). Hitting it, or
  the result limit, or the server's size limit, gives `truncated: true` and a
  hint to narrow the filter or the base, in the style of `search_people`.
- Operational attributes are not requested unless the model asks for them by
  name (my call).
- Attributes removed by the deny list (below) are named in an `omitted` list
  on the entry, so the model and the admin know something was withheld.

### Deny list

The existing `FORBIDDEN_ATTRIBUTES` (passwords, key material, certificates,
`objectSid`, `objectGUID`, photos) applies, plus attributes a read-capable
directory account can sometimes see: `ms-Mcs-AdmPwd`, `msLAPS-Password`,
`msLAPS-EncryptedPassword`, `msFVE-RecoveryPassword`, `msDS-ManagedPassword`,
`unixUserPassword`. The builder extends the shared list in one place so people
search benefits too. Comparison is case-insensitive, and the `;binary` and
other attribute options and OID forms of a name are normalized before the
comparison. `browse.denyAttributes` adds names for one directory. A mapping
(`attributeMapping`, `unitContact.mapping`) that names a newly forbidden
attribute fails the same way it fails today for the existing list.

A forbidden attribute must also not be inferable. A filter such as
`(userPassword=a*)` would let the model recover a value one character at a
time, so **a filter that mentions a denied attribute is rejected** before it
is sent. This needs a real filter parser (or the one ldapts offers), not a
substring check: attribute names appear in nested and negated clauses. An
unparseable filter is an argument error, not something passed through.

### Audit

Each browse call writes an audit record through the platform's audit log
(`AuditLogService`) with the user, directory id, tool, base, scope, filter,
requested attributes, number of entries returned, and whether it was
truncated. Unlike people search, the filter is not debug-only here: access is
admin-only and the point of auditing a raw browser is to see what was asked.
Entry values are not written to the audit log. A tool run has no HTTP
request, so the record uses the explicit actor path of `logAudit` (the user
from the tool call's context) instead of a request. Filters can contain
names or e-mail addresses; they go into the audit file as sent, under the
audit log's normal retention, and the documentation says so.

## Interaction with the rest

- **Browse tools are reachable only through the `ldapBrowse` tool group**,
  never through a directory id in an app's tool list and never through
  `peopleDirectories`, `requiredIntegrations` or any other way an app can
  reach "all tools of a directory". An app that selects a directory id gets its
  people-search tools only. The browse actions are therefore not covered by the
  directory's `groups` check at all: they are checked against `browse.groups`
  at listing and at call time, which also makes a browse-only directory
  (empty `groups`) work.
- The shipped `people-directory` app and the `peopleDirectories` tool group
  must **not** include browse tools, even for admins. The browser gets its own
  tool group (my call: `ldapBrowse`) and its own shipped app, disabled until an
  admin enables it, with a system prompt that explains LDAP filter syntax, how
  to walk from `browse_children` to `browse_read`, and that results are raw
  and may be incomplete (`truncated`).
- `dataFlow` (internal or external) is taken from the directory entry. Raw
  directory content goes to whichever model the admin chose, so the existing
  data-flow rules and warnings apply as they do for people search.
- Existing people-search behavior, tool ids, configuration and tests do not
  change. A directory without a `browse` block is exactly as before.

## Constraints

- Same security posture as the existing LDAP code: the bind, TLS options,
  SSRF checks, `allowedHosts`, the SSL whitelist and the per-directory queue
  are reused unchanged. No new way to disable certificate checks.
- Tool listing filters the browse tools for users outside `browse.groups`
  (`filterDirectoryToolsForUser` or an equivalent), and the runner re-checks
  at call time (the "last guard"), with its own refusal log entry.
- A search sends the model's filter as an LDAP filter string after parsing and
  validation; it is never concatenated with other filter text. Length limit
  on the filter (builder picks a sensible number, for example 1,000
  characters).
- Tests under `server/tests/peopleDirectory/` with the injectable `connect`
  dependency, covering at least: a non-admin never sees or runs the tools;
  an admin does; each deny-list attribute is stripped and named in
  `omitted`; a filter that mentions a denied attribute, also nested and
  negated, is rejected; a `base` outside the search base is rejected;
  truncation by result limit, by size cap, and by the server's size limit;
  binary and long values; the audit record is written; people search is
  unaffected.
- Docs: `docs/people-directory-search.md` (or a new `docs/ldap-browser.md`),
  `examples/config/peopleDirectories.json`, and a security note that says
  what the browser exposes and why it is off by default.

## Decided by the user

- Raw LDAP browser for admins as a natural-language interface, no mapping.
- Separate from people search; admin-only.
- Group listing for arbitrary other people is treated as sensitive.

## My calls (marked for review)

- The browser lives in the same directory entry (shared connection) behind
  its own `browse` block, separate tools and a separate access list; not a
  separate configuration file.
- Tool names `browse_search`, `browse_read`, `browse_children`; full DNs.
- Default access `admins`; default off; own tool group `ldapBrowse` and own
  shipped app.
- Deny-list additions for AD secrets; filters that mention denied attributes
  are rejected.
- Audit includes the filter, not the returned values.
- Response caps of about 500 characters per value and about 30,000
  characters per response.
- An empty `groups` means nobody may use people search (the schema already
  treats it as closed), so a directory can be browse-only.
- The browser's base defaults to the directory's `baseDn`, not the people
  `searchBase`, with `browse.base` to narrow it.
- The browser reuses the directory's bind by default, with an optional
  `browse.bind` for a separate read-only account; the documentation names the
  exposure of the default.
- `browse.denyAttributes` lets an admin extend the deny list per directory.
- Browse actions are reachable only via the `ldapBrowse` tool group and are
  checked against `browse.groups`, not `groups`.
- Audit goes through the explicit-actor path of `logAudit`; filters are
  recorded as sent.
- Build order: Part 1 first, since both parts touch `DIRECTORY_ACTIONS`,
  `OPERATIONS`, `buildDirectoryTools` and the runner's result-count logging.

## Left to the builder

- Schema shape and validation of the `browse` block, and how an empty
  `groups` is represented.
- Which filter parser to use and how it is integrated; the exact limits.
- How tool groups are expanded for apps (`peopleDirectories` today) and how
  `ldapBrowse` is added without touching existing apps.
- The exact audit record fields, following `AuditLogService`.
- Whether the admin connection test (`testDirectory`) also exercises browse.

## Built (part 2)

What the builder chose for the open points:

- **Schema:** `browse` is optional and strict. `groups` defaults to `["admins"]`
  and refuses `"*"`; only signed-in users can browse. `maxResults` defaults to
  50, at most 200. An empty directory `groups` already meant "nobody", so a
  browse-only directory needs nothing new.
- **Filter parser:** ldapts' `FilterParser`. The parsed filter object is sent,
  never the text. Filters longer than 1,000 characters, unparseable filters and
  extensible matches without an attribute type are argument errors.
- **Tool group:** `ldapBrowse` in `isToolSelected`; a browse tool marker has
  `browse: true` and is never selected by the directory id or
  `peopleDirectories`. Access is decided by the action (`BROWSE_ACTIONS`), not
  by the marker, in the listing, `mayRunTool` and the runner.
- **MCP gateway:** the browse tools are not exposed there at all.
- **Audit:** `logAudit` with `action: "read"`, `resource: "ldapBrowse"`, the
  directory id, and a JSON summary (tool, filter, base, scope, dn, attributes,
  entry count, truncated, error code). Refused calls are audited as failures.
- **Admin test:** not exercised; the configuration step shows the browse
  settings and their problems.
- **Admin UI:** added after all, at the user's request: an "LDAP browser"
  section in the directory editor (on/off, groups without "Everyone", base,
  result limit, account, extra denied attributes). Switching it off keeps
  the settings.
- **Order:** built before part 1, which still applies on top.

