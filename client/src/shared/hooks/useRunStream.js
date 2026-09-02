import { useReducer, useRef, useCallback, useEffect, useState } from 'react';
import {
  createStreamState,
  reduceRunEvent,
  rebuildRunFromLedger,
  RUN_EVENTS
} from '../run/runReducer';
import {
  openSseStream,
  toRunEnvelope,
  fetchWithAuthRetry,
  TRANSPORT_ERROR_CODES
} from '../utils/openSseStream';
import { buildApiUrl } from '../../utils/runtimeBasePath';
import { fetchAllLedgerEvents } from '../run/ledgerPages';

/**
 * Reducer actions layered over `reduceRunEvent` (the pure run reducer only
 * understands envelopes; the hook needs a few bookkeeping transitions).
 */
const ACTION = Object.freeze({
  ENVELOPE: 'envelope',
  REBUILD: 'rebuild',
  RESET: 'reset',
  DISCONNECTED: 'disconnected'
});

function streamReducer(state, action) {
  switch (action.type) {
    case ACTION.ENVELOPE:
      return reduceRunEvent(state, action.envelope);
    case ACTION.REBUILD:
      // A re-sync page: the run is rebuilt from its ledger (authoritative) and
      // swapped in; rebuilding clears the gap.
      return rebuildRunFromLedger(state, action.runId, action.envelopes);
    case ACTION.RESET: {
      const fresh = createStreamState(action.streamId ?? state.streamId);
      return {
        ...fresh,
        connected: action.keepConnection ? state.connected : false,
        protocol: action.keepConnection ? state.protocol : null,
        lastSeq: action.keepSeq ? state.lastSeq : 0
      };
    }
    case ACTION.DISCONNECTED:
      return state.connected ? { ...state, connected: false } : state;
    default:
      return state;
  }
}

/**
 * Generic run-stream hook: one SSE v2 stream (workflow execution, agent run,
 * …) folded into a `StreamState` via the shared run reducer.
 *
 * - fetch-based transport (`openSseStream`: Bearer header, 401 refresh, no
 *   native EventSource)
 * - `useReducer` over `reduceRunEvent`
 * - sequence-gap detection → the affected run is rebuilt from its ledger
 *   (`GET /api/runs/:runId/events?view=sse`); ledger and stream sequence
 *   numbers are different spaces, so nothing is merged by seq
 * - optional `closeOnRunEnd`: the root run's `run/ended` ends the stream
 *
 * Transport failures are NOT folded into the reducer (they are not run
 * semantics); they are exposed as `error` and reported via `onError`.
 *
 * @param {Object} [options]
 * @param {boolean} [options.closeOnRunEnd=false] - Abort the fetch once the ROOT run ended
 * @param {number} [options.timeoutDuration=0] - Connection timeout in ms (0 = none)
 * @param {Function} [options.onEvent] - `(envelope) => void` for every folded envelope
 * @param {Function} [options.onRunEnd] - `(envelope) => void` when the root run ended
 * @param {Function} [options.onError] - `(error) => void` on transport failure
 * @param {Function} [options.onClose] - `() => void` when the server closed the stream
 *   without a terminal frame (callers usually reconnect)
 * @returns {{ state: Object, connect: Function, disconnect: Function, connected: boolean,
 *   resync: Function, reset: Function, push: Function, error: Error|null }}
 */
function useRunStream({
  closeOnRunEnd = false,
  timeoutDuration = 0,
  onEvent,
  onRunEnd,
  onError,
  onClose
} = {}) {
  const [state, dispatch] = useReducer(streamReducer, null, () => createStreamState(null));
  const [transportError, setTransportError] = useState(null);

  const abortRef = useRef(null);
  const timeoutRef = useRef(null);
  const streamIdRef = useRef(null);
  const rootRunIdRef = useRef(null);
  /** Stream seqs already folded on the current connection (dedupe for replays). */
  const seenSeqRef = useRef(new Set());
  /** `${runId}:${after}` keys of re-syncs in flight (one per gap). */
  const resyncInFlightRef = useRef(new Set());
  const mountedRef = useRef(true);

  // Always call the latest callbacks without re-creating connect().
  const callbacksRef = useRef({});
  callbacksRef.current = { onEvent, onRunEnd, onError, onClose };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const ac = abortRef.current;
      abortRef.current = null;
      if (ac) {
        try {
          ac.abort();
        } catch {
          // already aborted
        }
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const isRootRun = useCallback(runId => {
    const root = rootRunIdRef.current;
    return !root || runId === root;
  }, []);

  /**
   * Fold one envelope (from the wire) into the state, skipping seqs already seen.
   */
  const ingest = useCallback(envelope => {
    if (!envelope) return false;
    if (Number.isInteger(envelope.seq)) {
      if (seenSeqRef.current.has(envelope.seq)) return false;
      seenSeqRef.current.add(envelope.seq);
    }
    dispatch({ type: ACTION.ENVELOPE, envelope });
    if (callbacksRef.current.onEvent) callbacksRef.current.onEvent(envelope);
    return true;
  }, []);

  /**
   * Fold a client-side envelope (no seq) — e.g. an optimistic
   * `interaction/answered` right after the user responded to a checkpoint.
   *
   * @param {Object} envelope - SSE v2 envelope (seq is ignored)
   */
  const push = useCallback(envelope => {
    if (!envelope) return;
    const { seq: _seq, ...rest } = envelope;
    dispatch({ type: ACTION.ENVELOPE, envelope: { ...rest, synthetic: true } });
  }, []);

  /**
   * Close the stream (abort the fetch). Safe to call when not connected.
   * @returns {boolean} whether a stream was open
   */
  const disconnect = useCallback(() => {
    const ac = abortRef.current;
    abortRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (ac) {
      try {
        ac.abort();
      } catch {
        // already aborted
      }
    }
    dispatch({ type: ACTION.DISCONNECTED });
    return !!ac;
  }, []);

  /**
   * Drop every run from the state (e.g. after a REST refetch made the
   * server state authoritative). Keeps the connection flag and, by default,
   * the last seq so gap detection keeps working.
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.keepConnection=true]
   * @param {boolean} [opts.keepSeq=true]
   */
  const reset = useCallback(({ keepConnection = true, keepSeq = true } = {}) => {
    dispatch({ type: ACTION.RESET, keepConnection, keepSeq });
  }, []);

  /**
   * Re-sync a run: fetch its whole ledger projection (page by page — the
   * endpoint pages by ledger sequence) and rebuild the run from it in one
   * step (the ledger is authoritative). The live stream's `seq` and the
   * ledger's `seq` are independent sequence spaces, so no cursor is carried
   * over.
   *
   * @param {string} [runId] - Defaults to the root run
   * @returns {Promise<{runId: string, events: Array, lastSeq: number|null}|null>}
   *   the collected projection or null on failure
   */
  const resync = useCallback(async runId => {
    const rid = runId || rootRunIdRef.current || streamIdRef.current;
    if (!rid) return null;
    try {
      const { events: envelopes, lastSeq } = await fetchAllLedgerEvents(async (after, limit) => {
        const res = await fetchWithAuthRetry(
          buildApiUrl(
            `runs/${encodeURIComponent(rid)}/events?after=${after}&limit=${limit}&view=sse`
          ),
          { method: 'GET', headers: { Accept: 'application/json' } }
        );
        if (!res.ok) throw new Error(`Run re-sync failed (${res.status})`);
        return res.json();
      });
      if (mountedRef.current) dispatch({ type: ACTION.REBUILD, runId: rid, envelopes });
      return { runId: rid, events: envelopes, lastSeq };
    } catch (err) {
      console.warn('Run re-sync failed:', err);
      // Clear the gap so a failed re-sync does not block later detection.
      if (mountedRef.current) dispatch({ type: ACTION.REBUILD, runId: rid, envelopes: [] });
      return null;
    }
  }, []);

  // Sequence gap → rebuild the affected run once per gap.
  useEffect(() => {
    const gap = state.gap;
    if (!gap) return;
    const key = `${gap.runId}:${gap.expected}`;
    if (resyncInFlightRef.current.has(key)) return;
    resyncInFlightRef.current.add(key);
    resync(gap.runId).finally(() => resyncInFlightRef.current.delete(key));
  }, [state.gap, resync]);

  /**
   * Open the stream. Any previous stream is aborted first. Connecting to a
   * different `streamId` resets the state.
   *
   * @param {string} url - Stream URL (absolute or relative)
   * @param {Object} [opts]
   * @param {string} [opts.streamId] - Stream id (executionId / chatId)
   * @param {string} [opts.rootRunId] - Run whose `run/ended` ends the stream (closeOnRunEnd)
   */
  const connect = useCallback(
    (url, { streamId = null, rootRunId = null } = {}) => {
      disconnect();
      setTransportError(null);

      // Every connection is a new sequence epoch: the server counter is
      // per delivering worker and may restart (eviction, failover, restart),
      // so seqs seen on the previous transport must not suppress new frames.
      seenSeqRef.current = new Set();
      if (streamId && streamId !== streamIdRef.current) {
        streamIdRef.current = streamId;
        resyncInFlightRef.current.clear();
        dispatch({ type: ACTION.RESET, streamId, keepConnection: false, keepSeq: false });
      }
      rootRunIdRef.current = rootRunId || streamId || rootRunIdRef.current;

      const ac = new AbortController();
      abortRef.current = ac;
      let opened = false;
      let endedByTerminalFrame = false;

      const fail = err => {
        if (!mountedRef.current) return;
        setTransportError(err);
        dispatch({ type: ACTION.DISCONNECTED });
        if (callbacksRef.current.onError) callbacksRef.current.onError(err);
      };

      if (timeoutDuration > 0) {
        timeoutRef.current = setTimeout(() => {
          if (opened) return;
          if (abortRef.current === ac) abortRef.current = null;
          try {
            ac.abort();
          } catch {
            // already aborted
          }
          fail(
            Object.assign(new Error('Connection timeout. Please try again.'), {
              code: TRANSPORT_ERROR_CODES.TIMEOUT
            })
          );
        }, timeoutDuration);
      }

      (async () => {
        try {
          await openSseStream(url, {
            signal: ac.signal,
            onOpen: () => {
              opened = true;
              if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
              }
            },
            onEvent: (name, data) => {
              const envelope = toRunEnvelope(name, data, streamIdRef.current);
              if (!envelope) return;
              if (envelope.synthetic) {
                // Parser-level read error — surface as a transport error.
                fail(
                  Object.assign(new Error(envelope.data?.message || 'Stream reading error'), {
                    code: envelope.data?.code
                  })
                );
                return;
              }
              ingest(envelope);

              if (
                closeOnRunEnd &&
                envelope.type === RUN_EVENTS.RUN_ENDED &&
                isRootRun(envelope.runId)
              ) {
                endedByTerminalFrame = true;
                if (abortRef.current === ac) abortRef.current = null;
                try {
                  ac.abort();
                } catch {
                  // already aborted
                }
                dispatch({ type: ACTION.DISCONNECTED });
                if (callbacksRef.current.onRunEnd) callbacksRef.current.onRunEnd(envelope);
              }
            }
          });

          // The server closed the stream without a terminal frame (or we were
          // aborted by disconnect()/unmount — then abortRef no longer points at us).
          if (abortRef.current === ac && !endedByTerminalFrame && mountedRef.current) {
            abortRef.current = null;
            dispatch({ type: ACTION.DISCONNECTED });
            if (callbacksRef.current.onClose) callbacksRef.current.onClose();
          }
        } catch (err) {
          if (err.name === 'AbortError') return;
          console.error('Run stream error:', err);
          if (abortRef.current === ac) abortRef.current = null;
          fail(err);
        } finally {
          try {
            ac.abort();
          } catch {
            // already aborted
          }
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
        }
      })();
    },
    [closeOnRunEnd, disconnect, ingest, isRootRun, timeoutDuration]
  );

  return {
    state,
    connect,
    disconnect,
    resync,
    reset,
    push,
    connected: state.connected,
    error: transportError
  };
}

export default useRunStream;
