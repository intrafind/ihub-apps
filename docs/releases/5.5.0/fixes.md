# Fixes — 5.5.0

## The Admin Dashboard No Longer Waits for the GitHub Update Check

On installations without outbound internet access, the admin start page showed nothing but grey
loading placeholders. The dashboard was waiting for the update check against `api.github.com`, which
never answered — where a firewall drops packets instead of refusing them, the request hung until the
operating system's TCP timeout, minutes later. The update check now runs on its own and the page
renders immediately.

- The check aborts after 1 second. Set `VERSION_CHECK_TIMEOUT_MS` (or
  `IHUB_VERSION_CHECK_TIMEOUT_MS`) to change that, for example on slow links or through a strict
  proxy.
- Results and failures are both cached for 5 minutes, so opening the dashboard no longer triggers a
  fresh request to GitHub every time. The admin endpoint answers from that cache and refreshes in
  the background, so it never blocks on the network.
- If the check fails or times out, the dashboard and the **Updates** page render fully — only the
  "new version available" badge is missing. The **Updates** page shows the version cards regardless.
- To stop the server contacting GitHub at all, `NO_VERSION_CHECK=true` still applies and skips the
  request entirely.
