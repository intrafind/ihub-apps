# People Directory Search

Users can ask iHub's chat for people: who someone is, their function, their unit and how to reach them. iHub searches **people directories** for that: the company's own LDAP or Active Directory, and any number of further directories such as the public directory of the German federal administration, **x500.bund.de**.

A directory is an **installation** of the built-in integration **People directory (LDAP)** (`com.intrafind/ldap-directory`) under **Admin → Integrations** — one installation per directory, installed, tested, edited and switched on and off like every other [integration](integrations.md). Each enabled directory becomes its own small set of read-only tools, named and described after the directory. The model reads those descriptions, decides which directory fits a question, and calls several when it needs to — for example the company directory and x500.bund.de in one answer. Nothing is merged server-side: every result says which directory it came from.

People directories are an [integration type](integrations.md#the-integrations-page) (`people-directory`): the LDAP directories and the built-in **Microsoft Entra ID directory** (installation `entra`, see [Tool Calling](tool-calling.md#entrapeoplesearch)) are listed together under **People directories** on the Integrations page and in the app editor.

The shipped **People search** app (`people-directory`) binds the type — `"integrations": { "type:people-directory": {} }` — and so uses every people directory a user may use, LDAP and Entra ID, including ones installed later. It ships enabled; users get it as soon as one people directory installation is enabled, and not before. Admin → Apps marks it as hidden until then.

The admin [LDAP browser](#ldap-browser-for-admins), which shows raw entries, is an integration of its own (**LDAP browser**, `com.intrafind/ldap-browser`) that reuses a directory's connection.

## Quick start

### Search x500.bund.de

The directory of the German federal administration is reachable from the public internet and ships as a disabled installation, `x500bund`.

1. Open **Admin → Integrations**.
2. Enable **Federal directory (IVBB)** (`x500bund`). The **People search** app appears for users with the first enabled directory.
3. Optional: **Test** the installation. The install dialog's test takes a surname as the sample search and shows the mapped people next to the attributes they came from.

The iHub server needs a direct route to `x500.bund.de` on port 636 (LDAP does not use the HTTP proxy). The installation trusts the Verwaltungs-PKI root shipped with iHub (see [Certificates](#certificates)).

### Search the company directory

If LDAP sign-in is configured, the company directory needs one click:

1. Open **Admin → Authentication → LDAP** and choose **Use for people search** on the provider.
2. The install wizard of **People directory (LDAP)** opens with the provider selected and its display name as the label. Check the label and the description (the model reads both), test, and install.
3. Grant the directory to the groups who may use it (**Admin → Groups → Integrations**), unless they already hold `*` or **All people directories**.
4. Fine-tune it on its page (**Admin → Integrations → the directory → Settings**), the [directory editor](#admin-page).

The directory reuses the provider's URL, base DN, preset, TLS version settings and bind account. A search cannot run "as the user", because iHub never keeps a user's LDAP password, so the provider needs a **bind account** — or the directory sets **Access** to anonymous when the directory allows anonymous search (Active Directory normally does not).

## Configuration

Directories live in `contents/config/integrations.json` as installations of `com.intrafind/ldap-directory`, installed with the install wizard and edited in the [directory editor](#admin-page). Changes take effect without a restart.

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
      "auth": { "mode": "none" }
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
      "auth": { "mode": "none" }
    }
  ]
}
```

The installation's **label** is the directory's name and its **description** the model-facing description, each per language (the directory editor edits English and German side by side). Who may use a directory is granted on the groups (`groups.json` → `permissions.integrations`): the directory's id (`x500bund`), the definition (`com.intrafind/ldap-directory`, every LDAP directory) or `type:people-directory` (every people directory, Entra included). The shipped groups grant every installation to signed-in users and none of the directories to anonymous callers. See [Integrations → Who may use an integration](integrations.md#who-may-use-an-integration). The install values (fields marked _advanced_ are folded away in the install wizard):

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

The admin LDAP browser is not a value of the directory any more: it is an installation of [LDAP browser](#ldap-browser-for-admins) that names the directory (migration V205 moved the former `browse*` values there).

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

An app binds directories under `integrations` (**Admin → Apps → Edit → Integrations → People directories**):

- `"integrations": { "type:people-directory": {} }` — the row **All people directories**: every people directory, LDAP and Entra ID, including ones installed later (the shipped People search app uses this);
- `"integrations": { "com.intrafind/ldap-directory": {} }` — every LDAP directory, including ones installed later (offered as **All People directory (LDAP) installations** when two or more are installed);
- `"integrations": { "x500bund": {} }` — one directory, all of its search tools; `{ "actions": ["search_people"] }` narrows it;
- both together: the installation's own binding wins for that directory.

A group's `permissions.tools` still selects a directory's tools by the directory id (`"x500bund"`) or an exact tool id (`"x500bund__search_people"`), The app's former `tools` list is gone (#3275): migration V229 turned a directory id in it into a binding of that installation.

The group grant (`permissions.integrations`) holds on top of that: an app that binds `x500bund`, or a `"*"` tool grant, does not give the directory to a user whose groups do not grant it. Inherited grants count (`admins` inherit `users`). The check runs in the tools listing, an app's tools, direct tool runs, the MCP gateway, and again when the tool runs.

## LDAP browser (for admins)

Admins sometimes need to see what is really in a directory: which attributes an entry has, how a branch is built, who is in a group. The LDAP browser answers that in plain words: the admin asks, the model writes the LDAP filter, and the raw entries come back. It is separate from people search, which only ever returns mapped fields and is safe to give to every user.

The browser is a built-in integration of its own, **LDAP browser** (`com.intrafind/ldap-browser`), installed any number of times. An installation names a **People directory (LDAP)** installation and reuses its connection: the URL, StartTLS, TLS versions, trusted certificates, allowed hosts, the reused sign-in provider, the base DN and — unless the browser has an account of its own — the bind account. The directory must be installed and enabled; with the directory off, its browsers offer no tools. A browse-only directory switches its search actions off (**Actions** in its editor).

Install it under **Admin → Integrations → Catalog → LDAP browser**: pick the directory, then refine it on its page (**Settings**: the [browser editor](#admin-page)). In `integrations.json`:

```jsonc
{
  "id": "corp-browser",
  "definition": "com.intrafind/ldap-browser",
  "enabled": true,
  "label": { "en": "Company directory – LDAP browser" },
  "values": {
    "directory": "corp",                        // a com.intrafind/ldap-directory installation
    "baseDn": "dc=corp,dc=example",             // default: the directory's base DN
    "maxResults": 50,                           // default 50, at most 200
    "bindMode": "service",                      // empty: the directory's bind
    "bindDn": "cn=ldap-reader,dc=corp,dc=example",
    "bindPasswordRef": "ldap-reader",
    "denyAttributes": ["info"]                  // withheld on top of the built-in list
  }
}
```

| Field | Meaning |
| --- | --- |
| `directory` | Required. The People directory (LDAP) installation whose connection the browser uses. |
| `baseDn` | The DN the browser is confined to. Defaults to the directory's base DN — the whole directory, not just the people search base — so groups and other branches are in reach. Set a narrower branch to limit what admins can see. |
| `maxResults` | The most entries one search returns. |
| `bindMode`, `bindDn`, `bindPasswordRef` | A separate account for browsing: `anonymous`, or `service` with the bind DN and a credential of type secret holding the password. **Without it, the browser reads whatever the directory's bind account can read**, minus the deny list. Use a read-only account with the reach you want. |
| `denyAttributes` | Attribute names withheld for this browser, on top of the built-in list. |

**Who may browse** is the browser installation's grant on the groups (`permissions.integrations`): its id (`corp-browser`) or `com.intrafind/ldap-browser` (every browser). The directory's own grant is not needed. On top of the grant:

- only signed-in users browse; personal API keys, OAuth clients and tokens and agents never do, whatever their groups, so the browser cannot be reached through an app over MCP, A2A or the chat API;
- the tools are never offered over iHub's MCP gateway.

> **`*` grants every installation, the browser included.** The shipped `users` and `authenticated` groups hold `"*"` in `permissions.integrations`. Raw directory entries are not for every user: give those groups the installations they need instead of `"*"`, or keep the browser out of their apps (the shipped **LDAP browser** app ships disabled; restrict it to admin groups under **Admin → Groups**).

**Binding.** An app binds a browser like any installation: `"integrations": { "corp-browser": {} }` binds its three browse actions (a browser binding without `actions` binds all three; `{ "actions": ["browse_read"] }` narrows it), `"integrations": { "com.intrafind/ldap-browser": {} }` every browser, including later ones. The shipped **LDAP browser** app (`ldap-browser`) binds the definition. A binding of a directory, of `com.intrafind/ldap-directory` or of `type:people-directory` never includes a browser: the `ldapBrowse` reference is retired.

**Migration V205** turned every directory that had the browser switched on (`browse: true`) into a browser installation `<directory id>-browser` (a numbered suffix when the id was taken), enabled like the directory and labelled "<directory label> – LDAP browser". Its groups (`browseGroups`, `admins` when empty) were granted the browser; an unknown group was skipped with a warning, and the log names the groups that hold `*` and may now browse. App bindings and `tools` entries of the browse actions were rewritten to bind the browser.

### Browse tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `<browserId>__browse_search` | `filter` (required, RFC 4515, e.g. `(&(objectClass=group)(cn=*admin*))`), `base` (a DN inside the browse base), `scope` (`base`, `one` or `sub`, default `sub`), `attributes` (names; default all user attributes), `maxResults` | `{ directory, base, scope, entries: [{ dn, attributes, omitted? }], truncated, hint? }` |
| `<browserId>__browse_read` | `dn` (required), `attributes` | `{ directory, entry: { dn, attributes, omitted? } }` |
| `<browserId>__browse_children` | `dn` (default: the browse base) | `{ directory, dn, children: [{ dn, rdn, objectClass }], truncated }` |

`directory` in a result is the id of the directory the browser reads. Each tool's description names the browser, the directory and the browse base, so the model can tell several browsers apart.

- Values come back as the server returns them, every attribute as a list. Binary values are shown as `[binary, N bytes]`; values over 500 characters are cut with their length. An attribute returns at most 100 values (a large group's `member`, for example); a cut attribute ends with `… (N more values)` and is named in the entry's `cut` list. One response holds about 30,000 characters, and so does a single entry; beyond that, or beyond `maxResults` or the server's own size limit, `truncated` is `true`.
- Operational attributes (`memberOf`, `createTimestamp`, …) come only when named in `attributes`.
- Every DN — the search base, the entry read, the parent listed, and every entry returned — must lie in the browse base. The check works on parsed DNs, like `get_person`'s.
- The browse tools are reachable only through a binding of the browser installation or of `com.intrafind/ldap-browser`: not through a directory id or a binding of a directory, so the People search app never gets them. They are never offered over iHub's MCP gateway. Every call — like the people search — goes through the throttle queue of the directory the browser reads.

### Secrets

These attributes never leave a directory — not in people search, not in the browser: `userPassword`, `unicodePwd`, `ntPassword`, `lmPassword`, `sambaNTPassword`, `sambaLMPassword`, `krbPrincipalKey`, `supplementalCredentials`, `dBCSPwd`, `unixUserPassword`, the password histories `pwdHistory` and `sambaPasswordHistory`, FreeIPA's `ipaNTHash`, the LAPS passwords (`ms-Mcs-AdmPwd`, `msLAPS-Password`, `msLAPS-EncryptedPassword` and their history and DSRM variants), `msFVE-RecoveryPassword`, `msDS-ManagedPassword`, certificates (`userCertificate`, `userSMIMECertificate`, `userPKCS12`, `cACertificate`, revocation lists), photos (`jpegPhoto`, `thumbnailPhoto`), `objectSid` and `objectGUID`. Names are compared case-insensitively and without options (`userPassword;binary`).

- In results, a withheld attribute is left out and named in the entry's `omitted` list.
- A filter that names one, anywhere — nested, negated, in an extensible match — is refused before anything is sent, so a value cannot be guessed one character at a time with `(userPassword=a*)`. An extensible match without an attribute type (`(:caseExactMatch:=x)`) is refused for the same reason, and so is a filter that does not parse.
- The list holds names only. A site that keeps secrets in custom attributes adds them to the browser's `denyAttributes`.

### Audit

Every browse call — answered, refused for a bad argument, or refused for lack of access — writes an audit record (**Admin → Audit log**, resource `ldapBrowse`, the browser installation id as resource id). It holds the user, the tool, the directory, the filter, base, scope, DN and attributes asked for (text cut at 1,000 characters, at most 50 attribute names), how many entries came back and whether the result was truncated. Entry values are never written. Filters are recorded as sent and can contain names or e-mail addresses; they follow the audit log's retention.

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

**Admin → Integrations** (`/admin/integrations`) lists the directories under **People directories**, next to the Entra ID directory; the LDAP browsers are among the **Built-in** integrations.

- **Tiles:** one per installation with its label, the definition, its state, **Test**, **Edit** and **Remove**; the facts that matter (directory URL or the sign-in provider it reuses, base DN, whether the bind password is set, the directory type; for a browser: its directory, browse base, account and result limit) and badges for the transport (LDAPS, StartTLS, plain text) and for external data flow.
- **Install wizard:** **Install** on the **People directory (LDAP)** catalog card (or **Use for people search** on an LDAP sign-in provider, which opens it with the provider selected and its display name as the label), or on the **LDAP browser** card. It holds the definition's fields; the dedicated editor below is the place to refine an installation.
- **Directory editor** (the directory's page → **Settings**):
  - **Model-facing name and description**, in English and German, with a preview of what the model sees and the tool ids;
  - **Source:** reuse a sign-in provider (its URL, base DN, type and bind account are shown, each can be overridden) or connect directly;
  - **Access:** the provider's bind account, anonymous, or a service account whose password is a credential from **Admin → Credentials**;
  - **Network:** the transport, plain text (with the warning), hosts allowed on private addresses, trusted certificates, and folded away TLS versions and cipher suites;
  - **Visibility:** the groups that grant the directory (edited on **Admin → Groups**) and the data flow;
  - **Limits** and units; **Search and mapping** with the preset's value next to every field; **Actions**;
  - **Test connection** with a sample search next to the button. The page shows the problems of the saved configuration above the form.
- **Browser editor** (a browser's page → **Settings**): the directory it reuses with what it takes over (URL or sign-in provider, base DN, bind account, transport) and a link to it; the browse base, the result limit, the account for browsing and the attributes to withhold; who may use it; the actions; **Test connection**, which binds with the browser's account and lists the entries directly under the browse base.
- **Test:** runs the connection test on the form as it stands — effective configuration, address check, connect, StartTLS, bind, and with a name in the sample-search field, a search with the mapped people next to the attributes they came from. Nothing is saved.

The admin API is the [integrations API](integrations.md#api): `POST /api/admin/integrations/catalog/com.intrafind%2Fldap-directory/_test` tests an unsaved directory (`testInput: { "query": "Mustermann" }` runs the sample search), `POST /api/admin/integrations/installed/<id>/_test` a saved one. `GET /api/admin/integrations/people-directories/editor-context` gives the editors the search presets with their mappings, the person fields, the limits and the LDAP sign-in providers (without secrets). The former `/api/admin/people-directories*` routes are gone (migration V198).

## Troubleshooting

| Test result | What to do |
| --- | --- |
| *issuer "…" is not trusted* | Get the named root from its publisher and compare the fingerprint. Install it in the server's operating system certificate store, or put it into `contents/config/certs/<name>.pem` and add `<name>` to the directory's trusted certificates. |
| *resolves to the private address …* | Add the host to the installation's allowed hosts or to `ssrf.allowedHosts`, or reuse the sign-in provider that connects to it. |
| *did not answer in time* | The iHub server has no route to the directory on that port; LDAP does not use the HTTP proxy. |
| *rejected an anonymous bind* / no results from Active Directory | Configure a service account; Active Directory does not allow anonymous search. |
| *has no bind account* | The referenced sign-in provider binds as the user. Add a bind account to it, or set the directory's access to anonymous. |
| Results marked `truncated` | Expected for broad searches; narrow the search, or raise `maxResults` (at most 50). |
