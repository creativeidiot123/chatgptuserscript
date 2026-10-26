const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-resilience.user.js'), 'utf8');

function section(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `Missing boundary: ${from}`);
  return source.slice(a, b);
}

function harness() {
  const effects = { reloads: 0, resends: 0, clicks: 0, notifications: 0, writes: [] };
  const input = { isConnected: true, text: '' };
  const messages = { users: [{}], assistants: [{}], lastUserText: 'previous question', lastAssistantText: 'previous answer' };
  const c = vm.createContext({
    console, Date, Math, String, Number, Object, Promise,
    APP: 'ChatGPT Resilience',
    CFG: { sendConfirmMs: 18_000, postReloadReconcileMs: 5_000, maxResendAttempts: 1 },
    S: { enabled: true, automationEpoch: 0, route: 'c:lecture', actionInFlight: false, blockedReason: '', generating: false },
    DC: {}, navigator: { onLine: true },
    now: () => 50_000,
    norm: s => String(s || '').replace(/\s+/g, ' ').trim(),
    promptText: s => String(s || '').replace(/\r\n?/g, '\n').trim(),
    verifyTabContext: () => true,
    isPaused: () => !!c.paused,
    getMessages: () => messages,
    getComposer: () => input,
    composerText: () => input.text,
    setComposerText: (_el, text) => { input.text = text; return true; },
    hasComposerAttachments: () => false,
    assistantIsCurrentTail: () => c.tailCurrent !== false,
    saveTxn: () => effects.writes.push(structuredClone(c.S.txn)),
    clearDraft: () => {}, log: () => {},
    maybeNotify: () => effects.notifications++,
    reloadForRecovery: async () => { effects.reloads++; return true; },
    dispatchPrompt: async () => { effects.resends++; return true; },
    loadTxn: () => c.S.txn,
    renderQueueList: () => {}, ensureQueueButton: () => {}, scheduleEvaluate: () => {},
    beginSubturn: () => { c.S.txn.sendAttempted = false; return c.S.txn; },
  });
  vm.runInContext(section('  function fnv1a(', '  function isProjectUrl('), c);
  vm.runInContext(section('  const looseText', '  function logicalQuietSince('), c);
  vm.runInContext(section('  async function recoverUnconfirmedSend(', '  async function reloadForRecovery('), c);
  c.S.txn = {
    id: 'txn-1', route: c.S.route, currentPrompt: 'New source prompt with Markdown **bold**.',
    currentPromptHash: c.fnv1a(c.norm('New source prompt with Markdown **bold**.')),
    baselineUserCount: 1, baselineUserSig: c.signature(messages.lastUserText),
    baselineAssistantCount: 1, baselineAssistantSig: c.signature(messages.lastAssistantText),
    createdAt: 1, subturnAt: 1, sendAttempted: true, sendObserved: true, userTurnConfirmed: false,
  };
  return { c, effects, input, messages };
}

test('ambiguous attempted send holds without automatic reload or repost', async () => {
  const h = harness();
  await h.c.recoverUnconfirmedSend(h.messages, { id: 'connection-interrupted' });
  assert.equal(h.effects.reloads, 0);
  assert.equal(h.effects.resends, 0);
  assert.equal(h.c.S.txn.holdReason, 'send-unconfirmed');
});

test('reload reconciliation and repeated polls never repost an unconfirmed prompt', async () => {
  for (const sendObserved of [true, false]) {
    const h = harness();
    Object.assign(h.c.S.txn, { sendObserved, reconciledAt: 1, reloadCount: 2 });
    for (let i = 0; i < 5; i++) await h.c.recoverUnconfirmedSend(h.messages, null);
    assert.equal(h.effects.reloads, 0);
    assert.equal(h.effects.resends, 0);
    assert.equal(h.effects.notifications, 1);
    assert.equal(h.input.text, '');
  }
});

test('journal without conclusive delivery evidence also holds', async () => {
  const h = harness();
  Object.assign(h.c.S.txn, { sendAttempted: false, sendObserved: false });
  await h.c.recoverUnconfirmedSend(h.messages, null);
  assert.equal(h.effects.resends, 0);
  assert.equal(h.c.S.txn.holdReason, 'send-unconfirmed');
});

test('confirmation wait does not prematurely hold or send', async () => {
  const h = harness();
  h.c.S.txn.subturnAt = 49_000;
  await h.c.recoverUnconfirmedSend(h.messages, null);
  assert.equal(h.c.S.txn.holdReason, undefined);
  assert.equal(h.effects.reloads + h.effects.resends, 0);
});

test('a landed Markdown prompt with a fixed mounted count confirms and clears an old ambiguity hold', async () => {
  const h = harness();
  h.messages.lastUserText = 'New source prompt with Markdown bold. …Show more';
  h.c.tailCurrent = false;
  h.c.S.txn.holdReason = 'send-unconfirmed';
  await h.c.recoverUnconfirmedSend(h.messages, null);
  assert.equal(h.c.S.txn.userTurnConfirmed, true);
  assert.equal(h.c.S.txn.holdReason, '');
  assert.equal(h.effects.reloads + h.effects.resends, 0);
});

function dispatchHarness() {
  const h = harness();
  vm.runInContext(section('  async function dispatchPrompt(', '  async function sendLiteralContinue('), h.c);
  h.c.waitForSendAction = async () => ({ kind: 'button', run: () => h.effects.clicks++ });
  return h;
}

function installToggle(h) {
  Object.assign(h.c, {
    store: { set: () => {} }, paintUI: () => {},
    cancelRecovery: () => { h.c.S.recovery = null; h.c.S.pendingRecoveryReason = ''; },
    resetVerification: () => { h.c.S.verify = null; },
  });
  vm.runInContext(section('  function setAutomationEnabled(', '  function clearBlock('), h.c);
}

for (const [name, change] of [
  ['disabled', h => { h.c.S.enabled = false; }],
  ['paused', h => { h.c.paused = true; }],
  ['blocked', h => { h.c.S.blockedReason = 'operator-stop'; }],
  ['offline', h => { h.c.navigator.onLine = false; }],
]) {
  test(`Send is vetoed if automation becomes ${name} during composer staging`, async () => {
    const h = dispatchHarness();
    let release;
    h.c.waitForSendAction = () => new Promise(resolve => { release = resolve; });
    const pending = h.c.dispatchPrompt('New work', 'test');
    change(h);
    release({ kind: 'button', run: () => h.effects.clicks++ });
    assert.equal(await pending, false);
    assert.equal(h.effects.clicks, 0);
    assert.equal(h.c.S.actionInFlight, false);
  });
}

test('off then on cannot revive a previously staged send', async () => {
  const h = dispatchHarness();
  installToggle(h);
  let release;
  h.c.waitForSendAction = () => new Promise(resolve => { release = resolve; });
  const pending = h.c.dispatchPrompt('New work', 'test');
  h.c.setAutomationEnabled(false, 'test');
  h.c.setAutomationEnabled(true, 'test');
  release({ kind: 'button', run: () => h.effects.clicks++ });
  assert.equal(await pending, false);
  assert.equal(h.effects.clicks, 0);
});

test('send attempt is durably recorded before native Send is clicked', async () => {
  const h = dispatchHarness();
  h.c.waitForSendAction = async () => ({ kind: 'button', run: () => {
    assert.equal(h.c.S.txn.sendAttempted, true);
    assert.equal(h.effects.writes.at(-1).sendAttempted, true);
    h.effects.clicks++;
  } });
  assert.equal(await h.c.dispatchPrompt('New work', 'test'), true);
  assert.equal(h.effects.clicks, 1);
});

test('turning Off cancels a sleeping recovery even if turned On before grace ends', async () => {
  const h = harness();
  installToggle(h);
  Object.assign(h.c, {
    latestMarker: () => null, hasLiveGenerationEvidence: () => false,
    findStopButton: () => null, isGenerating: () => false,
    sendLiteralContinue: async () => { h.effects.resends++; return true; },
  });
  h.c.S.txn.userTurnConfirmed = true;
  h.input.text = '';
  let release;
  h.c.sleep = () => new Promise(resolve => { release = resolve; });
  vm.runInContext(section('  async function stopThenContinue(', '  function queueCount('), h.c);
  const pending = h.c.stopThenContinue('error:connection-interrupted', { allowBusyStop: true, ignoreAssistantTextProgress: true });
  assert.equal(h.c.S.recovery.phase, 'grace');
  h.c.setAutomationEnabled(false, 'test');
  h.c.setAutomationEnabled(true, 'test');
  release();
  assert.equal(await pending, false);
  assert.equal(h.effects.resends, 0);
});

test('confirmed connection interruption retains the shared Stop/wait/continue path', async () => {
  const h = harness();
  let recovery;
  h.c.S.txn.userTurnConfirmed = true;
  h.c.S.connectionInterruptedSeenAt = 1;
  Object.assign(h.c, {
    connectionInterruptedRecoveryReady: () => true,
    resetVerification: () => {},
    stopThenContinue: async (reason, options) => { recovery = { reason, options }; return true; },
  });
  vm.runInContext(section('  async function handleError(', '  async function maybeRecoverStall('), h.c);
  await h.c.handleError({ id: 'connection-interrupted', kind: 'continue', source: 'rendered' }, h.messages);
  assert.equal(recovery.reason, 'error:connection-interrupted');
  assert.equal(recovery.options.allowBusyStop, true);
  assert.equal(h.effects.resends + h.effects.reloads, 0);
});
