# Entra People Search

## Overview

This concept describes the AI supported people search feature. A dedicated app allows employees to search for colleagues and team information using the internal directory.

## Key Files

- `server/tools/entraPeopleSearch.js` – implements several functions for directory lookups.
- `contents/config/tools.json` – defines the tool and its individual functions.
- `contents/config/apps.json` – adds the `people-search` app using the new functions.
- `server/configCache.js` and `server/toolLoader.js` – updated to support tools with multiple functions.

## Usage

Apps can reference individual functions such as `entraPeopleSearch.getTeamMembers` in their `tools` array. Each function exposes its own parameter schema and is executed via the same script file.
