# Kerberos Support Analysis for iHub Apps

**Date:** 2026-04-14
**Corrected:** 2026-11-09
**Status:** ❌ **NOT SUPPORTED** — iHub's Windows sign-in is NTLM only

## Correction (2026-11-09)

Version 1.0 of this analysis concluded that Kerberos was "already fully supported" through `ntlmAuth.type: "negotiate"`, and recommended closing the issue. That conclusion was wrong. It assumed `express-ntlm` has a Negotiate/Kerberos mode with NTLM fallback. It has neither, and an installation that followed the 1.0 configuration guide could no longer sign anyone in with Windows authentication. The 1.0 text is in the git history of this file; this version replaces it.

## Findings

Verified against the `express-ntlm` 2.7.0 source (the latest release, last published in November 2023):

1. **There is no `type` option.** The options `express-ntlm` reads are `badrequest`, `internalservererror`, `forbidden`, `unauthorized`, `prefix`, `debug`, `domain`, `domaincontroller`, `tlsOptions`, `getConnectionId`, `getProxyId`, `getCachedUserData` and `addCachedUserData`. iHub passed `type` (and `getUserInfo`, `getGroups`), and the library ignored them.
2. **Only the `NTLM` scheme is parsed.** `decode_http_authorization_header` in `lib/express-ntlm.js` accepts `Authorization: NTLM <token>` and nothing else; any other scheme, including `Negotiate`, goes to the `badrequest` handler (400).
3. **The library never checks credentials itself.** It relays the browser's NTLM Type 1 and Type 3 messages to `domainController` as an LDAP v3 SASL bind (mechanism `GSS-SPNEGO`, raw NTLMSSP token; `lib/NTLM_AD_Proxy.js`), and the domain controller decides. Every NTLM variant the domain controller accepts therefore works, NTLMv2 included. There is no NTLM version after v2.
4. **It cannot verify a Kerberos ticket.** A browser's Kerberos ticket is encrypted for iHub's service principal (`HTTP/ihub.example.com`), so only the key of the account holding that SPN (a keytab) can open it. Relaying it to the domain controller's LDAP service does not work, and nothing in `express-ntlm` or iHub validates tickets.
5. **`type: "negotiate"` broke sign-in.** iHub's own `unauthorized` handler in `server/middleware/ntlmAuth.js` used the setting to advertise `WWW-Authenticate: Negotiate`. The browser then answered with `Authorization: Negotiate …` (a Kerberos ticket when an SPN for the host exists, otherwise raw or SPNEGO-wrapped NTLM), which `express-ntlm` rejected with 400 on every attempt. There was no fallback to NTLM.
6. **Same pattern for groups.** `express-ntlm` returns only `DomainName`, `UserName`, `Workstation` and `Authenticated`, never groups, so `getGroups` with `domainControllerUser` yields no groups. Groups for NTLM users come only from `ldapGroupLookupProvider`. `getUserInfo`, `getGroups`, `domainControllerUser` and the password reference were removed in a follow-up (migration `V235__remove_dead_ntlm_settings`).

## Fix (2026-11-09)

- The `ntlmAuth.type` setting is removed: from the platform schema, the admin NTLM section, the `/api/auth/status` response and the docs. The challenge is always `WWW-Authenticate: NTLM`.
- Migration `V234__remove_ntlm_auth_type` deletes the key from `platform.json`. An installation that had `"negotiate"` signs in with NTLM again.
- `server/tests/ntlmAuth-challenge.test.js` pins the NTLM challenge, including for a config that still carries `type: "negotiate"`.

## Consequences of the Relay Design

Because the sign-in is an NTLM message relayed to LDAP, the domain controller's hardening against NTLM relay applies to it:

| Domain controller setting | Effect on iHub NTLM |
| --- | --- |
| LDAP signing required (default for new Windows Server 2025 domains) | Use `ldaps://`; an encrypted connection meets the requirement, and iHub cannot sign a relayed bind |
| LDAP channel binding (`LdapEnforceChannelBinding = 2`, or `1` when the browser sends its own binding over HTTPS) | A relayed bind over `ldaps://` is refused: the browser's message cannot carry the binding for iHub's connection to the DC |
| NTLM restricted or denied in the domain | NTLM cannot work |

Microsoft deprecated all NTLM versions in 2024 and plans to disable network NTLM by default in the next major Windows Server release. The relay approach has a limited lifetime regardless of how it is configured.

## Options for Real Kerberos

| Option | iHub change | Notes |
| --- | --- | --- |
| 1. Reverse proxy that handles Kerberos (Apache `mod_auth_gssapi`, IIS) in front of iHub, with `proxyAuth` | None — works today | Restrict trust with `trustedProxies` or a shared secret; groups via `proxyAuth.ldapGroupLookupProvider` |
| 2. OIDC identity provider with Windows single sign-on (ADFS, Keycloak with Kerberos, Entra ID) | None — works today | Also covers non-Windows clients; see `docs/ADFS-AUTHENTICATION-GUIDE.md` |
| 3. Native SPNEGO in iHub | New middleware | Accept `Negotiate`, validate the ticket with a keytab for `HTTP/<host>` (candidates: the `kerberos` npm package for GSSAPI/SSPI; `node-expose-sspi` on Windows only), fall back to the NTLM relay when the token is NTLMSSP. Needs SPN registration and keytab storage in the credential store; groups via `ldapGroupLookupProvider` |

## Recommendation

- Do not treat Kerberos as supported. For customers who need Kerberos, or whose domain blocks the NTLM relay, use option 1 or 2 now.
- Plan option 3 as a feature before Microsoft disables NTLM by default.
- `concepts/kerberos-authentication/` (2025-08-13) builds its Phase 1 on the same nonexistent `express-ntlm` Negotiate mode. Its Phase 2 (`node-expose-sspi`) remains a starting point for option 3 on Windows hosts.

## Related Files

- `server/middleware/ntlmAuth.js` — NTLM middleware (wraps `express-ntlm`)
- `server/migrations/V234__remove_ntlm_auth_type.js` — removes the setting
- `server/validators/platformConfigSchema.js` — `ntlmAuth` and `proxyAuth` schemas
- `docs/ldap-ntlm-authentication.md` — "How the Sign-In Is Checked" and "Kerberos" sections
- `docs/external-authentication.md` — proxy authentication
