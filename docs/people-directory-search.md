# People Directory Search

Users can ask iHub's chat for people: who someone is, their function, their unit and how to reach them. iHub searches **people directories** for that: the company's own LDAP or Active Directory, and any number of further directories such as the public directory of the German federal administration, **x500.bund.de**.

Each enabled directory becomes its own small set of read-only tools, named and described after the directory. The model reads those descriptions, decides which directory fits a question, and calls several when it needs to — for example the company directory and x500.bund.de in one answer. Nothing is merged server-side: every result says which directory it came from.

The shipped **People search** app (`people-directory`) uses every directory a user may use, including ones added later.

> Microsoft Entra ID is not a directory type yet. The existing `entraPeopleSearch` tool is unchanged; see [Tool Calling](tool-calling.md#entrapeoplesearch).

## Quick start

### Search x500.bund.de

The directory of the German federal administration is reachable from the public internet and ships as a disabled entry, `x500bund`.

1. Open **Admin → Integrations → People directories**.
2. Switch on **Federal directory (IVBB)**. The page offers to switch on the **People search** app as well.
3. Optional: open the entry, type a surname into the test panel and run the test.

The iHub server needs a direct route to `x500.bund.de` on port 636 (LDAP does not use the HTTP proxy). The entry trusts the Verwaltungs-PKI root shipped with iHub (see [Certificates](#certificates)).

### Search the company directory

If LDAP sign-in is configured, the company directory needs one click:

1. Open **Admin → Authentication → LDAP** and choose **Use for people search** on the provider.
2. The directory editor opens with the provider selected. Check the name and description (the model reads them), the groups who may use it, and save.

The directory reuses the provider's URL, base DN, preset, TLS version settings and bind account. A search cannot run "as the user", because iHub never keeps a user's LDAP password, so the provider needs a **bind account** — or the directory sets access to anonymous when the directory allows anonymous search (Active Directory normally does not).

## Configuration

Directories live in `contents/config/peopleDirectories.json`, edited on the admin page. Changes take effect without a restart.

```jsonc
{
  "directories": [
    {
      // Company directory: reuses an LDAP sign-in provider
      "id": "corp",
      "enabled": true,
      "type": "ldap",
      "authProvider": "corp-ad", // name in platform.json ldapAuth.providers[]
      "name": { "en": "Company directory", "de": "Firmenverzeichnis" },
      "description": {
        "en": "Employees of our company: name, e-mail, phone, department, manager.",
        "de": "Mitarbeitende unseres Unternehmens: Name, E-Mail, Telefon, Abteilung, Vorgesetzte."
      },
      "groups": ["authenticated"]
    },
    {
      // External and anonymous: everything stated here (shipped, disabled)
      "id": "x500bund",
      "enabled": false,
      "type": "ldap",
      "url": "ldaps://x500.bund.de:636",
      "tlsCa": ["pca-1-verwaltung-23"],
      "baseDn": "o=Bund,c=DE",
      "preset": "ivbb",
      "bind": { "mode": "anonymous" },
      "dataFlow": "external",
      "name": { "en": "Federal directory (IVBB)", "de": "Verzeichnisdienst des Bundes (IVBB)" },
      "description": { "en": "Public directory of German federal authorities …" },
      "units": true,
      "maxResults": 25,
      "timeoutMs": 8000,
      "groups": ["authenticated"]
    }
  ]
}
```

An example with both entries is in `examples/config/peopleDirectories.json`.

| Field | Meaning |
| --- | --- |
| `id` | 2–32 lower-case letters, digits and `-`. Becomes the tool id prefix (`<id>__search_people`). No `_`, and it must not be the id of a tool, an MCP server or an A2A agent: apps and groups select all of them by id. |
| `enabled` | Default `true`. A disabled directory offers no tools. |
| `type` | `ldap` (Entra follows later). |
| `authProvider` | Name of an `ldapAuth.providers[]` entry. Inherits `url`, `starttls`, TLS version settings, `baseDn`, `preset` and the bind account. Any field set on the directory overrides the inherited one. |
| `url`, `starttls`, `baseDn`, `preset` | As for a sign-in provider; required without `authProvider`. Presets: `openldap`, `activeDirectory`, `ivbb`. |
| `tlsOptions` | Only `minVersion`, `maxVersion` and `ciphers`. Every other key — `rejectUnauthorized`, `ca`, `checkServerIdentity`, `servername` — is refused. From a sign-in provider only these keys are taken over; others are ignored, and the connection test says so. |
| `bind` | `{ "mode": "anonymous" }` or `{ "mode": "service", "dn": "…", "passwordRef": "<credential id>" }`. The password lives in the credential store (**Admin → Credentials**); a password in this file is refused. Default: the provider's bind account, or anonymous without a provider. |
| `searchBase` | Where people are searched. Defaults to `baseDn` (or the provider's user search base). |
| `personFilter`, `searchAttributes`, `attributeMapping` | Override the preset (see [Presets](#presets-and-mapping)). |
| `units` | Offer `list_units` and the `unit` parameter: the one-level children of the search base (authorities in x500.bund.de). |
| `allowPlaintext` | Default `false`. A plain `ldap://` URL without StartTLS is refused unless this is `true`, anonymous binds included. A service bind is never sent in plain text. |
| `tlsCa` | Trust anchors from the [certificate store](#certificates). When set, only these anchors are trusted for this directory; verification stays on. When unset, Node's default roots are used. |
| `allowedHosts` | Hosts this directory may reach although they resolve to a private address (`*.corp.example` patterns allowed). |
| `maxResults` | Default 10, at most 50. The most people one search returns; a tool call can ask for fewer, never more. |
| `timeoutMs` | Default 8000, at most 30000. |
| `concurrency`, `requestDelayMs` | Default 2 and 0. One queue per directory, shared by all its tools and its connection test. |
| `groups` | Who may use the directory. Default `["authenticated"]`; `"*"` opens it to every caller including anonymous ones; an empty list closes it. Inherited groups count (`admins` inherit `users`). |
| `dataFlow` | `internal` (default) or `external`: the search terms leave your network. Shown as a badge and carried on the tools. |
| `name`, `description` | What the model reads to choose a directory, in each language. Say what the directory holds and what to search by. |

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
- `unit` must be one of `list_units`' ids; it is never concatenated into a DN.
- Errors come back as `{ directory, error: { code, message } }` the model can act on (`invalid_arguments`, `timeout`, `connection_refused`, …), without internal host names.

### Selecting directories in an app

An app (or a group's `permissions.tools`) selects directory tools by:

- `"peopleDirectories"` — every directory, including ones added later (the shipped app uses this);
- a directory id, e.g. `"x500bund"` — all tools of that directory;
- an exact tool id, e.g. `"x500bund__search_people"`.

A directory's `groups` hold on top of that: an app that lists `x500bund`, or a `"*"` tool grant, does not give the directory to a user outside its groups. The check runs in the tools listing, an app's tools, direct tool runs, the MCP gateway, and again when the tool runs.

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

`attributeMapping` overrides a field with one or more sources, tried in order:

- an attribute: `"mail"`;
- a DN component: `"dn:l"` (the entry's `l=` RDN);
- attributes joined with a space: `"givenName sn"` (only when all have a value).

## Network and security

Every connection is checked when it is opened, not only when the configuration is saved:

- **Transport.** `ldaps://` or StartTLS is required; plain `ldap://` needs `allowPlaintext` and shows the same warning as a plain-text sign-in provider. A service bind is never sent in plain text.
- **Address check.** The host is resolved and every address classified. A private, loopback or link-local address is refused unless the host is allowed explicitly: the directory's `allowedHosts`, the platform-wide `ssrf.allowedHosts` (Admin → Security), or the host of the referenced sign-in provider. The socket then connects to the checked address, so a DNS change cannot redirect it; TLS still checks the certificate against the host name.
- **Certificates.** Verification is always on. Private CAs are trusted per directory with `tlsCa`. The only way to switch verification off is the platform's SSL whitelist (`ssl.ignoreInvalidCertificates` with the host in `ssl.domainWhitelist`), like every other outbound connection; a sign-in provider's `rejectUnauthorized: false` is ignored here.
- **No proxy.** LDAP is not HTTP. External directories need a direct route on port 389 or 636.
- **Data protection.** Directory tools are read-only. Searches are logged with directory, user, result count and duration; the search text only at debug level. External directories are marked `dataFlow: external`.

## Certificates

The **Certificates** tab manages the trust anchors in `contents/config/certs/<name>.pem`. It lists each certificate with subject, validity, SHA-256 fingerprint and the directories that use it, and warns from 90 days before expiry.

- **Upload** a PEM or DER file. The page shows its subject and fingerprint; compare them with the value the publisher states before saving. Private keys are refused.
- **Remove** a certificate that no directory uses. A shipped certificate comes back on the next start.

iHub never fetches or trusts a root on its own. When a server's certificate is not trusted, the connection test shows the chain the server sent — subject, issuer, validity and fingerprint of each certificate — and names the issuer that is missing.

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

**Admin → Integrations → People directories** (`/admin/integrations/people-directories`):

- **Directories:** one row per directory with source, preset, groups and an on/off switch; badges for plain-text transport and external data flow.
- **Editor:** source (reuse a sign-in provider, or connect directly), access (anonymous, or a service account whose password comes from the credential store), network, visibility, the model-facing name and description, limits and the mapping with the preset's value next to each field.
- **Test panel:** runs the connection test on the form as it stands — configuration, address check, connect, StartTLS, bind, a sample search, and the mapped people next to the attributes they came from. Nothing is saved.
- **Certificates:** see above.

The admin API, all behind `adminAuth` (personal API keys, OAuth clients and agents get a 403):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/people-directories` | Directories, a summary of each, the LDAP sign-in providers, the People search app status |
| `PUT` | `/api/admin/people-directories` | Replace the file (validated; 409 on an id clash) |
| `GET` | `/api/admin/people-directories/presets` | Presets and their mappings |
| `POST` | `/api/admin/people-directories/test` | Test a saved (`id`) or unsaved (`directory`) entry, optional `query` |
| `GET` | `/api/admin/people-directories/certificates` | Trust anchors |
| `POST` | `/api/admin/people-directories/certificates/preview` | Parse an upload without saving |
| `POST` | `/api/admin/people-directories/certificates` | Add a trust anchor (`name`, `content`, `encoding`) |
| `DELETE` | `/api/admin/people-directories/certificates/:name` | Remove an unused trust anchor |

## Troubleshooting

| Test result | What to do |
| --- | --- |
| *issuer "…" is not trusted* | Get the named root from its publisher, compare the fingerprint, upload it under Certificates and add it to the directory's trust anchors. |
| *resolves to the private address …* | Add the host to the directory's allowed hosts or to `ssrf.allowedHosts`, or reuse the sign-in provider that connects to it. |
| *did not answer in time* | The iHub server has no route to the directory on that port; LDAP does not use the HTTP proxy. |
| *rejected an anonymous bind* / no results from Active Directory | Configure a service account; Active Directory does not allow anonymous search. |
| *has no bind account* | The referenced sign-in provider binds as the user. Add a bind account to it, or set the directory's access to anonymous. |
| Results marked `truncated` | Expected for broad searches; narrow the search, or raise `maxResults` (at most 50). |
