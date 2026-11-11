// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The id of a text slot of a slide layout (`kicker`, `lead`, `presenter` …) and
 * how many a template can declare. Kept apart from the template schema and the
 * slide builder, which both use them (the builder runs in the render worker).
 */
export const SLOT_ID_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;
export const MAX_SLOTS = 12;
