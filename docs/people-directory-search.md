# People Directory Search

Users can ask iHub's chat for people: who someone is, their function, their unit and how to reach them. iHub searches **people directories** for that: the company's own LDAP or Active Directory, and any number of further directories such as the public directory of the German federal administration, **x500.bund.de**.

A directory is an **installation** of the built-in integration **LDAP people directory** (`com.intrafind/ldap-directory`) under **Admin → Integrations → Installed** — one installation per directory, installed, tested, edited and switched on and off like every other [integration](integrations.md). Each enabled directory becomes its own small set of read-only tools, named and described after the directory. The model reads those descriptions, decides which directory fits a question, and calls several when it needs to — for example the company directory and x500.bund.de in one answer. Nothing is merged server-side: every result says which directory it came from.

The shipped **People search** app (`people-directory`) binds the definition — `"integrations": { "com.intrafind/ldap-directory": {} }` — and so uses every directory a user may use, including ones installed later. It ships enabled; users get it as soon as one directory installation is enabled, and not before. Admin → Apps marks it as hidden until then.

> Microsoft Entra ID is not a directory type of this integration. The Entra people search is the built-in installed integration **Microsoft Entra ID directory** (installation `entra`); see [Tool Calling](tool-calling.md#entrapeoplesearch).

## Quick start

### Search x500.bund.de

The directory of the German federal administration is reachable from the public internet and ships as a disabled installation, `x500bund`.

1. Open **Admin → Integrations → Installed**.
2. Enable **Federal directory (IVBB)** (`x500bund`). The **People search** app appears for users with the first enabled directory.
3. Optional: **Test** the installation. The install dialog's test takes a surname as the sample search and shows the mapped people next to the attributes they came from.

The iHub server needs a direct route to `x500.bund.de` on port 636 (LDAP does not use the HTTP proxy). The installation trusts the Verwaltungs-PKI root shipped with iHub (see [Certificates](#certificates)).

### Search the company directory

If LDAP sign-in is configured, the company directory needs one click:

1. Open **Admin → Authentication → LDAP** and choose **Use for people search** on the provider.
2. The install wizard of the LDAP people directory opens with the provider selected and its display name as the label. Check the label and the description (the model reads both), the groups who may use it, test, and install.

The directory reuses the provider's URL, base DN, preset, TLS version settings and bind account. A search cannot run "as the user", because iHub never keeps a user's LDAP password, so the provider needs a **bind account** — or the directory sets **Access** to anonymous when the directory allows anonymous search (Active Directory normally does not).

## Configuration

Directories live in `contents/config/integrations.json` as installations of `com.intrafind/ldap-directory`, edited in the install wizard. Changes take effect without a restart.

```jsonc
{
  "installed": [
    {
      // Company directory: reuses an LDAP sign-in provider
      "id": "corp",
      "definition": "com.intrafind/ldap-directory",
      "enabled": true,
      "label": { "en": "Company directory", "de": "Firmenverzeichnis" },
      "description": {
        "en": "Employees of our company: name, e-mail, phone, department, manager.",
        "de": "Mitarbeitende unseres Unternehmens: Name, E-Mail, Telefon, Abteilung, Vorgesetzte."
      },
      "values": { "authProvider": "corp-ad" }, // name in platform.json ldapAuth.providers[]
      "auth": { "mode": "none" },
      "allowedGroups": ["authenticated"]
    },
    {
      // External and anonymous: everything stated here (shipped, disabled)
      "id": "x500bund",
      "definition": "com.intrafind/ldap-directory",
      "enabled": false,
      "label": { "en": "Federal directory (IVBB)", "de": "Verzeichnisdienst des Bundes (IVBB)" },
      "description": { "en": "Public directory of German federal authorities …" },
      "values": {
        "url": "ldaps://x500.bund.de:636",
        "tlsCa": ["pca-1-verwaltung-23"],
        "baseDn": "o=Bund,c=DE",
        "preset": "ivbb",
        "bindMode": "anonymous",
        "dataFlow": "external",
        "units": true,
        "maxResults": 25,
        "timeoutMs": 8000
      },
      "auth": { "mode": "none" },
      "allowedGroups": ["authenticated"]
    }
  ]
}
```

The installation's **label** is the directory's name and its **description** the model-facing description, each per language (the wizard edits the current language). `allowedGroups` are the groups who may use the directory; empty means every caller who may use an app that binds it. The install values (**Settings** in the wizard; fields marked _advanced_ are folded away):

| Value | Meaning |
| --- | --- |
| `id` (the installation id) | Letters, digits, dots, hyphens and underscores, never `__`. Becomes the tool id prefix (`<id>__search_people`). Installation ids are unique, so a directory cannot take the id of an MCP server, an agent or another integration. |
| `authProvider` | Name of an `ldapAuth.providers[]` entry. Inherits `url`, `starttls`, TLS version settings, `baseDn`, `preset` and the bind account. Any value set here overrides the inherited one. |
| `url`, `starttls`, `baseDn`, `preset` | As for a sign-in provider; required without `authProvider`. Presets: `openldap`, `activeDirectory`, `ivbb`. |
| `tlsMinVersion`, `tlsMaxVersion`, `tlsCiphers` | The only TLS settings a directory may change. Verification itself cannot be weakened here; from a sign-in provider only these keys are taken over, others are ignored, and the test says so. |
| `bindMode`, `bindDn`, `bindPasswordRef` | **Access**: `anonymous`, or `service` with the bind DN and a credential of type secret holding the password (**Admin → Credentials**); passwords are never stored in the installation. Empty: the provider's bind account, or anonymous without a provider. |
| `searchBase` | Where people are searched. Defaults to `baseDn` (or the provider's user search base). |
| `personFilter`, `searchAttributes`, `mapping_<field>` | Override the preset (see [Presets](#presets-and-mapping)); one `mapping_` list per `Person` field. |
| `units` | Offer `list_units` and the `unit` parameter: the one-level children of the search base (authorities in x500.bund.de). |
| `allowPlaintext` | Default off. A plain `ldap://` URL without StartTLS is refused unless this is on, anonymous binds included. A service bind is never sent in plain text. |
| `tlsCa` | Names of [trust anchors](#certificates) in `contents/config/certs/<name>.pem`. When set, only these anchors are trusted for this directory, and verification stays on — unless the host is on the platform's SSL whitelist, which switches verification off for every connection to it. When unset, Node's default roots and the server's operating system certificate store are used. |
| `allowedHosts` | Hosts this directory may reach although they resolve to a private address (`*.corp.example` patterns allowed). |
| `maxResults` | Default 10, at most 50. The most people one search returns; a tool call can ask for fewer, never more. |
| `timeoutMs` | Default 8000, at most 30000. |
| `concurrency`, `requestDelayMs` | Default 2 and 0. One queue per directory, shared by all its tools and its test. |
| `dataFlow` | `internal` (default) or `external`: the search terms leave your network. Shown as a badge on the installed list and carried on the tools. |
| `browse`, `browse*` | The admin [LDAP browser](#ldap-browser-for-admins) of this directory. Off unless `browse` is on. |

## Tools

For each enabled directory a user may use:

| Tool | Parameters | Returns |
| --- | --- | --- |
| `<id>__search_people` | `query` (required: name, e-mail or a few words, at least 2 characters per word); optional `firstName`, `lastName`, `email`, `jobTitle`, `department` (prefix matches, offered when the preset maps them), `unit`, `maxResults` (1 to the directory's `maxResults`) | `{ directory, results: Person[], truncated, hint? }` |
| `<id>__get_person` | `personId` from a search result | `Person` |
| `<id>__list_units` (with `units`) | — | `{ directory, units: [{ unitId, name }], truncated }`, cached for an hour |

A `Person` always has every field; a field the directory has no value for is `null`:

```json
{
  "directory": "x500bund",
  "personId": "cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE",
  "name": "Erika Mustermann",
  "firstName": "Erika",
  "lastName": "Mustermann",
  "salutation": "Frau",
  "academicTitle": "Dr.",
  "jobTitle": "Vertreterin des Präsidenten",
  "department": "Leitung",
  "organization": "MRI",
  "location": "Karlsruhe",
  "email": "erika.mustermann@example.org",
  "phone": "0721 0000 - 300",
  "fax": "0721 0000 - 111",
  "mobile": null,
  "managerId": null
}
```

How a search works:

- The model never sends an LDAP filter. iHub builds it from the words and fields, with every value escaped (RFC 4515). Each word is matched anywhere in the preset's name attributes; one-letter words are ignored.
- Only mapped attributes are requested — never `*` — so certificates, photos and password hashes never leave the directory.
- When more people match than `maxResults`, or the server stops at its own size limit, the result is partial: `truncated: true` and a hint to narrow the search.
- `get_person` only reads entries inside the directory's search base. The check works on parsed DNs, so an escaped comma or a look-alike suffix cannot reach other parts of the directory.
- `unit` must be one of `list_units`' ids. When the server's own size limit cuts the unit list short (`truncated: true`), a unit id beyond the cut (`ou=Name`) is looked up as a direct child of the search base instead. The id is parsed and written back escaped, so the argument itself never becomes part of a DN.
- Errors come back as `{ directory, error: { code, message } }` the model can act on (`invalid_arguments`, `timeout`, `connection_refused`, …), without internal host names.

### Binding directories to an app

An app binds directories under `integrations` (**Admin → Apps → Edit → Installed integrations**):

- `"integrations": { "com.intrafind/ldap-directory": {} }` — the row **All LDAP people directory installations**: every directory, including ones installed later (the shipped app uses this);
- `"integrations": { "x500bund": {} }` — one directory, all of its search tools; `{ "actions": ["search_people"] }` narrows it;
- both together: the installation's own binding wins for that directory.

A group's `permissions.tools` still selects a directory's tools by the directory id (`"x500bund"`) or an exact tool id (`"x500bund__search_people"`), and an `app.tools` entry naming a directory id keeps working for apps written that way.

The installation's `allowedGroups` hold on top of that: an app that binds `x500bund`, or a `"*"` tool grant, does not give the directory to a user outside its groups. Inherited groups count (`admins` inherit `users`). The check runs in the tools listing, an app's tools, direct tool runs, the MCP gateway, and again when the tool runs.

## LDAP browser (for admins)

Admins sometimes need to see what is really in a directory: which attributes an entry has, how a branch is built, who is in a group. The LDAP browser answers that in plain words: the admin asks, the model writes the LDAP filter, and the raw entries come back. It is separate from people search, which only ever returns mapped fields and is safe to give to every user.

Switch it on per directory with **LDAP browser for admins** in the install wizard (**Admin → Integrations → Installed → the directory → Edit**); the browser's own fields appear below the switch. In `integrations.json`:

```jsonc
{
  "id": "corp",
  "definition": "com.intrafind/ldap-directory",
  "allowedGroups": ["authenticated"],
  "values": {
    "authProvider": "corp-ad",
    "browse": true,                        // default false
    "browseGroups": ["admins"],            // default; "*" is refused
    "browseMaxResults": 50,                // default 50, at most 200
    "browseBase": "dc=corp,dc=example",    // default: the directory's baseDn
    "browseBindMode": "service",
    "browseBindDn": "cn=ldap-reader,dc=corp,dc=example",
    "browseBindPasswordRef": "ldap-reader",
    "browseDenyAttributes": ["info"]       // withheld on top of the built-in list
  }
}
```

| Field | Meaning |
| --- | --- |
| `browse` | The browse tools exist only while this is on and the directory itself is enabled and usable. |
| `browseGroups` | Who may browse. Separate from the installation's `allowedGroups`: neither grants the other. Only signed-in users; `"*"` is refused. Personal API keys, OAuth clients and tokens and agents never browse, whatever their groups, so the browser cannot be reached through an app over MCP, A2A or the chat API. A browse-only directory switches its search actions off in the wizard's **Actions** step. |
| `browseMaxResults` | The most entries one search returns. |
| `browseBase` | The DN the browser is confined to. Defaults to the directory's base DN — the whole directory, not just the people search base — so groups and other branches are in reach. Set a narrower branch to limit what admins can see. |
| `browseBindMode`, `browseBindDn`, `browseBindPasswordRef` | A separate account for browsing, same shape as the directory's access. **Without it, the browser reads whatever the directory's bind account can read**, minus the deny list. Use a read-only account with the reach you want. |
| `browseDenyAttributes` | Attribute names withheld for this directory, on top of the built-in list. |

The browse actions are marked `bindExplicitly` in the definition: a binding of a directory (or of all directories) without `actions` never includes them. The shipped **LDAP browser** app (`ldap-browser`) binds them for every directory with `"integrations": { "com.intrafind/ldap-directory": { "actions": ["browse_search", "browse_read", "browse_children"] } }`; `"tools": ["ldapBrowse"]` still selects them too. It ships **disabled**; enable it under **Admin → Apps**. Users outside the browser groups who open it get no browse tools, so restrict the app to admins in **Admin → Groups** as well.

### Browse tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `<id>__browse_search` | `filter` (required, RFC 4515, e.g. `(&(objectClass=group)(cn=*admin*))`), `base` (a DN inside the browse base), `scope` (`base`, `one` or `sub`, default `sub`), `attributes` (names; default all user attributes), `maxResults` | `{ directory, base, scope, entries: [{ dn, attributes, omitted? }], truncated, hint? }` |
| `<id>__browse_read` | `dn` (required), `attributes` | `{ directory, entry: { dn, attributes, omitted? } }` |
| `<id>__browse_children` | `dn` (default: the browse base) | `{ directory, dn, children: [{ dn, rdn, objectClass }], truncated }` |

- Values come back as the server returns them, every attribute as a list. Binary values are shown as `[binary, N bytes]`; values over 500 characters are cut with their length. An attribute returns at most 100 values (a large group's `member`, for example); a cut attribute ends with `… (N more values)` and is named in the entry's `cut` list. One response holds about 30,000 characters, and so does a single entry; beyond that, or beyond `maxResults` or the server's own size limit, `truncated` is `true`.
- Operational attributes (`memberOf`, `createTimestamp`, …) come only when named in `attributes`.
- Every DN — the search base, the entry read, the parent listed, and every entry returned — must lie in the browse base. The check works on parsed DNs, like `get_person`'s.
- The browse tools are reachable only through a binding that names them, `ldapBrowse` or their exact ids: not through a directory id or a binding of the directory alone, so the People search app never gets them. They are never offered over iHub's MCP gateway.

### Secrets

These attributes never leave a directory — not in people search, not in the browser: `userPassword`, `unicodePwd`, `ntPassword`, `lmPassword`, `sambaNTPassword`, `sambaLMPassword`, `krbPrincipalKey`, `supplementalCredentials`, `dBCSPwd`, `unixUserPassword`, the password histories `pwdHistory` and `sambaPasswordHistory`, FreeIPA's `ipaNTHash`, the LAPS passwords (`ms-Mcs-AdmPwd`, `msLAPS-Password`, `msLAPS-EncryptedPassword` and their history and DSRM variants), `msFVE-RecoveryPassword`, `msDS-ManagedPassword`, certificates (`userCertificate`, `userSMIMECertificate`, `userPKCS12`, `cACertificate`, revocation lists), photos (`jpegPhoto`, `thumbnailPhoto`), `objectSid` and `objectGUID`. Names are compared case-insensitively and without options (`userPassword;binary`).

- In results, a withheld attribute is left out and named in the entry's `omitted` list.
- A filter that names one, anywhere — nested, negated, in an extensible match — is refused before anything is sent, so a value cannot be guessed one character at a time with `(userPassword=a*)`. An extensible match without an attribute type (`(:caseExactMatch:=x)`) is refused for the same reason, and so is a filter that does not parse.
- The list holds names only. A site that keeps secrets in custom attributes adds them to `browseDenyAttributes`.

### Audit

Every browse call — answered, refused for a bad argument, or refused for lack of access — writes an audit record (**Admin → Audit log**, resource `ldapBrowse`, the directory id as resource id). It holds the user, the tool, the filter, base, scope, DN and attributes asked for (text cut at 1,000 characters, at most 50 attribute names), how many entries came back and whether the result was truncated. Entry values are never written. Filters are recorded as sent and can contain names or e-mail addresses; they follow the audit log's retention.

## Presets and mapping

| | `openldap` | `activeDirectory` | `ivbb` (x500.bund.de) |
| --- | --- | --- | --- |
| People | `(objectClass=inetOrgPerson)` | enabled user accounts | `(objectClass=ivbbPerson)` |
| Words matched in | `cn`, `sn`, `givenName`, `displayName`, `mail`, `uid` | `cn`, `sn`, `givenName`, `displayName`, `mail`, `sAMAccountName` | `cn`, `sn`, `givenName`, `mail` |
| `name` | `displayName` → `givenName sn` → `cn` | same | `givenName sn` → `cn` |
| `jobTitle` | `title` | `title` | `role` |
| `academicTitle` | — | — | `title` |
| `salutation` | — | — | `vocation` |
| `organization` | `o` | `company` | `company` → DN `ou` |
| `department` | `ou`, `departmentNumber` | `department` | `gouvernmentOrganizationalUnit` |
| `location` | `l`, `physicalDeliveryOfficeName` | `physicalDeliveryOfficeName`, `l` | DN `l` → `l` |
| `phone`, `fax`, `mobile` | `telephoneNumber`, `facsimileTelephoneNumber`, `mobile` | same | `telephoneNumber`, `facsimileTelephoneNumber`, — |
| `managerId` | — | `manager` | — |

The same attribute means different things per directory: `title` is the job title in OpenLDAP and Active Directory, but the academic title ("Dr.") in the IVBB directory, whose function is `role`.

The `mapping_<field>` values (under **Advanced** in the wizard, one list per `Person` field) override a field with one or more sources, tried in order:

- an attribute: `"mail"`;
- a DN component: `"dn:l"` (the entry's `l=` RDN);
- attributes joined with a space: `"givenName sn"` (only when all have a value).

## Network and security

Every connection is checked when it is opened, not only when the configuration is saved:

- **Transport.** `ldaps://` or StartTLS is required; plain `ldap://` needs `allowPlaintext` and shows the same warning as a plain-text sign-in provider. A service bind is never sent in plain text.
- **Address check.** The host is resolved and every address classified. A private, loopback or link-local address is refused unless the host is allowed explicitly: the installation's `allowedHosts`, the platform-wide `ssrf.allowedHosts` (Admin → Security), or the host of the referenced sign-in provider. The socket then connects to the checked address, so a DNS change cannot redirect it; TLS still checks the certificate against the host name.
- **Certificates.** Verification is always on. Private CAs are trusted through the server's certificate store, or per directory with `tlsCa`. The only way to switch verification off is the platform's SSL whitelist (`ssl.ignoreInvalidCertificates` with the host in `ssl.domainWhitelist`), like every other outbound connection; a sign-in provider's `rejectUnauthorized: false` is ignored here.
- **No proxy.** LDAP is not HTTP. External directories need a direct route on port 389 or 636.
- **Data protection.** Directory tools are read-only. Searches are logged with directory, user, result count and duration; the search text only at debug level. LDAP browser calls also go to the audit log, filter included (see [Audit](#audit)). External directories are marked `dataFlow: external`.

## Certificates

People directories trust the same roots as every other outbound connection: Node's built-in roots and the operating system certificate store of the iHub server (see [SSL Certificates](ssl-certificates.md)). A company CA installed on the server, or added with `NODE_EXTRA_CA_CERTS`, works without further configuration.

For a CA you do not want to trust server-wide, put its PEM file into `contents/config/certs/<name>.pem` and list `<name>` under **Trusted certificates** (`tlsCa`, under **Advanced**) of the installation. Only those anchors then verify that directory's server, and no other connection trusts them. Compare the certificate's fingerprint with the one its publisher states before you add it. A shipped certificate comes back on the next start if it is deleted.

iHub never fetches or trusts a root on its own. When a server's certificate is not trusted, the connection test names the issuer that is missing.

### The shipped Verwaltungs-PKI root

x500.bund.de presents `CN=x500.bund.de`, issued by `CN=CA IVBB Deutsche Telekom AG 23` (sent by the server), issued by the root `CN=PCA-1-Verwaltung-23, O=PKI-1-Verwaltung`. The root is in no public trust store, so iHub ships it as `pca-1-verwaltung-23`, taken from the BSI download and checked against the [published fingerprint](https://www.bsi.bund.de/EN/Themen/Oeffentliche-Verwaltung/Moderner-Staat/Verwaltungs-PKI/Wurzelzertifizierungsstelle/FingerprintsderWurzelzertifikate/pcafingerprint.html):

```
SHA-256 1D:32:84:79:E1:65:FD:36:FB:C2:7E:1D:53:11:68:D1:3D:60:D6:6F:A1:9B:1B:81:80:36:C2:68:2D:18:DD:D4
Serial  A5EF9230, valid until 2032-12-31
```

It is trusted only by directories that name it in `tlsCa`.

## x500.bund.de

- `ldaps://x500.bund.de:636`, anonymous bind, base `o=Bund,c=DE`, layout `ou=<authority>` → optional `l=<city>` → person.
- Person entries are `ivbbPerson`. Names in `cn` and `displayName` are surname first, so the name is built from `givenName sn`.
- The server withholds some attributes from anonymous clients ("entry incomplete"); the city is read from the DN.
- It is a public server with its own size limit. Broad searches come back as partial results; narrow by first name, function or authority (`list_units`).

## Admin page

**Admin → Integrations → Installed** (`/admin/integrations/installed`) lists the directories among the other installations:

- **List:** one row per installation with its label, the definition, an on/off switch, **Test**, **Edit** and **Remove**; badges for the transport (LDAPS, StartTLS, plain text) and for external data flow.
- **Install wizard:** **Install** on the **LDAP people directory** catalog card (or **Use for people search** on an LDAP sign-in provider). Name and description; the settings — source (reuse a sign-in provider, or connect directly), access (anonymous, or a service account whose password comes from the credential store), units, data flow and the [LDAP browser](#ldap-browser-for-admins); under **Advanced** the search base, filter, searched attributes, the mapping with one list per field, TLS versions, trusted certificates, allowed hosts and the limits; who may use it; and the actions.
- **Test:** runs the connection test on the form as it stands — effective configuration, address check, connect, StartTLS, bind, and with a name in the sample-search field next to the button, a search with the mapped people next to the attributes they came from. Nothing is saved.

The admin API is the [integrations API](integrations.md#api): `POST /api/admin/integrations/catalog/com.intrafind%2Fldap-directory/_test` tests an unsaved directory (`testInput: { "query": "Mustermann" }` runs the sample search), `POST /api/admin/integrations/installed/<id>/_test` a saved one. The former `/api/admin/people-directories*` routes are gone (migration V198).

## Troubleshooting

| Test result | What to do |
| --- | --- |
| *issuer "…" is not trusted* | Get the named root from its publisher and compare the fingerprint. Install it in the server's operating system certificate store, or put it into `contents/config/certs/<name>.pem` and add `<name>` to the directory's trusted certificates. |
| *resolves to the private address …* | Add the host to the installation's allowed hosts or to `ssrf.allowedHosts`, or reuse the sign-in provider that connects to it. |
| *did not answer in time* | The iHub server has no route to the directory on that port; LDAP does not use the HTTP proxy. |
| *rejected an anonymous bind* / no results from Active Directory | Configure a service account; Active Directory does not allow anonymous search. |
| *has no bind account* | The referenced sign-in provider binds as the user. Add a bind account to it, or set the directory's access to anonymous. |
| Results marked `truncated` | Expected for broad searches; narrow the search, or raise `maxResults` (at most 50). |
