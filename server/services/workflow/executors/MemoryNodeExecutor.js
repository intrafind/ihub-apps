/**
 * Memory node executor.
 *
 * Reads a named section of an agent profile's long-term memory into workflow
 * state. Workflows used to do this through a `readAgentMemorySection`
 * operation on a transform node, which buried a distinct capability inside a
 * step whose name says "reshape data". This is the same read as its own node
 * type, so it reads as what it is on the canvas and gets a form of its own.
 *
 * @module services/workflow/executors/MemoryNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { sliceMemorySection } from '../memorySection.js';
import memoryFile from '../../../agents/memory/memoryFile.js';
import { AGENT_PROFILE_ID_PATTERN } from '../../../validators/agentProfileSchema.js';

/**
 * @typedef {Object} MemoryNodeConfig
 * @property {string} [operation='read'] - Currently only 'read' is supported
 * @property {string} [profileId] - Agent profile whose memory to read
 * @property {string} [profileIdPath] - State path holding the profile id
 * @property {string} section - The `## ` heading to read
 * @property {string} outputVariable - State variable receiving the text
 */

export class MemoryNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    const config = node.config || {};
    const {
      operation = 'read',
      profileId: rawProfileId,
      profileIdPath,
      section,
      outputVariable
    } = config;

    if (operation !== 'read') {
      return this.createErrorResult(`Memory node supports operation 'read'; got '${operation}'.`, {
        nodeId: node.id
      });
    }

    this.validateConfig(node, ['section', 'outputVariable']);

    const profileId = profileIdPath
      ? this.resolveVariable(
          profileIdPath.startsWith('$.') ? profileIdPath : `$.data.${profileIdPath}`,
          state
        )
      : rawProfileId;

    // A missing or unreadable memory is not a workflow failure: the section
    // simply has nothing to contribute, and downstream prompts handle empty
    // context. Failing here would break every run on a profile that has not
    // been populated yet.
    if (typeof profileId !== 'string' || !AGENT_PROFILE_ID_PATTERN.test(profileId)) {
      this.logger?.warn?.('Memory read skipped — invalid profile id', {
        component: 'MemoryNodeExecutor',
        nodeId: node.id,
        profileId
      });
      return this.createSuccessResult(
        { section, bytes: 0, found: false },
        { stateUpdates: { [outputVariable]: '' } }
      );
    }

    try {
      const mem = await memoryFile.readMemory(profileId);
      const text = sliceMemorySection(mem.body, section);
      this.logger?.debug?.('Memory section read', {
        component: 'MemoryNodeExecutor',
        nodeId: node.id,
        profileId,
        section,
        bytes: text.length,
        executionId: context?.executionId
      });
      return this.createSuccessResult(
        { section, bytes: text.length, found: text.length > 0 },
        { stateUpdates: { [outputVariable]: text } }
      );
    } catch (err) {
      this.logger?.warn?.('Memory read failed', {
        component: 'MemoryNodeExecutor',
        nodeId: node.id,
        profileId,
        section,
        error: err.message
      });
      return this.createSuccessResult(
        { section, bytes: 0, found: false },
        { stateUpdates: { [outputVariable]: '' } }
      );
    }
  }
}

export default MemoryNodeExecutor;
