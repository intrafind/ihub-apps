# Kill points

A kill point is a place in the code where a fault test can end the process: `killPoint('<name>')` from `server/utils/killPoint.js`. This file lists every one. `server/tests/killPoint-inventory.test.js` compares the two tables with the call sites and fails when a kill point is in the code and not here, or here and not in the code.

How a kill point is armed, and what it does in an installation (nothing), is described in [Testing Runs](../../../docs/run-testing.md#the-fault-tier).

## In the server

Call sites under `server/`, outside `server/tests/`.

| Kill point                 | File                                                                    | The process dies                                                                                           |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `e2e-counter-before-write` | `server/services/integrations/protocols/native/connectors/testTools.js` | inside the tool `e2e_counter_write`, after the call started and before the counter was written             |
| `e2e-counter-after-write`  | `server/services/integrations/protocols/native/connectors/testTools.js` | inside the tool `e2e_counter_write`, after the counter was written and before the tool returned its result |

Both are in the test tool, which exists only in a server started with `NODE_ENV=test` and `IHUB_TEST_TOOLS=1`. They give a fault test a write that is in flight when the server dies, without a kill point in the code that runs a tool. The kill points of a feature are added with the feature.

No kill point is placed in a file of the frozen legacy workflow path (`server/tests/workflow-legacy-frozen.test.js`).

## In the fixture server of the harness

Call sites under `server/tests/faults/fixtures/`. The fixture is a small server with a journal, which the self-test of the harness kills and restarts (`harness.fault.test.js`).

| Kill point             | File                                             | The process dies                                                                      |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `fixture-before-write` | `server/tests/faults/fixtures/journalServer.mjs` | after the job wrote "write started" to its journal and before the counter was written |
| `fixture-after-write`  | `server/tests/faults/fixtures/journalServer.mjs` | after the counter was written and before the job wrote "write done" to its journal    |
