# Bedrock model listing in the "Connect a model provider" wizard

Status: implemented (2026-11-23). This note explains what was built and why, so the next person
can extend it.

## Starting point

- The AWS Bedrock tile of the wizard stopped after storing the key ("Bedrock has no model list")
  and sent the admin to the Marketplace. The region was not asked for, and the Bedrock provider
  page had no region field.
- The adapter (`server/adapters/bedrock.js`) authenticates with a **Bedrock API key** sent as
  `Authorization: Bearer …`. There is no AWS SDK in any `package.json` and no SigV4 code.
- The region came from `model.config.region` → `providers.json` `bedrock.config.region` →
  `AWS_REGION` / `AWS_DEFAULT_REGION` → `eu-central-1`. The provider level was read but could not
  be set in the UI. Region values were not validated and went straight into the host name.
- Runtime calls already went through `httpFetch` (proxy + SSL whitelist) in `LLMClient`.

## Decision: no SDK

Bedrock API keys also work as Bearer token on the control plane
(`bedrock.<region>.amazonaws.com`), so the listing uses the same credential and the same
`httpFetch` as everything else. No new dependency, no SigV4, and the proxy / SSL whitelist apply
automatically. Calls:

- `GET /foundation-models` (ListFoundationModels)
- `GET /inference-profiles?type=SYSTEM_DEFINED&maxResults=1000[&nextToken=…]` (ListInferenceProfiles)

If AWS ever stops accepting Bearer keys on the control plane, the place to add SigV4 is
`BedrockModelDiscovery.js` (headers), still sent through `httpFetch`.

## Where things are

| Piece | File |
| --- | --- |
| Region rules (valid values, endpoint region, profile prefix) shared by server and client | `shared/bedrockRegions.js` |
| Listing + normalization + AWS error mapping | `server/services/BedrockModelDiscovery.js` |
| Generic listing fetch (timeout, size cap, readable errors), now exported with a `rejectionCheck` hook | `server/services/ModelEndpointDiscovery.js` (`fetchListingBody`) |
| Route branch for `apiType`/provider `bedrock`, `region` in the body | `server/routes/admin/models.js` (`_discover`, `withExistingModels`) |
| Region validation on save of the `bedrock` provider | `server/routes/admin/providers.js` (`normalizeBedrockRegion`) |
| Adapter skips invalid regions, recognises `jp.`/`au.`/`ca.`/`us-gov.` profile ids | `server/adapters/bedrock.js` |
| Wizard rules (region field, discovery body, provider write) | `client/src/features/admin/utils/providerConnect.js` |
| Wizard UI | `client/src/features/admin/components/provider-connect/ConnectionStep.jsx`, `TestStep.jsx` |
| Provider page field | `client/src/features/admin/components/BedrockRegionField.jsx` |

## How a listed model becomes a model config

- On-demand model → its own id (`mistral.mistral-large-2402-v1:0`).
- Profile-only model (`inferenceTypesSupported` without `ON_DEMAND`) → the system profile of the
  region's geography (`eu.` for `eu-*`), else any non-global profile listed in the region.
  With region `global` only `global.` profiles count.
- Profiles unreadable (e.g. 403) → bare id with the region prefix, same as the adapter would do.
- Provisioned-only variants (`…:28k`) are dropped; embedding/image models and models without a
  profile are listed as `unsupported`.
- Config: `provider: "bedrock"`, `modelId` = the id above, no `url`, no `providerId` (built-in
  provider), no key. The region is stored on the provider (`config.region`), because profile ids
  only work in their geography.

## Open points / ideas

- Context window and max output tokens are not in the Bedrock listing; the admin sets them.
- Tool support is not reported per model; left unset.
- The "Import from URL" dialog on the Models page does not offer Bedrock (it is URL based). The
  `_discover` endpoint supports it, so the dialog could get a region field later.
- Model drift / sync (`_model-drift`) does not cover Bedrock yet.
