// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The legacy workflow path is frozen (#3788, #3784): the engine that runs the
 * old node types, its executors and the agent modules they import stay as
 * they are while the new engine is built beside them. This test holds a
 * sha256 of every frozen file and fails when one of them changes, when a file
 * is added to a frozen directory, and when one is removed.
 *
 * A change here is a decision, not a refresh:
 *
 * - A security fix to a frozen file updates its hash in the same pull request,
 *   and the pull request says that it is one.
 * - Anything else belongs in the new engine (`server/services/workflow/v2/`),
 *   not in these files.
 *
 * The hash is taken over the text with Windows line ends turned into Unix
 * ones, so a checkout with `core.autocrlf` gives the same hashes.
 *
 * `node server/tests/workflow-legacy-frozen.test.js --print` prints the table
 * for the files as they are now.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Frozen as a whole: every file below these directories, also one that is added later. */
const FROZEN_DIRECTORIES = Object.freeze([
  'server/services/workflow/executors',
  'server/agents/memory',
  'server/agents/inbox',
  'server/agents/runtime'
]);

/** The frozen files with the sha256 of their content. */
const FROZEN = Object.freeze({
  'server/agents/inbox/inboxStore.js':
    '280add701e37c36ac82e55c5c981a7ce85d725dc30dddc31cb6099ef6198e060',
  'server/agents/memory/memoryFile.js':
    '7d9b87e32eafa8fd9ea3335d95d99775c5b674954559dac87e79473c6d161666',
  'server/agents/runtime/agentToolRegistrar.js':
    '41dcc7d1d9b7dee2d296a51644f93f18dda9a6b6956bf6e6daee6a5183bb8b77',
  'server/agents/runtime/artifactStore.js':
    '8a5f0d30357cb4945c3e050a31e2c275d3308b7561739fd5bc939bb4e71c8265',
  'server/agents/runtime/taskRecord.js':
    '0be646d43d502d075c29d748a4800c785a55b088f7b7d66c690eddaad0108543',
  'server/agents/runtime/titleGenerator.js':
    '2537b43a8314876129f33b42dad693651307b49856ad67b3b30f8e606e7966a8',
  'server/services/workflow/DAGScheduler.js':
    '7f74fa2bb674105ed34b0b42d13ad0d8ace1275a708ac84e17c2ca90f223eb0a',
  'server/services/workflow/StateManager.js':
    '18036adca80dc7663f49d7346e022b4883b2506039720dd9bd90617518ae45f6',
  'server/services/workflow/WorkflowEngine.js':
    '3951af26b04ac0358a39e35d02cfb43650385b6d7751290a4fee365a7d0dec72',
  'server/services/workflow/checkpointResume.js':
    '4f4e2ea36dd114adf5e9383ad0e3f1f4431c106bb93d38937d19594459dc8758',
  'server/services/workflow/executors/BaseNodeExecutor.js':
    'c68f01a0e9a27f841474c918a8e425e1abe1bb043322a7d7ecd8c517318f84fa',
  'server/services/workflow/executors/CorpusSearchNodeExecutor.js':
    'b61238af6138fef8d7082084482edd5998db85e3a2363b216fd1a6a35453b2d2',
  'server/services/workflow/executors/DecisionNodeExecutor.js':
    '97193f48b63ddf602e5e99b06b714596d671b6058914aa7987358a874f664851',
  'server/services/workflow/executors/EndNodeExecutor.js':
    '20df1076c6a5094f85c23e82096c322ffc65b4e02e90c5f6a2cecefb2db7a08b',
  'server/services/workflow/executors/HttpNodeExecutor.js':
    '61da6857629734ce09d014edd813fb8208310fbb8123b502d89f9d46e5432599',
  'server/services/workflow/executors/HumanNodeExecutor.js':
    'c9db3d895c488e59dae165ab5e6feaec2f615f1f12ed81c6fae396261fef9eb5',
  'server/services/workflow/executors/InboxFinalizeNodeExecutor.js':
    'f3cced4e6804753733a62f2b141db5647aba61b261a4139814f7a8992c8e2ea5',
  'server/services/workflow/executors/InboxLoadNodeExecutor.js':
    '3c188e4a91dfefeee449247c2eb4a0319c7f973b869511740a484ab4181963fb',
  'server/services/workflow/executors/JoinNodeExecutor.js':
    '14f2b925be60dd3989daef3ba50671d6e43073afe6d70d2de2150040b504dc6b',
  'server/services/workflow/executors/LoopNodeExecutor.js':
    '872cba159f830f8314ac292d3f2d950c02138b6a6800a419baba46358e9969b8',
  'server/services/workflow/executors/MemoryFinalizeNodeExecutor.js':
    'aef1f68e8935490cee59f6bb4de45a91ecac9ce6913c6f495457817be6c4a62d',
  'server/services/workflow/executors/MemoryNodeExecutor.js':
    'e7a3237c660c068c467c034309fc4578cd97d096997e1147362c69b0f228808f',
  'server/services/workflow/executors/ParallelNodeExecutor.js':
    '1293af870192cf7d157e2f5e58f69b956809acf95d788f09b1f9d69f3332fb82',
  'server/services/workflow/executors/PlannerNodeExecutor.js':
    'f3c35af46763d9131410126c6c2f7c46f779a2498b94787e76d5ca9dafb99381',
  'server/services/workflow/executors/ProgressNodeExecutor.js':
    '4fe3e7e26127251e7fd100aa2f364b5015797c747c78a656e45ab13ba15906cc',
  'server/services/workflow/executors/ProjectItemsNodeExecutor.js':
    '72a44a4b23f74930092bcd92b5d8892bdada973430e5916b1224f9815b8f408f',
  'server/services/workflow/executors/ProjectReadNodeExecutor.js':
    'af06855b3acaf80e03cb086f433d28f088aad1fc006a2e62ea07e1ff423f4d12',
  'server/services/workflow/executors/ProjectWriteNodeExecutor.js':
    '0a8413fb89de857a778071b74dfb9083b51631b711fc7c96ed602002bc7dd9d6',
  'server/services/workflow/executors/PromptNodeExecutor.js':
    'ca79e08f9ef85cee3dd3215379c77b1ab2a16bc81f6396af8cf42038d10b6f9f',
  'server/services/workflow/executors/QueryPlanNodeExecutor.js':
    '40796f26baee30b5ea2e59d5f52de48fc716300f63993c0f98b00e3eb4c4c104',
  'server/services/workflow/executors/QuoteValidatorNodeExecutor.js':
    'e8fb8fbc966300d2e5cdd3f40b26854ce053219b42e0c80b586842b259ea8e33',
  'server/services/workflow/executors/StartNodeExecutor.js':
    '12cd4fb78856e9de0693f7b0499fc0fd9e9fb2c83a96b1d493cf1e05a850995a',
  'server/services/workflow/executors/StructuredRecordNodeExecutor.js':
    'b380bc64f127b36221f8b5f16773082d33a7ef001418946cb6e4fbc8fb06a16d',
  'server/services/workflow/executors/TemplateRenderNodeExecutor.js':
    'd8c69223172fae212d89c6c2ba9c6fc277128a23a730f9c0dda850c0a8cabeb9',
  'server/services/workflow/executors/ToolNodeExecutor.js':
    'd7d256ffa5c4baf81f6df01bf8f980ebd3e92569b24ae2cad78d201bc83c3dbe',
  'server/services/workflow/executors/TransformNodeExecutor.js':
    'a37433b7b13523aac4725845aaaafad0b94638461e7bb6f716c40a0850047586',
  'server/services/workflow/executors/VerifierNodeExecutor.js':
    '401e365968b63479656bcd503ef550af7d71573c7fb9e3eb8aa1ef139acbc066',
  'server/services/workflow/executors/index.js':
    '644e8275fdd7e95a45fa65ffb02f4c7f18f6e66badb91e1501fb07ae549fb851',
  'server/tools/agentTools.js': '6c514fbe77dc328b0b449d1901614083fed02f80b08731b1c585552daf9a3a75',
  'server/validators/agentInboxSchema.js':
    '5825323012d964a685b2d80a4470248a4bdefb99fe4bbed0537b5c4619f5e966',
  'server/validators/agentProfileSchema.js':
    'e74c9af1a5496d5b1ce63303236f861c012fef8690e261c470c1ec0c517d1acb'
});

/**
 * The sha256 of a text, with Windows line ends turned into Unix ones.
 *
 * @param {string} text
 * @returns {string}
 */
export function frozenHash(text) {
  return crypto.createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

const read = file => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** Every file below the frozen directories, relative to the repository root, sorted. */
function filesInFrozenDirectories() {
  return FROZEN_DIRECTORIES.flatMap(directory =>
    fs
      .readdirSync(path.join(REPO_ROOT, directory), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry =>
        path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
      )
  ).sort();
}

if (process.argv.includes('--print')) {
  const files = [
    ...new Set([
      ...Object.keys(FROZEN).filter(file => fs.existsSync(path.join(REPO_ROOT, file))),
      ...filesInFrozenDirectories()
    ])
  ].sort();
  for (const file of files) console.log(`  '${file}':\n    '${frozenHash(read(file))}',`);
  process.exit(0);
}

const HOW_TO =
  'The legacy workflow path is frozen (#3788). Only a security fix changes a frozen file; it ' +
  'updates the hash in server/tests/workflow-legacy-frozen.test.js in the same pull request ' +
  '(node server/tests/workflow-legacy-frozen.test.js --print). Other changes belong in the new engine.';

test('no frozen file of the legacy workflow path has changed', () => {
  const changed = [];
  const missing = [];
  for (const [file, expected] of Object.entries(FROZEN)) {
    if (!fs.existsSync(path.join(REPO_ROOT, file))) missing.push(file);
    else if (frozenHash(read(file)) !== expected) changed.push(file);
  }
  assert.deepEqual(missing, [], `Frozen files were removed. ${HOW_TO}`);
  assert.deepEqual(changed, [], `Frozen files were changed. ${HOW_TO}`);
});

test('the frozen directories hold exactly the files of the table', () => {
  const listed = Object.keys(FROZEN).filter(file =>
    FROZEN_DIRECTORIES.some(directory => file.startsWith(`${directory}/`))
  );
  assert.deepEqual(
    filesInFrozenDirectories(),
    [...listed].sort(),
    `A file was added to or removed from a frozen directory. ${HOW_TO}`
  );
});

test('the table names the engine, the scheduler, the state manager and the agent modules', () => {
  // The single files of the frozen set: a line that is dropped from the table would otherwise
  // unfreeze its file without a failure.
  for (const file of [
    'server/services/workflow/WorkflowEngine.js',
    'server/services/workflow/DAGScheduler.js',
    'server/services/workflow/StateManager.js',
    'server/services/workflow/checkpointResume.js',
    'server/tools/agentTools.js',
    'server/validators/agentProfileSchema.js',
    'server/validators/agentInboxSchema.js'
  ]) {
    assert.ok(Object.hasOwn(FROZEN, file), `${file} is missing from the table`);
  }
});

test('one changed byte changes the hash; a Windows line end does not', () => {
  const text = read('server/services/workflow/DAGScheduler.js');
  const expected = FROZEN['server/services/workflow/DAGScheduler.js'];
  assert.equal(frozenHash(text), expected);
  // One byte: the first letter that is not a slash becomes another letter.
  const at = text.search(/[a-z]/);
  const oneByteOff = `${text.slice(0, at)}${text[at] === 'x' ? 'y' : 'x'}${text.slice(at + 1)}`;
  assert.equal(oneByteOff.length, text.length);
  assert.notEqual(frozenHash(oneByteOff), expected);
  // One byte more.
  assert.notEqual(frozenHash(`${text} `), expected);
  assert.equal(frozenHash(text.replaceAll('\n', '\r\n')), expected);
});
