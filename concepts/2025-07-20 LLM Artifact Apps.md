# LLM Artifact Apps Concept

## Overview

This document outlines a concept for generating small frontend applications ("artifacts") on-demand through prompts. Each artifact is a lightweight web app that communicates with an LLM and provides a dedicated user interface for a specific task. Instead of a generic chat, the user can request an artifact to be created that guides them through a workflow or presents information in a tailored layout.

## Goals

- **Prompt-Based App Creation:** Users describe the desired functionality in natural language. The system generates a new app configuration and UI based on that prompt.
- **Dedicated UI per Use Case:** Each artifact focuses on a single workflow with custom input fields and output presentation.
- **Reusability and Sharing:** Generated apps can be saved, modified, and shared across the platform.

## How It Works

1. **Prompt Submission**
   - A user provides a description like "Create a summarization tool for PDF files".
   - The backend sends the prompt to the LLM along with guidance on the expected structure for an app configuration.
2. **LLM Response**
   - The LLM returns either a JSON object describing the UI components or, if requested, a block of React code using Tailwind CSS classes.
   - When React is used, the code defines a minimal component that relies on existing hooks and utilities from the platform.
   - All user-facing text must be wrapped in our i18n helpers so translations can be provided.
3. **App Generation**
   - When the response is JSON, the server validates it and stores it in `contents/config/apps.json`.
   - When the response contains React code, the server saves the component under `client/generated/` and exposes it through a dynamic route.
   - In both cases a new route is created that loads the generated UI.
4. **User Interaction**
   - The user opens the new app. Input fields, buttons, and output areas match the description provided in the original prompt.
   - Calls to the LLM or other tools are performed according to the generated configuration.

## Implementation Steps

1. **Schema Definition**
   - Extend the existing app configuration schema for JSON responses and define a simple wrapper for React components.
2. **Prompt Template**
   - Create a prompt template instructing the LLM to either output valid JSON or a React component with Tailwind classes. Emphasize small components and usage of our i18n helpers.
3. **Server Endpoint**
   - Add an endpoint `/api/generate-app` that accepts a prompt, invokes the LLM, validates the response, and saves a configuration or React file accordingly.
4. **Client Loader**
   - Implement a dynamic route that loads either the saved configuration or the generated React component and mounts it inside a sandbox wrapper.
5. **Persistence and Sharing**
   - Store generated configurations under `contents/config/generated-apps/`. Provide a simple list from which users can select previously created artifacts.
6. **Access Control**
   - Leverage existing authentication to ensure only authorized users can create or modify artifact apps.

## Considerations

- **Security**: Carefully validate all LLM outputs. Reject invalid JSON and enforce a whitelist of component types to prevent injection attacks.
- **Internationalization**: The generated configuration must include `en` and `de` translations for every label.
- **Versioning**: Keep track of generated app versions to allow updates without breaking links.
- **Resource Limits**: Set reasonable limits on the number of apps per user and the complexity of generated UIs.

## Summary

LLM Artifact Apps provide a flexible way to generate custom interfaces through natural language prompts. By extending our existing configuration-driven architecture, we enable users to craft tailored mini-apps without coding while still adhering to our translation, security, and configuration standards.
