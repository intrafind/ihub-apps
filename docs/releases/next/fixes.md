# Fixes — Unreleased

## Sign-In Returns Only to Pages of This Installation

After signing in, users are sent back only to a page of this iHub installation. A return address
that points anywhere else — another site, or a link that is not a web page — now opens the home
page instead.

- Applies to the login page, single sign-on (OIDC, NTLM) and signing in again after a session
  expired.
- On installations served under a subpath (for example `/ihub/`), the return address must also
  lie under that path.
