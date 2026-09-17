# AWS Bedrock Example Models

This folder contains example model configurations for AWS Bedrock's Converse
API. Every entry ships **disabled** so you can choose which ones to enable.

These models are exposed through the **iHub Examples** marketplace registry
(`examples/catalog.json`). Open Admin → Marketplace → "iHub Examples" to
browse and install them with one click.

## Setup

1. Create an AWS Bedrock long-lived API key in the AWS console
   (Bedrock → API keys → Create API key).
2. Set `BEDROCK_API_KEY=<your key>` in your environment.
3. Install one or more example models from the marketplace, or copy a JSON
   file from this folder into `contents/models/` and set `enabled: true`.
4. Optionally adjust the `config.region` field on a per-model basis —
   defaults to `eu-central-1`. Use `global` for cross-region inference
   profiles (Anthropic Claude Sonnet 4 family only).

## Region behavior

- `eu-*` regions auto-prepend the `eu.` cross-region inference profile prefix
  for models that require it (Claude 4.x, Llama 4, Llama 3.3).
- `us-*` regions auto-prepend `us.` under the same conditions.
- `apac-*` / `ap-*` regions auto-prepend `apac.`.
- `global` auto-prepends `global.` and routes to a supported source region.
- An explicit `us.…` / `eu.…` / `apac.…` / `global.…` modelId is always
  honored as-is.

## Limits enforced by the adapter

The server-side Bedrock adapter applies these checks before the request leaves
the iHub backend:

- Max **5 documents** per request (Bedrock service limit).
- Document filenames are sanitized to Bedrock's character allowlist
  (alphanumerics, single spaces, `-`, `()`, `[]`).
- Image formats are restricted to `png`, `jpeg`, `gif`, `webp`.
- Empty text blocks are stripped before sending.

For full details, see `docs/models.md` (AWS Bedrock section).
