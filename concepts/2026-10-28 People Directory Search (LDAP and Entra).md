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
| Endpoint | `ldaps://x500.bund.de:636` (TLS) and `ldap://x500.bund.de:389` (plain), both reachable from the public internet |
| TLS | TLS 1.2, cipher `AES256-SHA256` (RSA key exchange, no forward secrecy; accepted by Node 22's default cipher list), RSA 4096 server key |
| Certificate chain | `CN=x500.bund.de` (until 2026-12-03) → `CN=CA IVBB Deutsche Telekom AG 23, O=PKI-1-Verwaltung` (until 2029-11-28; the server sends both) → root `CN=PCA-1-Verwaltung-23, O=PKI-1-Verwaltung` (2022-12-01 to 2032-12-31). The server does **not** send the root, and the root is in no public or Node trust store. |
| Bind | Anonymous bind succeeds |
| Protocol | LDAPv2 and v3 |
| Naming contexts | `o=Bund,c=DE` (people), `o=PKI-1-VERWALTUNG,c=DE` (PKI) |
| Layout | `o=Bund,c=DE` → `ou=<authority>` (BSA, BfA, BMBF, BPA, BVerfG, GBA, MRI, THW, Service, …) → optional `l=<city>` → person |
| Person object classes | `ivbbPerson`, `inetOrgPerson`, `organizationalPerson`, `person` |
| Example DN | `cn=Greiner Ralf,l=Karlsruhe,ou=MRI,o=Bund,c=DE` |
| Controls | Paged results (`1.2.840.113556.1.4.319`), server-side sort (`1.2.840.113556.1.4.473`/`.474`), proxied authorization (`2.16.840.1.113730.3.4.18`), plus two vendor controls |

A full person entry, read anonymously:

| Attribute | Example | Meaning |
| --- | --- | --- |
| `cn` | `Greiner Ralf` | Surname first |
| `sn`, `givenName` | `Greiner`, `Ralf` | |
| `displayName` | `Greiner, Ralf` | Surname first, with comma |
| `title` | `Dr.` | **Academic title**, not the job title |
| `role` | `Vertreter des Präsidenten` | The function / job title. UTF-8; `ldapsearch` prints it base64-encoded (`role::`) only because of the umlaut. |
| `vocation` | `Herr` | Salutation |
| `gouvernmentOrganizationalUnit` | `Leitung` | Organisational unit inside the authority. The attribute name really is spelled `gouvernment…`. |
| `company` | `MRI` | Authority, same as the DN's `ou` |
| `telephoneNumber`, `facsimileTelephoneNumber` | `0721 6625 - 300`, `… - 111` | Free-form, with spaces |
| `mail` | `ralf.greiner@mri.bund.de` | |

The server answers *"Search succeeded but at least one entry is incomplete"*, so it withholds some attributes from anonymous clients. No `l` attribute came back, for example.

Consequences:

- The city is read from the DN's `l` component, and the authority from `company`, falling back to the DN's `ou`.
- `cn` and `displayName` are surname-first, so the display name is built as `givenName sn`.
- `title` maps to `academicTitle`, never to the job title.
- The server is a public directory and will enforce a size limit. The tool treats "size limit exceeded" as a partial result, not an error.

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

A new config file, loaded through `configCache`, so adding or changing a directory takes effect without a restart (platform changes need one). Being a new file, it needs no migration.

`server/defaults/config/peopleDirectories.json` ships the `x500bund` entry below with `"enabled": false`. The server is reachable from the internet, so any customer can switch it on in the admin page, but nobody's search terms leave the network until an admin does (REVIEW.md, A02). The corporate entry is only an example, because it depends on a sign-in provider that may not exist.

**The BSI root ships with it.** The entry connects over `ldaps://` with full certificate verification. For that it needs the Verwaltungs-PKI root `PCA-1-Verwaltung-23`, which is in no public trust store, so iHub ships it as `server/defaults/config/certs/pca-1-verwaltung-23.pem`. The file was taken from the BSI download, `PCA-1-Verwaltung-23_zip.zip`, and checked on 2026-10-28:

- its SHA-256 fingerprint `1D:32:84:79:E1:65:FD:36:FB:C2:7E:1D:53:11:68:D1:3D:60:D6:6F:A1:9B:1B:81:80:36:C2:68:2D:18:DD:D4` and serial `A5EF9230` match the [BSI fingerprint list](https://www.bsi.bund.de/EN/Themen/Oeffentliche-Verwaltung/Moderner-Staat/Verwaltungs-PKI/Wurzelzertifizierungsstelle/FingerprintsderWurzelzertifikate/pcafingerprint.html);
- the chain the server sends verifies against it with `openssl verify -verify_hostname x500.bund.de`;
- the same chain verifies with Node 22's `X509Certificate` (`verify`, `checkHost`).

The root is a public certificate, not a secret. Shipping it only makes iHub trust it for the directories that name it (`tlsCa`), never globally. Like any default file, startup copies it into existing installations. `REUSE.toml` gets an entry for `server/defaults/config/certs/*.pem`.

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
      // External, anonymous: everything stated here. Shipped as a default, disabled.
      "id": "x500bund",
      "enabled": false,
      "type": "ldap",
      "url": "ldaps://x500.bund.de:636",
      "tlsCa": ["pca-1-verwaltung-23"],       // BSI Verwaltungs-PKI root, shipped in config/certs/
      "baseDn": "o=Bund,c=DE",
      "preset": "ivbb",
      "bind": { "mode": "anonymous" },
      "dataFlow": "external",
      "name": { "en": "Federal directory (IVBB)", "de": "Verzeichnisdienst des Bundes (IVBB)" },
      "description": {
        "en": "Public directory of German federal authorities (BMBF, BVerfG, THW, …): name, function, unit, phone, e-mail. External service. Search by surname; narrow by authority with list_units.",
        "de": "Öffentliches Verzeichnis der Bundesbehörden (BMBF, BVerfG, THW, …): Name, Funktion, Organisationseinheit, Telefon, E-Mail. Externer Dienst. Nach Nachnamen suchen; mit list_units auf eine Behörde eingrenzen."
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
| `id` | `^[a-z0-9][a-z0-9-]{1,31}$`, so no `_`: `isToolSelected` treats the part before the first `_` as a tool's base id. The id becomes the tool id prefix, and is validated against MCP, A2A and tool ids for collisions at load. |
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
| `tlsCa` | Names of trust anchors in the certificate store `contents/config/certs/<name>.pem` (`^[a-z0-9-]+$`, resolved with the path-security helpers). If set, only these anchors are trusted for this directory, through `tlsOptions.ca`. If unset, Node's default roots are used. Use it for directories whose CA is private (corporate PKI, the Verwaltungs-PKI). Unlike the SSL whitelist, verification stays on. |
| `allowedHosts` | Hosts this directory may reach although they resolve to a private address (see §5) |
| `maxResults` (default 10, ≤ 50), `timeoutMs` (default 8000, ≤ 30000) | Upper bounds; a tool call can ask for fewer results, never more |
| `concurrency` (default 2), `requestDelayMs` (default 0) | One queue per directory, shared by all of its tools and the admin test (see §5) |
| `groups` | Who may use the directory. Applied when tools are listed *and* again in the tool, because the tool gets `user` with every call. |
| `dataFlow` | `internal` (default) or `external`; carried into the tool definition for the approval work in [#2945](https://github.com/intrafind/ihub-apps/issues/2945) |

Why one entry per directory and not a flag on the sign-in provider: exposing the company directory to an LLM is a data-protection decision of its own, the external directories have no sign-in provider, and the search needs settings (description, groups, limits) that do not belong to login. Admin UI shortcut: "Use for people search" on a configured LDAP sign-in provider creates the referencing entry (§6).

**Bind requirement for referenced providers.** iHub never keeps a user's LDAP password, so a search cannot run "as the user". A referenced provider needs a bind account, or the directory sets `bind.mode: anonymous` if the directory allows anonymous search. Active Directory normally does not. The test endpoint says so.

### 2. Presets for search

The sign-in presets (`openldap`, `activeDirectory`) gain a `search` block. `ivbb` is new and is search-only, so it is not added to the sign-in schema's `preset` enum.

| | `openldap` | `activeDirectory` | `ivbb` (x500.bund.de) |
| --- | --- | --- | --- |
| Person filter | `(objectClass=inetOrgPerson)` | `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` (enabled accounts only) | `(objectClass=ivbbPerson)` |
| Free-text attributes | `cn`, `sn`, `givenName`, `displayName`, `mail`, `uid` | `cn`, `sn`, `givenName`, `displayName`, `mail`, `sAMAccountName` | `cn`, `sn`, `givenName`, `mail` |
| `name` | `displayName` → `givenName sn` → `cn` | same | `givenName sn` → `cn` (both `displayName` and `cn` are surname-first) |
| `jobTitle` | `title` | `title` | `role` |
| `academicTitle` | — | — | `title` |
| `salutation` | — | — | `vocation` |
| `organization` | `o` | `company` | `company` → DN component `ou` |
| `department` | `ou`, `departmentNumber` | `department` | `gouvernmentOrganizationalUnit` |
| `location` | `l`, `physicalDeliveryOfficeName` | `physicalDeliveryOfficeName`, `l` | DN component `l` → `l` |
| `phone`, `fax`, `mobile` | `telephoneNumber`, `facsimileTelephoneNumber`, `mobile` | same | `telephoneNumber`, `facsimileTelephoneNumber`, — |
| `managerId` | — | `manager` (DN) | — |

The same attribute name means different things per directory: `title` is the job title in OpenLDAP and AD, but the academic title in the IVBB directory. The presets keep that in one place, and `attributeMapping` overrides it per directory.

`search_people` also accepts `jobTitle` and `department` as structured, prefix-matched parameters when the preset maps them, for example "who is the president's deputy at the MRI". These are not part of the free-text OR-block, which keeps substring scans on a public server to the indexed name attributes.

### 3. Tools per directory

For each enabled directory the user may use, `discoverPeopleDirectoryTools()` adds:

| Tool id | Parameters | Returns |
| --- | --- | --- |
| `<id>__search_people` | `query` (required, name / e-mail / free text, ≥ 2 chars per token), optional `firstName`, `lastName`, `email`, `jobTitle`, `department`, `unit`, `maxResults` | `{ directory, results: Person[], truncated, hint? }` |
| `<id>__get_person` | `personId` (from a search result) | `Person` with all mapped fields |
| `<id>__list_units` (only with `units: true`) | — | `[{ unitId, name }]` of the search base's one-level children, cached for 1 h |

**Who sees a directory's tools.** `loadTools()` has no user, so the directory's `groups` cannot be applied there. The discovered tools carry `_peopleDirectory: { id }`, and one helper, `mayUseDirectory(user, directoryId)`, is applied wherever tools are narrowed to a user:

- `configCache.getToolsForUser`, which serves the `/api/tools` listing;
- `getToolsForApp`, which builds the chat's tool list and has `context.user`;
- `mayRunTool` (direct tool runs) and the MCP gateway permission check;
- the tool itself at execution time, as the last guard.

`groups` is ANDed with the existing grants. An app that lists `x500bund__search_people`, or a `permissions.tools: ["*"]` grant, does not hand the directory to a user outside its `groups`.

**How an app selects directories.** `isToolSelected` gains one rule: a tool with `_peopleDirectory` is selected by its directory id, or by the reserved reference `peopleDirectories`, which means every directory.

- `"tools": ["x500bund"]` gives an app all of that directory's tools.
- `"tools": ["peopleDirectories"]` gives it every enabled directory the user may use, including ones added later, without editing the app.
- Group permissions accept the same references.

The tool's name and description come from the directory's `name` and `description`, so the model sees "Federal directory (IVBB) – staff of German federal authorities…" and can decide which directory fits the question. Searching the own and the external directory is two tool calls the model makes in parallel; nothing is merged server-side, and each result says which directory it came from.

`Person`:

```json
{
  "directory": "x500bund",
  "personId": "cn=Greiner Ralf,l=Karlsruhe,ou=MRI,o=Bund,c=DE",
  "name": "Ralf Greiner",
  "firstName": "Ralf",
  "lastName": "Greiner",
  "salutation": "Herr",
  "academicTitle": "Dr.",
  "jobTitle": "Vertreter des Präsidenten",
  "department": "Leitung",
  "organization": "MRI",
  "location": "Karlsruhe",
  "email": "ralf.greiner@mri.bund.de",
  "phone": "0721 6625 - 300",
  "fax": "0721 6625 - 111",
  "mobile": null,
  "managerId": null
}
```

Fields a directory does not map are `null`, never left out, so the model can tell "unknown" from "not asked". `search_people` returns the same shape. The example is the live x500.bund.de entry and becomes a test fixture.

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
- New `Client({ url: <pinned>, timeout, connectTimeout, tlsOptions: { ...getTlsBypassOptions(url), ca: <tlsCa PEMs, if any>, ...directory.tlsOptions, servername } })`; for StartTLS `client.startTLS(buildStartTlsOptions(url, …))` with the same `ca`.
- **Certificate errors are explained.** On a verification failure, the test endpoint reports the chain the server sent: subject, issuer, validity, and the SHA-256 fingerprint of each certificate. It names the issuer that is missing ("issuer `PCA-1-Verwaltung-23` is not trusted: add it to the certificate store and to `tlsCa`"). iHub never fetches or adds a root by itself: a trust anchor is an admin decision, checked against a published fingerprint.
- One connection per call, `unbind()` in `finally`. A small pool is not worth it at chat-tool call rates.
- **Transport.** LDAPS or StartTLS is required by default, for anonymous binds too: search terms and the returned records are personal data. Plain `ldap://` needs `allowPlaintext: true` on the directory. The admin test and the admin page then show the same warning the sign-in provider shows. A service bind is never sent in plain text.
- **Throttling.** All tools of one directory, and the admin test for it, share one `throttledRun` queue keyed `peopleDirectory:<id>`, with the directory's `concurrency` and `requestDelayMs`. Calls from different tools therefore do not get separate queues. `throttledRun` resolves limits from the tool and model configs only, so it gains an optional explicit `{ concurrency, delayMs }` argument for this.
- **No per-user quota.** A user can already reach the company directory through the mail client's address book, and x500.bund.de is public. Chat turns are bounded by the tool-round limit, and the admin test sits behind `adminAuth`.
- LDAP is not HTTP: the `proxy` settings do not apply. External directories need a direct route on port 389/636 from the iHub server. This goes in the docs and in the test endpoint's error text.

### 6. Admin

All of this is phase 1.

**API**

- `GET/PUT /api/admin/people-directories` reads and writes the whole file, Zod-validated like other config files. `GET` returns bind passwords only as credential references.
- `POST /api/admin/people-directories/test` takes a saved id or an inline entry, so an unsaved form can be tested. It reports each step with `DiagnosticsReport`:
  - resolve the entry, including the inherited sign-in provider;
  - SSRF check;
  - connect, then StartTLS;
  - bind;
  - a sample search (the admin types a name);
  - the mapped `Person` of the first hits, next to the raw attributes they came from.
- `GET /api/admin/people-directories/presets` returns the presets and their mappings, so the form can show the effective value of every field the admin leaves empty. This is the pattern `describeLdapProvider` already uses for sign-in providers.
- Every route sits behind `adminAuth`, which already rejects delegated and machine principals (`isAdminEligiblePrincipal`). Personal API keys, OAuth clients and agents get a 403 before any entry is parsed or any connection is opened.

**Page:** `/admin/integrations/people-directories`, with a "People directories" card on the existing Integrations page next to Jira and Office 365. It is nested under `/admin`, so `KNOWN_ROUTES` and `client/index.html` do not change.

- **List.** One row per directory: name, source (sign-in provider name, or host), preset, enabled toggle, groups. A warning badge marks plain-text transport, and an *external* badge marks `dataFlow: external`. The shipped `x500bund` entry is listed disabled, so turning it on is one switch.
- **Editor**, with these sections:
  - **Source:** "Reuse a sign-in provider" (a select over `ldapAuth.providers`), or "Connect directly" (URL, base DN, preset, StartTLS).
  - **Access:** anonymous, or a service account whose password is chosen from the credential store, never typed into this form.
  - **Network:** `allowPlaintext` with the same warning text as the sign-in provider, `allowedHosts`, and `tlsCa` (a multi-select over the certificate store).
  - **Visibility:** `groups`, edited with the existing group picker.
  - **Model-facing:** name and description in en and de. The description is what the model reads to choose a directory, so the form shows it as the tool will.
  - **Limits:** `maxResults`, `timeoutMs`, `concurrency`, `requestDelayMs`, and `units`.
  - **Mapping:** the preset's mapping with per-field overrides, showing the effective value next to each empty field.
- **Certificates tab.** This tab manages the store in `contents/config/certs/`.
  - It lists each trust anchor with its subject, validity and SHA-256 fingerprint, and which directories use it.
  - Upload a PEM or DER file. The page shows the parsed subject and fingerprint for the admin to compare with the publisher's, before saving.
  - Remove a certificate (refused while a directory uses it).
  - A warning badge appears from 90 days before a certificate expires. The shipped BSI root runs until 2032-12-31.
  - It is a store of public certificates only. Private keys are rejected on upload.
- **Test panel**, in the editor. A name field and a "Test" button run the test endpoint against the form as it stands, and show the steps and the mapped result.
- **Shortcut on sign-in providers:** `LdapProvidersSection` gets a "Use for people search" action on each provider. It opens the editor prefilled with `authProvider` and the provider's display name.
- Strings in `shared/i18n/en.json` and `de.json`, dark mode, keyboard and screen-reader support. The axe-core and jsx-a11y checks must pass.

The directory tools appear in the existing app editor tool picker and in `groups.permissions.tools` with no extra work.

When the Unified Integrations admin section ([#2919](https://github.com/intrafind/ihub-apps/issues/2919)) lands, this page becomes the instance page of the built-in "People directory" integration. The API and the config file stay the same.

### 7. App: "People search" / "Personensuche"

A shipped app, `server/defaults/apps/people-directory.json`.

**Shipping**

- It starts with `"enabled": false`, like the other apps that need an integration first (`ifinder-search`, `iassistant`).
- Startup copies missing default files into `contents/`, so existing installations get it without a migration.
- When an admin enables a directory while the app is still disabled, the admin page offers "Also enable the *People search* app".

**Configuration**

```jsonc
{
  "id": "people-directory",
  "enabled": false,
  "order": 12,
  "category": "utility",
  "icon": "user-group",
  "color": "#1D4ED8",
  "name": { "en": "People search", "de": "Personensuche" },
  "description": {
    "en": "Find people, their function and contact details in the company directory and connected external directories",
    "de": "Personen, ihre Funktion und Kontaktdaten im Firmenverzeichnis und in angebundenen externen Verzeichnissen finden"
  },
  "tools": ["peopleDirectories"],      // every directory the user may use, including ones added later
  "sendChatHistory": true,
  "preferredOutputFormat": "markdown",
  "system": { "en": "…", "de": "…" },  // see below
  "greeting": {
    "en": { "title": "Who are you looking for?", "subtitle": "Search by name, function or authority." },
    "de": { "title": "Wen suchen Sie?", "subtitle": "Suche nach Name, Funktion oder Behörde." }
  },
  "starterPrompts": [
    { "title": { "en": "Find a colleague", "de": "Kollegin oder Kollegen finden" },
      "message": { "en": "What is the phone number of Ralf Greiner?", "de": "Wie lautet die Telefonnummer von Ralf Greiner?" } },
    { "title": { "en": "Function at an authority", "de": "Funktion in einer Behörde" },
      "message": { "en": "Who is the president's deputy at the MRI?", "de": "Wer ist Vertreter des Präsidenten am MRI?" } },
    { "title": { "en": "Search everywhere", "de": "Überall suchen" },
      "message": { "en": "Find Müller in our directory and in the federal directory.", "de": "Suche Müller in unserem Verzeichnis und im Bundesverzeichnis." } }
  ],
  "settings": { "enabled": true, "model": { "enabled": true }, "chatHistory": { "enabled": true } }
}
```

The starter prompts that name x500.bund.de people only make sense with that directory enabled. Their final wording is settled in the implementation, against the directories the default installation has.

**System prompt.** In English and German, it tells the model to:

- **Use the tools.** Never answer contact details, functions or units from memory, and never guess them. Unknown fields stay unknown (`null` means the directory has no value).
- **Choose directories by their descriptions.** Prefer the company directory. Use an external one when the question names an authority or organisation that lives there, or when the person is not found internally. When unsure, call several directories in parallel.
- **Name the source.** For every hit, say which directory it came from. Do not merge two hits from different directories into one person unless the e-mail address is identical.
- **Narrow, don't flood.** On `truncated: true`, ask for a first name, a function or an authority, or use `list_units` and `unit`. Do not page through a directory.
- **Present people as short contact cards.** Show the name with salutation and academic title ("Herr Dr. Ralf Greiner"), then function, unit and organisation, location, phone, fax and e-mail as links. Use a table for several hits.
- **Handle ambiguity.** For several plausible matches, list them briefly and ask which one is meant, instead of picking one.
- **Stay in scope.** It is a directory lookup, not a profiling tool. Do not compile lists of people by personal attributes beyond what was asked.
- **Answer in the user's language.**

The existing `examples/apps/people-search.json` (Entra) stays as it is. Phase 2 makes Entra a directory type, after which this app covers Entra too.

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
| `server/routes/admin/peopleDirectories.js` | `client/src/App.jsx` (nested admin route) |
| `client/src/features/admin/pages/AdminPeopleDirectoriesPage.jsx`, `AdminPeopleDirectoryEditPage.jsx` | `client/src/features/admin/pages/AdminIntegrationsPage.jsx` (card) |
| `client/src/features/admin/components/people-directories/` (form sections, mapping table, test panel) | `client/src/features/admin/components/platform-form/LdapProvidersSection.jsx` ("Use for people search") |
| | `shared/i18n/en.json`, `shared/i18n/de.json` |
| `server/defaults/apps/people-directory.json` | `server/utils/toolSelection.js` (`_peopleDirectory` id and `peopleDirectories` references) |
| `server/defaults/config/certs/pca-1-verwaltung-23.pem` (BSI root, fingerprint-checked) | `REUSE.toml` (`server/defaults/config/certs/*.pem`) |
| `server/services/peopleDirectory/certStore.js` (load, parse, fingerprint, expiry), admin routes for the store | |
| `examples/config/peopleDirectories.json` (corporate example via `authProvider`) | |
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
- Admin page (Playwright e2e against the default local admin):
  - enable the shipped `x500bund` entry, then disable it;
  - create a directory from a sign-in provider through "Use for people search";
  - run the test panel with a mocked directory;
  - check that the plain-text warning and the external badge appear;
  - axe-core on the list and editor pages.
- App selection: `"tools": ["peopleDirectories"]` selects every directory tool the user may use, and none of a disabled directory or one outside the user's groups. `"tools": ["x500bund"]` selects only that directory's tools. Neither reference selects a non-directory tool.
- Shipped app: `people-directory.json` passes the app schema, and is copied into an existing `contents/` on startup without a migration.
- `ivbb` mapping: the x500.bund.de entry above maps to the `Person` example in §3. That covers `title` → `academicTitle`, `role` → `jobTitle` with UTF-8 intact, and the city from the DN.
- Preset mapping against fixtures: the x500 entry above, an AD user with `manager`, an OpenLDAP `inetOrgPerson`.
- Config resolution: `authProvider` inheritance and overrides, missing provider, provider without bind account, inline password rejected by the schema.
- Groups: a user outside `groups` does not see the tool in `/api/tools`, in an app that lists it, or with a `*` grant, and is refused when the tool is called anyway.
- TLS: `getTlsBypassOptions` applied for a whitelisted host and not for another one; StartTLS `servername`.
- `tlsCa`, with the handshake tests using certificates generated in the test:
  - a server whose chain ends in a private root is accepted with that root in `tlsCa` and refused without it;
  - the refusal names the missing issuer;
  - a `tlsCa` name with path characters is rejected;
  - an uploaded private key is rejected.
- The shipped BSI root: its SHA-256 fingerprint equals the BSI-published value, and the x500.bund.de intermediate (fixture) is signed by it. These are signature checks only, not dated handshakes, so the test does not break when the server certificate expires on 2026-12-03.
- Size limit / timeout / connection refused → structured results the model can act on (mocked `ldapts` client).
- Manual (not CI): `x500bund` against the live server.

## Phases

1. **LDAP directories:** config file and schema, LDAP adapter with the three presets, dynamic tools, group enforcement, admin API with the test endpoint, the admin page with the "Use for people search" shortcut, `x500bund` shipped disabled, the shipped "People search" app (disabled until a directory is on), docs and changelog.
2. **Entra:** Entra as directory type with the `findUser` fixes, in the same admin page.
3. **Unified Integrations:** when #2912/#2973 land, a directory becomes an instance of a built-in "People directory" integration; tool ids stay.

## Open questions

1. **Server-side limit:** what size limit does x500.bund.de enforce? Run a broad query such as `(sn=M*)` with `-z 0`. The answer sets the entry's default `maxResults`.

## Decisions (2026-10-28)

- **x500 attributes:** settled from a full entry (see "What we know about x500.bund.de").
- **Reachability:** x500.bund.de is reachable from the public internet, so it ships as a disabled default entry, not only as an example.
- **TLS:** x500.bund.de serves LDAPS on 636 with a Verwaltungs-PKI certificate. The shipped entry uses `ldaps://` with full verification against the shipped, fingerprint-checked BSI root `PCA-1-Verwaltung-23`, so no `allowPlaintext` is needed.
- **Admin page:** part of phase 1, not deferred to the Unified Integrations admin section.
- **App:** a shipped "People search" app (`people-directory`) selects every directory through `peopleDirectories`, so it does not need editing when directories are added.
- **Search fan-out:** the model decides which directories to search and calls them separately. There is no server-side merge.
- **Per-user quota:** none. A shared per-directory queue covers concurrency (review discussion on the PR).
