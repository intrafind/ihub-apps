# Short Links

## Overview
Provides short URLs for sharing apps with optional parameters. Links are stored server-side and usage is tracked for later analysis. Users can create custom codes and optionally include current settings and variables in the generated link. The backend is responsible for assembling the final redirect URL.

## Key Files
- `server/shortLinkManager.js` – manages link storage and usage counters in `contents/data/shortlinks.json`.
- `server/routes/shortLinkRoutes.js` – API endpoints and redirect handler.

## Usage
- Create links via `POST /api/shortlinks` with `code`, `appId`, `path`, `params`, `userId` and `includeParams`. A raw `url` can also be provided to bypass automatic creation.
- Access links at `/s/:code` which records usage and redirects to the stored URL.
- Manage links with `GET`, `PUT` and `DELETE` under `/api/shortlinks`.
