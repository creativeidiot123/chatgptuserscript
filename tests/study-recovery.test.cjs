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
    users: [{}, {}, {}], assistants: [{}, {}, {}], lastUserText: continued ? 'continue' : prompt,
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
    promptText: s => String(s || '').replace(/\r\n?/g, '\n').trim(),
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
    assistantIsCurrentTail: () => context.tailIsCurrent !== false,
    loadTxn: () => context.S.txn,
    loadQueue: () => context.S.queue,
    loadHibernation: () => null,
    reconcileQueueClaim: () => {}, resetVerification: () => {},
    clearTransientNetworkError: () => {},
    clearTxn: () => { context.S.txn = null; },
    setDraft: () => {}, saveTxn: () => {},
  });
  vm.runInContext(section('  function fnv1a(', '  function isProjectUrl('), context);
  vm.runInContext(section('  const STUDY_PROMPT_BASE', '  function protocolMarkerFromExactText('), context);
  vm.runInContext(section('  function userTurnBelongsToTxn(', '  function markerBelongsToTxn('), context);
  vm.runInContext(section('  function beginSubturn(', '  function confirmTxn('), context);
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

test('a human follow-up then recovery cannot inherit the original verifier', async () => {
  const h = harness();
  h.context.beginSubturn('Explain an unrelated topic', 'human-send');
  h.context.beginSubturn('continue', 'recovery');
  h.context.S.txn.userTurnConfirmed = true;
  h.context.S.txn.confirmedUserSig = h.context.signature('continue');
  await h.context.completeLogicalTask('done', h.messages);
  assert.equal(h.context.S.queue.length, 0);
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
    // Each verifier verdict is a new assistant message with its own id.
    h.messages.lastAssistant = { getAttribute: () => `answer-fail-${failure}` };
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

// A chat opened in a new tab or another browser starts with empty tab-local
// state. The rendered auto-verify prompt is then the only ownership evidence.
function freshTab(stage = 'S02', verdict = 'PASS', userTexts = null) {
  const h = harness(stage, verdict, false);
  h.data.clear();
  h.context.S.txn = null;
  if (userTexts) {
    h.messages.users = userTexts.map(textContent => ({ textContent }));
    h.messages.lastUserText = userTexts.at(-1);
  }
  return h;
}

test('a fresh tab adopts the verifier gate from the rendered verify prompt', async () => {
  const h = freshTab();
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 1);
  assert.match(h.context.S.queue[0].text, /^\[STUDYSHIT AUTO STAGE S03\]/);
  assert.equal(h.events[0].event, 'study-gate-adopted');
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 1);
  assert.equal(h.downloads(), 1);
});

test('a fresh tab adopts ownership through literal continue recovery turns', async () => {
  const h = freshTab('S02', 'PASS', ['[STUDYSHIT AUTO VERIFY S02]\nReview', 'continue', 'continue']);
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 1);
  assert.match(h.context.S.queue[0].text, /^\[STUDYSHIT AUTO STAGE S03\]/);
});

test('a fresh tab FAIL queues repair of the same stage', async () => {
  const h = freshTab('S02', 'FAIL');
  await h.context.queueNextStudyStage(h.messages);
  assert.match(h.context.S.queue[0].text, /^\[STUDYSHIT AUTO REPAIR S02\]/);
  assert.equal(h.context.store.get(h.context.studyFailureKey(h.context.S.route, 'S02')), 1);
});

test('a human turn between the verify prompt and continue blocks adoption', async () => {
  const h = freshTab('S02', 'PASS', ['[STUDYSHIT AUTO VERIFY S02]\nReview', 'Explain duration', 'continue']);
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 0);
});

test('DOM evidence for another stage cannot adopt a verdict', async () => {
  const h = freshTab('S02', 'PASS', ['[STUDYSHIT AUTO VERIFY S01]\nReview']);
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 0);
});

test('DOM evidence never overrides a same-stage manual-review stop', async () => {
  const h = freshTab('S03', 'PASS');
  h.context.store.set(h.context.studyGateKey(h.context.S.route), { stage: 'S03', phase: 'manual-review', failures: 3 });
  await h.context.queueNextStudyStage(h.messages);
  assert.equal(h.context.S.queue.length, 0);
});

test('only the auto prompt the tail asks for is current', () => {
  const h = freshTab();
  const msgs = { ...h.messages, lastAssistantText: 'ok\n[[STUDY_VERIFY_PASS:S02]]' };
  assert.equal(h.context.staleStudyPrompt('[STUDYSHIT AUTO VERIFY S02]\nVerify', msgs), true);
  assert.equal(h.context.staleStudyPrompt('[STUDYSHIT AUTO STAGE S03]\nTeach', msgs), false);
  assert.equal(h.context.staleStudyPrompt('A normal queued question', msgs), false);
  const done = { ...msgs, lastAssistantText: 'ok\n[[STUDY_VERIFY_PASS:S07]]' };
  assert.equal(h.context.staleStudyPrompt('[STUDYSHIT AUTO STAGE S03]\nTeach', done), true);
});

test('a sent prompt is recognised from its rendered Markdown bubble', () => {
  const h = harness();
  const prompt = '[STUDYSHIT AUTO STAGE S03]\n**Load** current `state.json` and study.html from GitHub.';
  const rendered = '[STUDYSHIT AUTO STAGE S03] Load current state.json and study.html from GitHub.';
  const t = { currentPrompt: prompt, baselineAssistantSig: h.context.signature('old answer') };
  // Previous identical stage prompt is still the tail: not landed yet.
  h.context.tailIsCurrent = true;
  assert.equal(h.context.promptLanded({ lastUserText: rendered, lastAssistantText: 'old answer' }, t), false);
  // The new user turn now follows the old answer.
  h.context.tailIsCurrent = false;
  assert.equal(h.context.promptLanded({ lastUserText: rendered, lastAssistantText: 'old answer' }, t), true);
  // Or a new answer has started under it.
  h.context.tailIsCurrent = true;
  assert.equal(h.context.promptLanded({ lastUserText: rendered, lastAssistantText: 'new answer' }, t), true);
  assert.equal(h.context.promptLanded({ lastUserText: 'Something else entirely here', lastAssistantText: 'new' }, t), false);
});
