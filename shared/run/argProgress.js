// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The vocabulary of the tool-call progress frames (issue #3534), defined once
 * for the server that sends them (`server/services/chat/toolArgProgress.js`) and
 * the client that folds them (`shared/run/runReducer.js`,
 * `shared/run/toolActivity.js`). A value added here without a matching mapping
 * in the client fails `tests/unit/client/tool-progress-contract.test.jsx`.
 */

/** The `tool/progress` phases of this feature. */
export const PROGRESS_PHASES = Object.freeze({
  /** The model is writing the arguments of a call. */
  ARGS: 'args',
  /** It stopped writing them (see {@link ARGS_OUTCOMES}). */
  ARGS_ENDED: 'args.ended',
  /** The model call has shown nothing for a while. */
  MODEL_WAITING: 'model.waiting'
});

/** Why an announced call stopped streaming (`args.ended` `data.outcome`). */
export const ARGS_OUTCOMES = Object.freeze({
  /** The finished call exists; a `tool/started` or an interaction follows. */
  READY: 'ready',
  /** The loop will not run it. */
  DROPPED: 'dropped',
  /** The model hit its output limit inside the arguments. */
  TRUNCATED: 'truncated',
  /** The arguments could not be read as JSON. */
  INVALID: 'invalid',
  /** Stop, a deadline or a provider error ended the model call. */
  ABORTED: 'aborted'
});

/** The outcomes after which the call never runs and its row reads as failed. */
export const FAILED_ARGS_OUTCOMES = Object.freeze(
  new Set([ARGS_OUTCOMES.DROPPED, ARGS_OUTCOMES.INVALID, ARGS_OUTCOMES.TRUNCATED])
);

/** Every outcome the client knows; an unknown one is read as `ready`, so the wire can grow. */
export const KNOWN_ARGS_OUTCOMES = Object.freeze(new Set(Object.values(ARGS_OUTCOMES)));
