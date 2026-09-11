/**
 * The two kinds of namespace must not overlap.
 *
 * A raw namespace *is* an installation's `contents/<dir>/` tree — git-tracked,
 * hand-edited, mounted into containers, backed up — and a runtime namespace is
 * the provider's own storage. `documents.put` routes on the name alone, so a
 * runtime store that picked a name already declared raw would write its state
 * into `contents/tools/`, where `resourceLoader` loads every `*.json` as a
 * tool. Nothing would throw; the admin UI would simply grow entries nobody
 * created, and a `git status` would show churn in a directory the operator
 * owns.
 *
 * That has never happened, and the reason to pin it is that it would not
 * announce itself when it did. `'tools'`, `'prompts'`, `'models'` and
 * `'workflows'` are all plausible names for a runtime store, and one of them
 * is one autocomplete away.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_NAMESPACES, RUNTIME_NAMESPACES, getRawNamespace } from '../storage/namespaces.js';
import { CHATS_NAMESPACE, CHAT_MESSAGES_NAMESPACE } from '../services/chat/ChatRepository.js';
import { RUNS_NAMESPACE } from '../services/runtime/RunSummaryRepository.js';
import {
  INTERACTIONS_NAMESPACE,
  IMPORT_STATE_NAMESPACE as INTERACTIONS_IMPORT_NAMESPACE
} from '../services/loop/InteractionService.js';
import {
  WORKFLOW_STATE_NAMESPACE,
  IMPORT_STATE_NAMESPACE as WORKFLOW_IMPORT_NAMESPACE
} from '../services/workflow/WorkflowStateRepository.js';
import { IMPORT_STATE_NAMESPACE as RUN_IMPORT_NAMESPACE } from '../services/runtime/runSummaryImport.js';
import { INTEGRATION_CONVERSATIONS_NAMESPACE } from '../services/integrations/ConversationStateManager.js';

describe('storage namespaces', () => {
  it('declares no runtime namespace that is also a raw one', () => {
    for (const [name, ns] of Object.entries(RUNTIME_NAMESPACES)) {
      assert.equal(
        getRawNamespace(ns),
        null,
        `RUNTIME_NAMESPACES.${name} is '${ns}', which is also a raw configuration namespace — ` +
          `writing it would land in contents/${CONFIG_NAMESPACES[ns]?.dir}/`
      );
    }
  });

  it('gives the shared import marker exactly one spelling', () => {
    // It had three definitions in three modules. Two importers disagreeing by
    // one character each believe the other has already run, and a one-time
    // import runs twice or never — neither of which fails loudly.
    assert.equal(INTERACTIONS_IMPORT_NAMESPACE, RUNTIME_NAMESPACES.runtimeImports);
    assert.equal(WORKFLOW_IMPORT_NAMESPACE, RUNTIME_NAMESPACES.runtimeImports);
    assert.equal(RUN_IMPORT_NAMESPACE, RUNTIME_NAMESPACES.runtimeImports);
  });

  it('has every runtime store using a declared namespace', () => {
    // The declaration is only worth something if the stores actually route
    // through it; a constant that drifted back to a literal would be invisible.
    const declared = new Set(Object.values(RUNTIME_NAMESPACES));
    for (const [label, ns] of [
      ['ChatRepository.CHATS_NAMESPACE', CHATS_NAMESPACE],
      ['ChatRepository.CHAT_MESSAGES_NAMESPACE', CHAT_MESSAGES_NAMESPACE],
      ['RunSummaryRepository.RUNS_NAMESPACE', RUNS_NAMESPACE],
      ['InteractionService.INTERACTIONS_NAMESPACE', INTERACTIONS_NAMESPACE],
      ['WorkflowStateRepository.WORKFLOW_STATE_NAMESPACE', WORKFLOW_STATE_NAMESPACE],
      [
        'ConversationStateManager.INTEGRATION_CONVERSATIONS_NAMESPACE',
        INTEGRATION_CONVERSATIONS_NAMESPACE
      ]
    ]) {
      assert.ok(declared.has(ns), `${label} is '${ns}', which RUNTIME_NAMESPACES does not declare`);
    }
  });
});
