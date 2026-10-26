const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-resilience.user.js'), 'utf8');
test('built-in pure self-test suite passes without browser boot', () => {
  const data = new Map();
  const context = vm.createContext({
    window: {}, URL,
    location: { href: 'https://chatgpt.com/c/test', origin: 'https://chatgpt.com' },
    sessionStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key),
    },
  });
  const end = source.lastIndexOf('  installRouteHooks();');
  assert.ok(end > 0);
  // Keep every production function and the diagnostic export; only skip boot.
  vm.runInContext(source.slice(0, end) + '\n})();', context);
  const results = context.window.ChatGPTResilience.selfTest();
  assert.ok(results.length > 80);
  assert.equal(JSON.stringify(results.filter(result => !result.pass)), '[]');
});

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing source boundary ${from}`);
  return source.slice(start, end);
}

function harness(stage = 'S03', verdict = 'PASS', continued = true) {
  const data = new Map();
  const events = [];
  const prompt = `[STUDYSHIT AUTO VERIFY ${stage}]\nReview the completed stage`;
  const messages = {
    users: [{}, {}, {}], lastUserText: continued ? 'continue' : prompt,
    lastAssistantText: `Checked saved chapter\n[[STUDY_VERIFY_${verdict}:${stage}]]`,
    lastAssistant: { getAttribute: () => 'answer-3' },
  };
  const context = vm.createContext({
    console, Date, Map, Object, String, Number, Math, Promise,
    APP: 'ChatGPT Resilience', PROTOCOL: { CONTINUE: 'continue' },
    TRAILING_PRODUCT_UI_RE: /^(?:sources\b)/i,
    S: { route: 'c:lecture', enabled: true, queue: [], logs: [], lastGenerationEndAt: 0 },
    DC: {},
    store: {
      get: (key, fallback = null) => data.has(key) ? data.get(key) : fallback,
      set: (key, value) => data.set(key, structuredClone(value)),
      del: key => data.delete(key),
    },
    now: () => 1_000,
    norm: s => String(s || '').replace(/\s+/g, ' ').trim(),
    verifyTabContext: () => true,
    getMessages: () => messages,
    log: (event, meta) => events.push({ event, ...meta }),
    maybeNotify: () => {},
    blockAutomation: reason => { context.S.blockedReason = reason; },
    enqueuePrompt: text => {
      const item = { id: `q-${context.S.queue.length}`, text };
      context.S.queue.push(item);
      return item;
    },
    saveQueue: () => {}, renderQueueList: () => {}, kickQueue: () => {},
    loadTxn: () => context.S.txn,
    loadQueue: () => context.S.queue,
    loadHibernation: () => null,
    reconcileQueueClaim: () => {}, resetVerification: () => {},
    clearTransientNetworkError: () => {},
    clearTxn: () => { context.S.txn = null; },
  });
  vm.runInContext(section('  function fnv1a(', '  function isProjectUrl('), context);
  vm.runInContext(section('  const STUDY_PROMPT_BASE', '  function protocolMarkerFromExactText('), context);
  vm.runInContext(section('  function userTurnBelongsToTxn(', '  function markerBelongsToTxn('), context);
  vm.runInContext(section('  async function completeLogicalTask(', '  async function recoverUnconfirmedSend('), context);
  let downloads = 0;
  context.fetchStudyStage = async target => { downloads++; return `Prompt for ${target}`; };
  context.S.txn = {
    id: 'txn-verifier', route: context.S.route, rootPrompt: prompt,
    currentPrompt: messages.lastUserText, userTurnConfirmed: true,
    confirmedUserSig: context.signature(messages.lastUserText),
  };
  context.store.set(context.studyGateKey(context.S.route), {
    stage, phase: 'awaiting-verification', identity: 'previous-completion',
  });
  return { context, messages, data, events, downloads: () => downloads };
}

test('a recovered verifier PASS advances once after its transaction is cleared', async () => {
  const h = harness();
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.txn, null);
  assert.equal(h.context.S.queue.length, 1);
  assert.match(h.context.S.queue[0].text, /^\[STUDYSHIT AUTO STAGE S04\]/);
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 1);
  assert.equal(h.downloads(), 1);
});

test('a recovered verifier FAIL queues repair of the same stage', async () => {
  const h = harness('S03', 'FAIL');
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 1);
  assert.match(h.context.S.queue[0].text, /^\[STUDYSHIT AUTO REPAIR S03\]/);
  assert.equal(h.context.store.get(h.context.studyFailureKey(h.context.S.route, 'S03')), 1);
});

test('a recovered S07 PASS records final verified completion', async () => {
  const h = harness('S07');
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.store.get(h.context.studyGateKey(h.context.S.route)).phase, 'verified');
  assert.equal(h.context.S.queue.length, 0);
});

test('direct verifier completion still advances', async () => {
  const h = harness('S03', 'PASS', false);
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 1);
});

test('unrelated turns cannot claim a pending verifier result', async () => {
  const h = harness();
  h.context.S.txn.rootPrompt = 'An unrelated task';
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 0);
  assert.equal(h.context.store.get(h.context.studyGateKey(h.context.S.route)).phase, 'awaiting-verification');
});

test('unconfirmed or mismatched recovery turns do not own verification', async () => {
  for (const changed of [{ userTurnConfirmed: false }, { confirmedUserSig: 'other' }, { route: 'c:other' }]) {
    const h = harness();
    Object.assign(h.context.S.txn, changed);
    await h.context.completeLogicalTask('done', h.messages);
    assert.equal(h.context.S.queue.length, 0);
  }
});

test('stage mismatch cannot consume verifier evidence', async () => {
  const h = harness();
  h.messages.lastAssistantText = '[[STUDY_VERIFY_PASS:S04]]';
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 0);
});

test('persisted evidence cannot authorize a later unrelated response', async () => {
  const h = harness();
  h.context.fetchStudyStage = async () => { throw new Error('download failed'); };
  await h.context.completeLogicalTask('done', h.messages);
  h.messages.users.push({});
  h.messages.lastAssistantText = 'Different response\n[[STUDY_VERIFY_PASS:S03]]';
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 0);
  assert.equal(h.events.at(-1).event, 'study-unowned-verification-marker');
});

test('a quoted verifier header in an unrelated prompt does not grant ownership', async () => {
  const h = harness('S03', 'PASS', false);
  h.messages.lastUserText = 'Explain this protocol: [STUDYSHIT AUTO VERIFY S03]';
  h.context.S.txn = null;
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 0);
});

test('owned result survives prompt fetch failure and reload without a transaction', async () => {
  const h = harness();
  h.context.fetchStudyStage = async () => { throw new Error('network offline'); };
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 0);
  // Recreate the execution context with only persisted storage, as after reload.
  const reloaded = harness();
  reloaded.data.clear();
  for (const [key, value] of h.data) reloaded.data.set(key, structuredClone(value));
  reloaded.context.S.txn = null;
  await reloaded.context.queueNextStudyStage(reloaded.messages);
  assert.equal(reloaded.context.S.queue.length, 1);
  assert.match(reloaded.context.S.queue[0].text, /^\[STUDYSHIT AUTO STAGE S04\]/);
});

test('repeated FAIL handling counts once and third distinct failure blocks', async () => {
  const h = harness('S03', 'FAIL');
  await h.context.completeLogicalTask('done', h.messages);
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.store.get(h.context.studyFailureKey(h.context.S.route, 'S03')), 1);
  assert.equal(h.context.S.queue.length, 1);
  for (let failure = 2; failure <= 3; failure++) {
    h.context.S.queue = [];
    h.messages.users.push({});
    h.context.store.set(h.context.studyGateKey(h.context.S.route), { stage: 'S03', phase: 'awaiting-verification' });
    h.context.S.txn = {
      id: `txn-${failure}`, route: h.context.S.route,
      rootPrompt: '[STUDYSHIT AUTO VERIFY S03]\nReview', currentPrompt: 'continue',
      userTurnConfirmed: true, confirmedUserSig: h.context.signature('continue'),
    };
    await h.context.completeLogicalTask('done', h.messages);
  }
  assert.equal(h.context.S.blockedReason, 'study-verification-failures');
  assert.equal(h.context.S.queue.length, 0);
});
