# App Creation Wizard Concept

This document describes the concept for guiding administrators through the creation of new apps.

## Goals
- Allow admins to create a new app from scratch or use an existing app as a template.
- Support optional AI based generation of an initial configuration.
- Track fields that differ from the parent configuration and allow reverting changes.
- Make it possible to disable inheritance for selected parent apps.

## Key Ideas
1. **Wizard Flow**
   - Step 1 chooses how to start (blank, clone existing, generate via AI).
   - Step 2 presents a form to edit all app properties.
   - Step 3 reviews overrides before saving.
2. **Parent Handling**
   - New apps may set `parentId` to reference the template.
   - Parent apps can define `allowInheritance` (default `true`). When `false`, they are hidden from the template picker.
3. **Override Tracking**
   - When a field value differs from the parent, the UI marks it as overridden.
   - Each overridden field offers a button to revert to the parent value.
4. **Generation Endpoint**
   - `/api/admin/app-generator` returns a draft configuration based on a textual description.
   - This is a simple placeholder implementation but can later call an LLM.

The implementation is distributed in `client/src/pages/AdminAppWizardPage.jsx` and server route additions in `server/routes/adminRoutes.js`.
