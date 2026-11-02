# SonarCloud smells from the built-ins 3 branch (#3095)

Follow-up to intrafind/ihub-apps#3089: SonarCloud reported 46 code smells on
that PR's new code. This note records what was done with each, so the next
person touching these files knows what is left and why.

## How to get the current list

The PR analysis of #3089 is stale; use the main-branch analysis (no auth
needed). One file at a time (`files=` does not filter, `componentKeys=` does):

```bash
curl -sS "https://sonarcloud.io/api/issues/search?componentKeys=intrafind_ihub-apps:server/configCache.js&issueStatuses=OPEN,CONFIRMED&ps=500&types=CODE_SMELL"
```

The original 46 findings of the PR:

```bash
curl -sS "https://sonarcloud.io/api/issues/search?componentKeys=intrafind_ihub-apps&pullRequest=3089&issueStatuses=OPEN,CONFIRMED&ps=500&types=CODE_SMELL&sinceLeakPeriod=true"
```

## What happened to the 46

| Group | Count | Outcome |
| --- | --- | --- |
| `server/migrations/V198`–`V200` | 21 | Won't fix: applied migrations are frozen (their checksum is recorded); #3105 was closed for that reason. Mark them "Won't fix" in SonarCloud. |
| `AdminInstalledIntegrationsPage.jsx` | 4 | Gone: the page was deleted in #3098. |
| `IntegrationInstallDialog.jsx`, `ldapDirectoryConfig.js`, `ihub/index.js` | 4 | Gone: rewritten since (#3098, #3103, #3104); no finding on main. |
| `cloudStorage/index.js`: complexity, 2 of 4 ternaries, 2 `push()` | 5 | Gone: rewritten in #3104. |
| Still open on main | 12 | Fixed in the #3095 PR (below). |

## Fixed in the #3095 PR (pure refactor)

Every fix splits a function into named helpers or swaps one construct for an
equivalent one; the behaviour is unchanged and the existing tests are the
oracle.

- **S3776 cognitive complexity**: `configCache.getToolsForUser` (and
  `applyIhubEnvOverrides`, also flagged in this file), `integrationRegistry.missingAppIntegrations`,
  `InstalledIntegrationService._prepare`, `integrationTools.getIntegrationToolsForApp`,
  `cloudStorageConfig.listCloudStorageConnections`, the `superRefine` of
  `integrationDefinitionSchema`.
- **S9382 `await` in a loop**: `InstalledIntegrationService.resolveAllEnabled`
  now resolves in parallel (`Promise.all` keeps the order);
  `_storeSecrets` reads and writes the credential store once.
  `listCloudStorageConnections` stays sequential on purpose (one open file at
  a time: the directory holds one file per connected user), with a comment.
- **S3358 nested ternary** (2) and **S7763 `export … from`** in
  `cloudStorage/index.js`.
- **S8786 regex backtracking**: the Nextcloud probe URL trims trailing slashes
  with `stripTrailingSlashes` (`services/ModelEndpointDiscovery.js`, a loop)
  instead of `/\/+$/`.
- **S7744 useless empty object** in `ldapDirectory/index.js`.
- **S6582 optional chain** in `InstalledIntegrationService._removeManagedCredential`
  (with the `await`-in-loop ones above, every finding on main in that file;
  the issue's status check named them).

New tests: `server/tests/config-cache-env-overrides.test.js` (the `IHUB_*`
overrides had none) and three blocks in
`server/tests/integrations/cloudStorageConnector.test.js` (probe URL, settings
step, own-connection note, which token files count).

## Left on purpose

Other findings in the same files that were not raised by #3089 (they come
from other PRs, mostly the older `configCache.js` optional-chain ones and
`checkInstallValues` with complexity 73) are out of scope for #3095. The PR
description lists them; pick them up in a separate cleanup if wanted.
