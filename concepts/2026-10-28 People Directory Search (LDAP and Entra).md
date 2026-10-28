# People Directory Search: LDAP directories next to Entra

**Date:** 2026-10-28
**Status:** Proposal
**Related:** [Entra People Search](2025-07-11%20Entra%20People%20Search.md), [Unified Integrations](2026-10-20%20Unified%20Integrations/README.md) (epic [intrafind/ihub-apps#2911](https://github.com/intrafind/ihub-apps/issues/2911)), [LDAP provider configuration](../server/utils/ldapProviderConfig.js), [Tools](../docs/tools.md)

---

## Requirement

> We already have an Entra search as a tool call. We should support LDAP search as well, especially when an LDAP directory is already configured. It should be possible to add more, because x500.bund.de is an external one and customers want to search in it — sometimes in both the own and the external one. The LLM can decide whether it wants to search in more than one.

## Summary

Admins register **people directories**. Each enabled directory becomes its own small set of read-only tools (`<directoryId>__search_people`, `<directoryId>__get_person`, optionally `<directoryId>__list_units`) with a name and description the model can reason about ("staff of German federal authorities, external"). An app gets the directories it should search by listing those tools; the model decides per question which directory to call, and calls several when the question needs it. There is no fan-out inside one call.

A directory is either a **standalone LDAP connection** (for example the anonymous, external `x500.bund.de`) or a **reference to an LDAP sign-in provider** that is already configured in `platform.json` (`ldapAuth.providers[]`), so the corporate directory needs one click, not a second copy of URL, base DN and bind account. Entra joins the same contract in phase 2 as directory type `entra`; the existing `entraPeopleSearch_*` tool stays as it is.

## What we know about x500.bund.de

Verified with `ldapsearch` from a customer-side network on 2026-10-28:

| Fact | Value |
| --- | --- |
| Endpoint | `ldap://x500.bund.de:389`, plain LDAP; LDAPS / StartTLS not yet checked |
| Bind | Anonymous bind succeeds |
| Protocol | LDAPv2 and v3 |
| Naming contexts | `o=Bund,c=DE` (people), `o=PKI-1-VERWALTUNG,c=DE` (PKI) |
| Layout | `o=Bund,c=DE` → `ou=<authority>` (BSA, BfA, BMBF, BPA, BVerfG, GBA, MRI, THW, Service, …) → optional `l=<city>` → person |
| Person entry | `objectClass: ivbbPerson, inetOrgPerson, organizationalPerson, person`; `cn: "<Surname> <Given name>"`, `mail`, `telephoneNumber` |
| Example DN | `cn=Greiner Ralf,l=Karlsruhe,ou=MRI,o=Bund,c=DE` |
| Controls | Paged results (`1.2.840.113556.1.4.319`), server-side sort (`1.2.840.113556.1.4.473`/`.474`), proxied authorization (`2.16.840.1.113730.3.4.18`), plus two vendor controls |

Consequences: the authority and city live in the **DN**, not necessarily in attributes, so the preset reads them from the DN. `cn` is surname-first. The server is a public directory and will enforce a size limit; the tool must treat "size limit exceeded" as a partial result, not as an error.

## What exists today

| Piece | Where | Reuse |
| --- | --- | --- |
| Entra people search | `server/tools/entraPeopleSearch.js`, `server/services/integrations/EntraService.js`, env-only credentials | Phase 2 adapter. Note: `findUser` returns only the first match and does not escape `'` in its OData filter (`O'Brien` breaks the query). |
| LDAP sign-in providers | `platform.ldapAuth.providers[]`, schema in `server/validators/platformConfigSchema.js` | Referenced by name, like `proxyAuth.ldapGroupLookupProvider` already does |
| Provider resolution, presets, StartTLS host fix, filter escaping | `server/utils/ldapProviderConfig.js` (`resolveLdapProvider`, `escapeLdapFilterValue`, `buildStartTlsOptions`) | Reused; `buildStartTlsOptions` gets exported |
| Bind passwords | Credential store, `credentialService.resolveSecret(ref)` | Same `passwordRef` mechanism |
| LDAP client | `ldapts`, today only transitively through `ldap-authentication` | Becomes a direct server dependency |
| Dynamic tools | `loadTools()` in `server/toolLoader.js` merges discovered MCP and A2A tools | Add `discoverPeopleDirectoryTools()` next to them |
| Per-call user context | `runTool(toolId, { …args, chatId, user, appConfig })` | Enforce directory groups at execution time |
| Connection diagnostics | `server/routes/admin/ldapTest.js`, `DiagnosticsReport` | Pattern for the directory test endpoint |
| SSL whitelist | `getTlsBypassOptions(url)` in `server/utils/httpConfig.js` | Required by CLAUDE.md for every new outbound connection |

## Design

### 1. Configuration: `contents/config/peopleDirectories.json`

A new config file, loaded through `configCache`, so adding or changing a directory takes effect without a restart (platform changes need one). Being a new file, it needs no migration; `server/defaults/config/peopleDirectories.json` ships `{ "directories": [] }`.

```jsonc
{
  "directories": [
    {
      // Corporate AD: reuses the sign-in provider, adds nothing but a name
      "id": "corp",
      "enabled": true,
      "type": "ldap",
      "authProvider": "corp-ad",              // name in platform.ldapAuth.providers[]
      "name": { "en": "Company directory", "de": "Firmenverzeichnis" },
      "description": {
        "en": "Employees of our company: name, e-mail, phone, department, manager.",
        "de": "Mitarbeitende unseres Unternehmens: Name, E-Mail, Telefon, Abteilung, Vorgesetzte."
      },
      "groups": ["authenticated"]
    },
    {
      // External, anonymous: everything stated here
      "id": "x500bund",
      "enabled": true,
      "type": "ldap",
      "url": "ldap://x500.bund.de:389",
      "allowPlaintext": true,                 // only until LDAPS/StartTLS is confirmed (open question 2)
      "baseDn": "o=Bund,c=DE",
      "preset": "ivbb",
      "bind": { "mode": "anonymous" },
      "dataFlow": "external",
      "name": { "en": "Federal directory (IVBB)", "de": "Verzeichnisdienst des Bundes (IVBB)" },
      "description": {
        "en": "Staff of German federal authorities (BMBF, BVerfG, THW, …). Search by surname; narrow by authority with list_units.",
        "de": "Beschäftigte von Bundesbehörden (BMBF, BVerfG, THW, …). Nach Nachnamen suchen; mit list_units auf eine Behörde eingrenzen."
      },
      "units": true,
      "maxResults": 25,
      "timeoutMs": 8000,
      "groups": ["authenticated"]
    }
  ]
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9_-]{1,31}$`; becomes the tool id prefix. Validated against MCP/A2A/tool ids for collisions at load. |
| `type` | `ldap` now, `entra` in phase 2 |
| `authProvider` | Name of an `ldapAuth.providers[]` entry. Inherits `url`, `starttls`, `tlsOptions`, `baseDn`, `preset`, `adminDn` + `adminPasswordRef`. Any field set on the directory overrides the inherited one. Resolved at call time, so a provider edit (after the platform restart it needs anyway) is picked up. |
| `url`, `starttls`, `baseDn`, `preset`, `tlsOptions` | As in the sign-in provider schema; required when there is no `authProvider` |
| `bind` | `{ "mode": "anonymous" }` or `{ "mode": "service", "dn": "…", "passwordRef": "<credential id>" }`. Default with `authProvider`: the provider's bind account. No inline passwords. |
| `searchBase` | Defaults to `baseDn` (or the provider's `userSearchBase`) |
| `personFilter` | Override of the preset's object-class filter, e.g. to exclude service accounts |
| `searchAttributes` | Attributes free-text tokens are matched against (preset default) |
| `attributeMapping` | Override of the preset's mapping onto the person fields below |
| `units` | Offer `list_units` and the `unit` parameter (one-level children of the search base) |
| `allowPlaintext` | Default `false`. A plain `ldap://` URL without StartTLS is refused unless this is `true`, for anonymous binds too. A service bind is never sent in plain text, whatever this says. |
| `allowedHosts` | Hosts this directory may reach although they resolve to a private address (see §5) |
| `maxResults` (default 10, ≤ 50), `timeoutMs` (default 8000, ≤ 30000) | Upper bounds; a tool call can ask for fewer results, never more |
| `concurrency` (default 2), `requestDelayMs` (default 0) | One queue per directory, shared by all of its tools and the admin test (see §5) |
| `groups` | Who may use the directory. Applied when tools are listed *and* again in the tool, because the tool gets `user` with every call. |
| `dataFlow` | `internal` (default) or `external`; carried into the tool definition for the approval work in [#2945](https://github.com/intrafind/ihub-apps/issues/2945) |

Why one entry per directory and not a flag on the sign-in provider: exposing the company directory to an LLM is a data-protection decision of its own, the external directories have no sign-in provider, and the search needs settings (description, groups, limits) that do not belong to login. Admin UI shortcut: "Use for people search" on a configured LDAP sign-in provider creates the referencing entry (phase 2).

**Bind requirement for referenced providers.** iHub never keeps a user's LDAP password, so a search cannot run "as the user". A referenced provider needs a bind account, or the directory sets `bind.mode: anonymous` if the directory allows anonymous search. Active Directory normally does not. The test endpoint says so.

### 2. Presets for search

The sign-in presets (`openldap`, `activeDirectory`) gain a `search` block. `ivbb` is new and is search-only, so it is not added to the sign-in schema's `preset` enum.

| | `openldap` | `activeDirectory` | `ivbb` (x500.bund.de) |
| --- | --- | --- | --- |
| Person filter | `(objectClass=inetOrgPerson)` | `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` (enabled accounts only) | `(objectClass=ivbbPerson)` |
| Free-text attributes | `cn`, `sn`, `givenName`, `displayName`, `mail`, `uid` | `cn`, `sn`, `givenName`, `displayName`, `mail`, `sAMAccountName` | `cn`, `sn`, `givenName`, `mail` |
| Name | `displayName` → `givenName sn` → `cn` | same | `givenName sn` → `cn` (surname-first) |
| Organization | `o` | `company` | DN component `ou` |
| Department | `ou`, `departmentNumber` | `department` | — |
| Location | `l`, `physicalDeliveryOfficeName` | `physicalDeliveryOfficeName`, `l` | DN component `l`, then `l` |
| Extras | `title`, `mobile` | `title`, `mobile`, `manager` (DN) | — |

The `ivbb` column for `sn`, `givenName`, `title`, `ou` and `mobile` still has to be checked against a full entry (see open questions).

### 3. Tools per directory

For each enabled directory the user may use, `discoverPeopleDirectoryTools()` adds:

| Tool id | Parameters | Returns |
| --- | --- | --- |
| `<id>__search_people` | `query` (required, name / e-mail / free text, ≥ 2 chars per token), optional `firstName`, `lastName`, `email`, `unit`, `maxResults` | `{ directory, results: Person[], truncated, hint? }` |
| `<id>__get_person` | `personId` (from a search result) | `Person` with all mapped fields |
| `<id>__list_units` (only with `units: true`) | — | `[{ unitId, name }]` of the search base's one-level children, cached for 1 h |

**Who sees a directory's tools.** `loadTools()` has no user, so the directory's `groups` cannot be applied there. The discovered tools carry `_peopleDirectory: { id }`, and one helper, `mayUseDirectory(user, directoryId)`, is applied wherever tools are narrowed to a user:

- `configCache.getToolsForUser`, which serves the `/api/tools` listing;
- `getToolsForApp`, which builds the chat's tool list and has `context.user`;
- `mayRunTool` (direct tool runs) and the MCP gateway permission check;
- the tool itself at execution time, as the last guard.

`groups` is ANDed with the existing grants. An app that lists `x500bund__search_people`, or a `permissions.tools: ["*"]` grant, does not hand the directory to a user outside its `groups`.

The tool's name and description come from the directory's `name` and `description`, so the model sees "Federal directory (IVBB) – staff of German federal authorities…" and can decide which directory fits the question. Searching the own and the external directory is two tool calls the model makes in parallel; nothing is merged server-side, and each result says which directory it came from.

`Person`:

```json
{
  "directory": "x500bund",
  "personId": "cn=Greiner Ralf,l=Karlsruhe,ou=MRI,o=Bund,c=DE",
  "name": "Ralf Greiner",
  "firstName": "Ralf",
  "lastName": "Greiner",
  "email": "ralf.greiner@mri.bund.de",
  "phone": "0721 6625 - 300",
  "mobile": null,
  "title": null,
  "department": null,
  "organization": "MRI",
  "location": "Karlsruhe",
  "managerId": null
}
```

Tool ids follow the `<instanceId>__<action>` convention MCP tools already use and the Unified Integrations architecture keeps, so a directory later becomes an installed instance of a built-in "People directory" integration without renaming a tool an app references.

### 4. Query construction

The model never supplies an LDAP filter. The tool builds it:

```
(&<personFilter>
  (|(cn=*greiner*)(sn=*greiner*)(givenName=*greiner*)(mail=*greiner*))   ← one OR-block per token
  (|(cn=*ralf*)(sn=*ralf*)(givenName=*ralf*)(mail=*ralf*))
  (sn=greiner*)                                                         ← structured fields, prefix match
)
```

- Every value goes through `escapeLdapFilterValue` (RFC 4515).
- Tokens shorter than 2 characters and wildcard-only queries are rejected with a message the model can act on.
- `unit` must be one of `list_units`' ids; it narrows the search base (`ou=THW,o=Bund,c=DE`). It is never concatenated from free text.
- `personId` for `get_person` must lie inside the directory's search base, so the tool cannot be used to read entries elsewhere, such as `o=PKI-1-VERWALTUNG`. The check works on parsed DNs, never on strings:
  - Parse with an RFC 4514 parser that handles escaped separators (`\,`, `\+`, hex escapes) and multi-valued RDNs (`cn=a+uid=b`). A DN that does not parse is rejected.
  - Normalise each attribute type: lower-case it, and map the OID form (`2.5.4.3`) and known aliases (`commonName`) onto the short name.
  - Normalise values with the attribute's equality rule. For the naming attributes involved here (`c`, `o`, `ou`, `l`, `dc`, `cn`, `uid`) that is caseIgnoreMatch: trim, collapse inner whitespace, and fold case.
  - Treat a multi-valued RDN as an unordered set.
  - Accept the DN only when its RDN sequence ends with the search base's RDN sequence and is longer than it.
  - String suffix matching is not used anywhere. `cn=x\,ou=people,o=firma` does not lie in `ou=people,o=firma`.
- Only mapped attributes are requested (never `*`), so binary or sensitive attributes (`userCertificate`, `userPassword`, `jpegPhoto`) never leave the directory.
- `effectiveMaxResults = min(requested maxResults ?? directory.maxResults, directory.maxResults)`. `sizeLimit` = `effectiveMaxResults + 1`, `timeLimit` from `timeoutMs`. LDAP result code 4 (size limit exceeded) or more entries than `effectiveMaxResults` → at most `effectiveMaxResults` results, `truncated: true` and a hint to narrow the search (`unit`, first name).

### 5. Connection

`server/services/peopleDirectory/LdapDirectory.js` with `ldapts`:

- **Target check, every connection.** The directory URL can come from an admin, an inherited sign-in provider or the inline test entry, so it goes through the SSRF guard (REVIEW.md, A01):
  - The host is resolved through `dnsGuard`, and every address is classified with `ssrfGuard.isPrivateIP`.
  - A private, loopback or link-local address is refused unless the host is allowed explicitly. That can be the directory's `allowedHosts`, the platform-wide `ssrf.allowedHosts` (the same rule the MCP `safeFetch` applies), or the host of the referenced `authProvider`, which iHub already connects to on every sign-in.
  - Company directories on private addresses are therefore one allow-list entry, or no extra step at all when they reuse the sign-in provider.
  - The check runs at connection time, not only when the config is saved, and also covers inline test entries.
- **Pinned address.** The client connects to the validated IP literal, not to the host name, so a DNS change between check and connect cannot redirect it. TLS still verifies the certificate against the host name, by passing `servername`/`host` = host name; `buildStartTlsOptions` already does this for StartTLS.
- New `Client({ url: <pinned>, timeout, connectTimeout, tlsOptions: { ...getTlsBypassOptions(url), ...directory.tlsOptions, servername } })`; for StartTLS `client.startTLS(buildStartTlsOptions(url, …))`.
- One connection per call, `unbind()` in `finally`. A small pool is not worth it at chat-tool call rates.
- **Transport.** LDAPS or StartTLS is required by default, for anonymous binds too: search terms and the returned records are personal data. Plain `ldap://` needs `allowPlaintext: true` on the directory. The admin test and the admin page then show the same warning the sign-in provider shows. A service bind is never sent in plain text.
- **Throttling.** All tools of one directory, and the admin test for it, share one `throttledRun` queue keyed `peopleDirectory:<id>`, with the directory's `concurrency` and `requestDelayMs`. Calls from different tools therefore do not get separate queues. `throttledRun` resolves limits from the tool and model configs only, so it gains an optional explicit `{ concurrency, delayMs }` argument for this.
- **No per-user quota.** A user can already reach the company directory through the mail client's address book, and x500.bund.de is public. Chat turns are bounded by the tool-round limit, and the admin test sits behind `adminAuth`.
- LDAP is not HTTP: the `proxy` settings do not apply. External directories need a direct route on port 389/636 from the iHub server. This goes in the docs and in the test endpoint's error text.

### 6. Admin

Phase 1:

- `GET/PUT /api/admin/people-directories` (whole file, Zod-validated, like other config files) and `POST /api/admin/people-directories/test` that takes a saved id or an inline entry.
  - Both routes sit behind `adminAuth`. `adminAuth` already rejects delegated and machine principals (`isAdminEligiblePrincipal`), so personal API keys, OAuth clients and agents get a 403 before any entry is parsed or any connection is opened.
  - `GET` returns bind passwords only as credential references. It reports the steps with `DiagnosticsReport`: resolve (including the inherited provider), connect, StartTLS, bind, run a sample search, and show the attribute mapping of the first hit.
- The directory tools appear in the existing app editor tool picker and in `groups.permissions.tools`, with no extra work.

Phase 2: admin page under Integrations, or as part of the Unified Integrations admin section ([#2919](https://github.com/intrafind/ihub-apps/issues/2919)) if that lands first. It would also add a "Use for people search" button on LDAP sign-in providers.

### 7. App

An example app `people-directory` (en/de) in `examples/apps/`, whose system prompt tells the model to:

- prefer the company directory, and use the external one when the question names an authority or the person is not found internally;
- call several directories in parallel when unsure, and say which directory each hit came from;
- ask for a first name or authority when a result is truncated;
- never guess contact details.

### 8. Entra (phase 2)

`type: "entra"` backed by `EntraService`, mapped onto the same `Person` and the same two tools (`<id>__search_people`, `<id>__get_person`, plus `managerId` → `get_person`). This needs these fixes to `findUser`:

- return all matches (`$top`) instead of `value[0]`;
- double `'` inside OData string literals;
- optionally use `$search` with `ConsistencyLevel: eventual` for better name matching.

The existing `entraPeopleSearch_*` tool, its ids and its env-variable credentials are not changed. Folding it into the new tools would change tool ids that apps reference, which is a breaking change and needs a separate decision.

## Security and privacy

- Read-only. No write operations exist, and nothing is cached beyond `list_units`.
- Filter injection: escaped values only, no model-supplied filters, and the DN scope check on `get_person`.
- Attribute allowlist per directory. Admins see in the test result exactly which fields leave the directory.
- Access: `groups` per directory, ANDed with the existing tool grants, and checked both when tools are listed and when they execute (§3).
- Network: the SSRF guard with a pinned address on every connection, internal hosts only via an explicit allow-list, and TLS required unless `allowPlaintext` (§5).
- External data flow: the search terms (names) go to a third-party server. This is marked `dataFlow: external` for the approval policy of #2945, and stated in the directory description.
- Logging: directory id, user id, result count and duration at `info`; the query text only at `debug` (it is personal data).
- SSL whitelist honoured through `getTlsBypassOptions`, with tests for a whitelisted and a non-whitelisted host. Known gap, out of scope: the existing sign-in path (`ldap-authentication`) does not apply the whitelist yet.

## Files

| New | Changed |
| --- | --- |
| `server/services/peopleDirectory/PeopleDirectoryService.js` (resolve config, groups, dispatch) | `server/toolLoader.js` (discover + dispatch `_peopleDirectory` tools, `mayUseDirectory` in `getToolsForApp`) |
| `server/services/peopleDirectory/dn.js` (RFC 4514 parse, normalise, containment) | `server/configCache.js` `getToolsForUser`, `server/routes/toolRoutes.js` `mayRunTool`, `server/services/mcp/permissions.js` (directory groups) |
| | `server/requestThrottler.js` (explicit `{ concurrency, delayMs }` for `throttledRun`) |
| `server/services/peopleDirectory/LdapDirectory.js` (ldapts client, filter, mapping) | `server/utils/ldapProviderConfig.js` (export `buildStartTlsOptions`, search presets) |
| `server/services/peopleDirectory/presets.js` | `server/configCache.js` (load `peopleDirectories.json`) |
| `server/validators/peopleDirectorySchema.js` | `server/package.json` (`ldapts`) |
| `server/defaults/config/peopleDirectories.json` | `docs/tools.md`, `docs/SUMMARY.md` |
| `server/routes/admin/peopleDirectories.js` | |
| `examples/config/peopleDirectories.json`, `examples/apps/people-directory.json` | |
| `docs/people-directory-search.md`, `docs/releases/next/<entry>.md` | |
| tests (below) | |

## Tests

- Filter builder: escaping (`*`, `(`, `)`, `\`, NUL), tokenisation, minimum length, structured fields, `unit` scoping.
- `get_person` DN scope check:
  - accepted: inside the base;
  - rejected: the base itself, a sibling naming context, a look-alike suffix (`o=Bund,c=DE.evil`), an escaped comma (`cn=x\,ou=people,o=firma` against `ou=people,o=firma`), and a malformed DN;
  - normalised: multi-valued RDNs in either order, OID and alias attribute types (`2.5.4.10=Bund`, `organizationName=Bund`), and case and whitespace differences.
- Result limit: directory `maxResults: 25` and a request for 50 → `sizeLimit: 26` sent, at most 25 results, `truncated` set when 26 come back.
- SSRF: a private address is refused without an allow-list entry, accepted with `allowedHosts`, `ssrf.allowedHosts` or the `authProvider` host, and checked again for inline test entries. The connection uses the pinned address while TLS still verifies against the host name.
- Transport: plain `ldap://` is refused without `allowPlaintext`, and a service bind over plain text is always refused.
- Throttling: search and get on one directory share one queue.
- Admin routes: a non-admin, a personal API key and an OAuth client principal each get a 403 before any LDAP connection is made.
- Preset mapping against fixtures: the x500 entry above, an AD user with `manager`, an OpenLDAP `inetOrgPerson`.
- Config resolution: `authProvider` inheritance and overrides, missing provider, provider without bind account, inline password rejected by the schema.
- Groups: a user outside `groups` does not see the tool in `/api/tools`, in an app that lists it, or with a `*` grant, and is refused when the tool is called anyway.
- TLS: `getTlsBypassOptions` applied for a whitelisted host and not for another one; StartTLS `servername`.
- Size limit / timeout / connection refused → structured results the model can act on (mocked `ldapts` client).
- Manual (not CI): `x500bund` against the live server.

## Phases

1. **LDAP directories:** config file and schema, LDAP adapter with the three presets, dynamic tools, group enforcement, admin API with the test endpoint, example config and app, docs and changelog.
2. **Entra and admin UI:** Entra as directory type with the `findUser` fixes, the admin page, and the "Use for people search" shortcut on sign-in providers.
3. **Unified Integrations:** when #2912/#2973 land, a directory becomes an instance of a built-in "People directory" integration; tool ids stay.

## Open questions

1. **x500 attributes:** what does a full entry look like? Run `ldapsearch -x -LLL -H ldap://x500.bund.de -b "o=Bund,c=DE" "(cn=Greiner Ralf)" '*'`. This decides the `ivbb` mapping for `sn`, `givenName`, `title`, `ou` and `mobile`.
2. **TLS:** does `ldaps://x500.bund.de:636` or StartTLS work?
3. **Server-side limit:** what size limit does x500.bund.de enforce? Run a broad query such as `(sn=M*)` with `-z 0`.
4. **Reachability:** is x500.bund.de reachable only from the IVBB / federal networks? That decides whether customers outside it can use the shipped example at all.
5. **Admin UI timing:** should the admin UI be part of phase 1, or wait for the Unified Integrations admin section? The proposal is to wait, with a JSON config plus test endpoint first.
6. **Shipping x500:** should `x500bund` ship as a disabled default entry, or only as an example? The proposal is example only, because only some customers can reach it.
