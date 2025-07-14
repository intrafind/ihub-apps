# Claude Integration

This document provides details about using Anthropic's Claude models within AI Hub Apps.

## Overview
Claude models are accessed via the Anthropic Messages API. Configuration files under `contents/models` define the available models. Each model entry specifies the API endpoint, token limits, and display names.

## Configuration
To add or adjust a Claude model, edit the corresponding JSON file in `contents/models/`. Provide:

- `id`: unique identifier
- `modelId`: the Anthropic model name
- `name`: object with `en` and `de` translations
- `description`: object with `en` and `de` translations

## Internationalization
All strings related to Claude models or apps must include English (`en`) and German (`de`) translations. Update the following files when adding new keys:

- Built-in translations: `shared/i18n/{lang}.json`
- Overrides: `contents/locales/{lang}.json`
- Never assume English is the default language. Use the `defaultLanguage` value
  from the backend platform configuration.

