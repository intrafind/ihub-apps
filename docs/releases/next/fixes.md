# Fixes — Unreleased

## Scheduled Tasks: Memory Is Written on Reasoning Models

Tasks with memory turned on never updated their notes when the task ran on a model with thinking
enabled (for example Qwen on vLLM): the run succeeded, but the Memory card stayed empty. The step
that rewrites the notes allowed the model only a small output budget, and the model's reasoning
used it up before the notes were complete. That step now uses the model's normal output limit.

## Google Drive: Sign-In Works Behind Chained Proxies

Connecting Google Drive failed with a redirect URI mismatch on installations behind more than one
proxy when no redirect URI was configured for the provider. The automatically detected callback
URL took the proxy's forwarded host and protocol verbatim, so a chain such as
`X-Forwarded-Host: apps.example.com, proxy.internal` ended up in the URL Google was asked to
return to. Google Drive now reads the first entry of the chain, as Office 365 and Nextcloud
already did.

## Sign-In Return Links Can No Longer Point to Other Sites

After connecting Office 365, Google Drive, Nextcloud, Jira or an MCP server, users are sent back to
the page they came from. That return link was checked to stay on the iHub site, but links written
with a backslash or a hidden tab, such as `/\other-site.example`, slipped through and are read by
browsers as a link to another site. They are now rejected and the user returns to the default
page instead. Return links to pages inside iHub work as before.
