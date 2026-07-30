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

## MCP Tools Now Advertise Their Inputs Again

External MCP clients (Claude, IDE agents, and other integrations) could connect to the iHub MCP
gateway and list its apps and workflows, but every tool showed up with no input fields. Any call
then failed with `Missing required argument: 'message'`, because the client had no schema telling it
to send a message in the first place. The gateway now advertises the correct inputs for each tool.

- App tools expose `message` (required) plus any variables the app defines.
- Workflow tools expose `input` (required) plus the workflow's start-node variables.
- Native tools expose their full parameter set, including choices and nested fields.
- No configuration change is needed — reconnect the MCP client and the fields appear.

## Integration Tools Like iFinder Now Work Through the MCP Gateway

Native integration tools (iFinder document search, Entra people search, Jira, and others) run on
behalf of the signed-in user and previously failed over MCP with "iFinder access requires
authenticated user". The gateway now passes the connected caller's identity to every native tool
call, so these tools work end-to-end from an MCP client.

- Each iFinder function — `search`, `getContent`, `getMetadata`, `discover` — is exposed as its own
  MCP tool with the correct arguments.
- A tool only appears if it is reachable through an app the caller can access, `mcpServer.expose.tools`
  is enabled, and the client's token carries the `mcp:tools:read` / `mcp:tools:call` scopes.
- Callers cannot impersonate another user through tool arguments — the gateway always uses the
  authenticated identity.

## Choose a Model When Invoking an App Over MCP

App tools exposed over MCP now accept an optional `modelId` argument, so a client can run an app with
a specific model instead of only the app's preferred one.

- Apps that restrict their models advertise the allowed ids as a fixed choice list.
- Apps configured to hide model selection do not expose the option.
- An unknown or incompatible model falls back to the app's preferred model rather than failing.
