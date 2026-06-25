#!/usr/bin/env node

/**
 * Runtime test for the root-cause fix of the "agent hallucinated a topic" bug:
 * an EXTERNAL agent workflow must deterministically load its inbox item before
 * the planner runs. Verifies that InboxLoadNodeExecutor resolves the inbox via
 * `context.user.inboxId` (the field buildAgentPrincipal now carries) and writes
 * the picked item into `currentInboxItem` — so the agent prompt's
 * {{currentInboxItem.text}} is populated instead of empty.
 *
 * Run directly: `node server/tests/agent-inbox-load.test.js`.
 */

import { InboxLoadNodeExecutor } from '../services/workflow/executors/InboxLoadNodeExecutor.js';
import inboxStore from '../agents/inbox/inboxStore.js';
import { buildAgentPrincipal } from '../utils/authorization.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

async function run() {
  console.log('🧪 buildAgentPrincipal carries the bound inbox\n');
  {
    const principal = buildAgentPrincipal({ id: 'p1', name: 'P1', inboxId: 'my-inbox' });
    check('principal.inboxId is set from the profile', principal.inboxId === 'my-inbox');
    const noInbox = buildAgentPrincipal({ id: 'p2', name: 'P2' });
    check('principal.inboxId is null without a profile inbox', noInbox.inboxId === null);
  }

  console.log('\n🧪 inbox-load resolves the inbox via context.user.inboxId\n');
  {
    // Use the real bound inbox (resolved through the same getRootDir() the app
    // uses). Verify the executor's pick is self-consistent with the store's
    // open items rather than hardcoding text, so the test survives inbox edits.
    const INBOX_ID = 'claude-style-agent';
    let inbox = null;
    try {
      inbox = await inboxStore.readInbox(INBOX_ID, { status: 'all' });
    } catch (err) {
      console.log(`   ⏭  inbox '${INBOX_ID}' not present in this env — skipping runtime read (${err.message})`);
    }

    if (inbox) {
      const openItems = (inbox.items || []).filter(i => i.status === 'open');
      const exec = new InboxLoadNodeExecutor();
      const node = { id: 'inbox-load', config: {} };
      const state = { executionId: 'wf-exec-test', data: {} };
      // inboxId comes ONLY from context.user.inboxId — exactly the field
      // buildAgentPrincipal now supplies for external inbox workflows.
      const context = {
        chatId: 'wf-exec-test',
        user: { inboxId: INBOX_ID, profileId: INBOX_ID }
      };
      const result = await exec.execute(node, state, context);

      check('node succeeds (inboxId resolved from context.user)', result.status === 'completed', result.error);
      if (openItems.length === 0) {
        check('empty inbox short-circuits the run', result.isTerminal === true);
      } else {
        const item = result.stateUpdates?.currentInboxItem;
        check('currentInboxItem is populated (not empty → no hallucination)', !!item?.text, JSON.stringify(item));
        check(
          'picked item is one of the OPEN inbox items',
          openItems.some(o => o.text === item?.text),
          `picked=${JSON.stringify(item?.text)} open=${JSON.stringify(openItems.map(o => o.text))}`
        );
        check(
          'records inbox metadata for the finalize node',
          result.stateUpdates?._inboxMeta?.inboxId === INBOX_ID
        );
      }
    }
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
