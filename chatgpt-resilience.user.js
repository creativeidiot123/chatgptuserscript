// ==UserScript==
// @name         ChatGPT Resilience
// @namespace    https://chatgpt.com/
// @homepageURL  https://github.com/creativeidiot123/chatgptuserscript
// @supportURL   https://github.com/creativeidiot123/chatgptuserscript/issues
// @updateURL    https://raw.githubusercontent.com/creativeidiot123/chatgptuserscript/main/chatgpt-resilience.user.js
// @downloadURL  https://raw.githubusercontent.com/creativeidiot123/chatgptuserscript/main/chatgpt-resilience.user.js
// @version      1.3.19
// @description  Protocol-first ChatGPT recovery, Codex-style durable queueing, and GitHub Actions hibernation with low-overhead event-driven liveness.
// @author       Ankit + ChatGPT
// @match        https://chatgpt.com/g/*
// @run-at       document-start
// @noframes
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  /*
   * ChatGPT Resilience 1.3.19
   *
   * Core invariant for this dedicated project browser:
   *   NO TERMINAL MARKER = THE LOGICAL TASK IS NOT PROVEN COMPLETE.
   *
   * Terminal markers:
   *   [[CGR_DONE]]                 normal successful completion
   *   [[CGR_HIBERNATE_GITHUB_10M]] suspend the logical task and wake in 10 minutes
   *   [[CGR_WAIT_USER]]            suspend the logical task for human input
   *
   * Recovery policy:
   *   - A confirmed unfinished turn with no text/control progress for 5 minutes
   *     is stopped if needed, held idle for 10 seconds, then resumed with: continue
   *   - Any recognized product/workflow error uses Stop -> 10 seconds -> continue
   *   - The long-thinking banner uses Stop -> 10 seconds -> continue immediately
   *   - Send/Voice appearing after turn work without a terminal marker is an immediate incomplete-turn signal
   *   - Retry/Try again/Regenerate controls are failure signals only; they are never clicked
   *   - There is one continuation path: Stop if needed -> 10s grace -> literal "continue"
   *   - Runtime is hard-gated to https://chatgpt.com/g/* even across SPA navigation.
   *   - All task/queue/recovery state is tab-session local; tabs never coordinate or share ownership.
   *   - Retry / Regenerate are NOT used for confirmed turns. They can destroy partial work.
   *   - A send is retried only when the original can be proven not to have landed.
   *   - Auth, anti-abuse, policy and unsafe upload states fail closed.
   *   - ChatGPT's maximum-conversation-length banner is ignored UI chrome.
   *
   * Performance policy:
   *   - no response-stream cloning
   *   - no full-page text sweeps
   *   - no per-token persistent writes
   *   - tail/composer observers only, with coalescing
   *   - adaptive watchdog: fast only while a logical task is unresolved
   */

  const APP = 'ChatGPT Resilience';
  const VERSION = '1.3.19';
  const PREFIX = 'cgr1:';
  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const PROTOCOL = Object.freeze({
    DONE: '[[CGR_DONE]]',
    HIBERNATE: '[[CGR_HIBERNATE_GITHUB_10M]]',
    WAKE: '[[CGR_WAKE_GITHUB]]',
    WAIT_USER: '[[CGR_WAIT_USER]]',
    CONTINUE: 'continue',
  });

  const CFG = Object.freeze({
    activeWatchdogMs: 1_000,
    idleWatchdogMs: 15_000,
    hiddenWatchdogMs: 30_000,
    structureDebounceMs: 250,
    tailDebounceMs: 300,
    draftWriteDebounceMs: 600,
    answerSettleMs: 1_200,
    incompleteVerifyMs: 5 * 60_000,
    recoveryPauseMs: 10_000,
    intentionalStopNetworkSuppressMs: 15_000,
    composerMissingGraceMs: 12_000,
    controlMismatchGraceMs: 350,
    noStartControlGraceMs: 2_500,
    sendConfirmMs: 18_000,
    sendIntentMs: 8_000,
    postReloadReconcileMs: 5_000,
    interTurnSettleMs: 1_200,
    queuePumpRetryMs: 750,
    queueBlockedRetryMs: 2_000,
    queueStageReadyMs: 3_000,
    stopSettleTimeoutMs: 12_000,
    maxContinuesPerLogicalTask: 8,
    maxResendAttempts: 1,
    maxReloadsPerLogicalTask: 2,
    reloadCooldownMs: 30_000,
    rateFallbackMs: 60_000,
    githubHibernateMs: 10 * 60_000,
    githubWakeBlockedRetryMs: 15_000,
    githubWrongRouteRetryMs: 60_000,
    logLimit: 160,
  });

  const SELECTORS = Object.freeze({
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'textarea[data-id="root"]',
      'form textarea',
    ],
    send: [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
    ],
    voice: [
      'button[data-testid="composer-speech-button"]',
      'button[aria-label="Start voice mode"]',
      'button[aria-label="Start voice conversation"]',
      'button[aria-label="Start voice chat"]',
      'button[aria-label^="Start voice" i]',
    ],
    retry: [
      'button[data-testid*="retry" i]',
      'button[data-testid*="regenerate" i]',
      'button[aria-label="Retry" i]',
      'button[aria-label="Try again" i]',
      'button[aria-label^="Regenerate" i]',
    ],
    user: [
      '[data-message-author-role="user"]',
    ],
    assistant: [
      '[data-message-author-role="assistant"]',
    ],
    streaming: [
      '[aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-streaming="true"]',
    ],
    alerts: [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[data-testid*="error" i]',
    ],
  });


  const ASSISTANT_ERROR_TAIL_RE = /(?:there was an error generating a response|an error occurred (?:while|during) (?:generating|streaming|processing)|something (?:seems to have )?gone wrong(?:\.|!|$| while generating| if this issue persists)|hmm[.!…]*\s*something (?:seems to have )?gone wrong|error in (?:the )?message stream|stream (?:failed|interrupted|closed unexpectedly)|thinking failed|stopped thinking|reasoning stopped|a network error occurred|networkerror when attempting to fetch resource|failed to fetch|fetch failed|error occurred while connecting to the websocket|connection (?:reset|closed|lost|failed|interrupted|terminated)|upstream connect error|disconnect\/reset before headers|conversation not found|(?:unable|failed) to load (?:this )?(?:conversation|chat)|(?:request|message[- ]delivery|response|connection)?\s*timed? out|failed to get (?:a )?response|response (?:interrupted|failed)|too many requests|usage limit|service unavailable|server error|internal server error|bad gateway|gateway time[- ]?out|web server is down|origin is unreachable|overloaded|model (?:is )?(?:currently |temporarily )?unavailable|image generation failed|file upload (?:failed|error)|download failed|file not found|content policy)(?:[.!]|\s|try again|please try again|please start a new (?:chat|conversation))*$/i;
  const ERROR_RULES = [
    { id: 'anti-abuse', kind: 'hard', re: /unusual activity|suspicious activity|verify (?:that )?you are human|captcha|cloudflare challenge|automated traffic|security check|you have been blocked/i },
    { id: 'auth', kind: 'hard', re: /session (?:has )?expired|please (?:log|sign) in|authentication (?:failed|required)|unauthorized|not authenticated/i },
    { id: 'policy', kind: 'hard', re: /content policy|may violate|can(?:not|'t|’t) assist with that|can(?:not|'t|’t) help with that request/i },
    { id: 'artifact-expired', kind: 'hard', re: /download failed|file not found|generated file (?:has )?expired|file (?:has )?expired/i },
    { id: 'file-upload', kind: 'hard', re: /file upload (?:failed|error)|failed to upload|upload failed|failed to process (?:the )?file/i },
    { id: 'rate', kind: 'rate', re: /usage limit|message cap|rate limit|too many requests|try again in\s+\d|limit resets? (?:at|in)|please wait before trying again/i },
    { id: 'conversation-load', kind: 'reload', re: /conversation not found|(?:unable|failed|error) to load (?:this )?(?:conversation|chat)|problem preparing your chat|couldn(?:'|’)t load (?:this )?(?:conversation|chat)|chat not found/i },
    { id: 'network', kind: 'continue', re: /network error|networkerror|failed to fetch|fetch failed|connection (?:error|reset|closed|lost|failed|interrupted|terminated)|websocket|socket (?:error|closed)|disconnected|upstream connect error|disconnect\/reset before headers|transport error|err_network/i },
    { id: 'timeout', kind: 'continue', re: /timed? out|time[- ]?out|took too long|taking too long|response took too long|request took too long|connection timed out|message[- ]delivery (?:timed? out|timeout)|gateway time[- ]?out|err_timed_out|too late/i },
    { id: 'message-stream', kind: 'continue', re: /error in (?:the )?message stream|message stream (?:error|failed|failure)|stream (?:error|failed|failure|interrupted|closed unexpectedly)|incomplete chunked encoding|premature eof/i },
    { id: 'thinking-failed', kind: 'continue', re: /thinking failed|reasoning failed|failed while thinking|stopped thinking|reasoning stopped|stopped reasoning/i },
    { id: 'generation', kind: 'continue', re: /there was an error generating a response|an error occurred (?:while|during) (?:generating|streaming|processing)|something (?:seems to have )?gone wrong|hmm[.!…]*\s*something (?:seems to have )?gone wrong|error generating (?:the )?response|experienced an error|failed to generate (?:the )?(?:response|answer)|failed to get (?:a )?response|response (?:interrupted|failed)|generation interrupted|we encountered an error/i },
    { id: 'server', kind: 'continue', re: /server error|internal server error|service unavailable|temporarily unavailable|overloaded|bad gateway|gateway time[- ]?out|web server is down|origin is unreachable|upstream error|unknown error|model (?:is )?(?:currently |temporarily )?unavailable|model capacity/i },
    { id: 'image-generation', kind: 'continue', re: /image generation failed|failed to generate (?:the )?image|couldn(?:'|’)t generate (?:the )?image/i },
    { id: 'message-send', kind: 'send', re: /message (?:failed|couldn(?:'|’)t|could not) (?:to )?send|failed to send (?:the )?message|unable to send (?:the )?message|error sending (?:the )?message/i },
  ];

  // Runtime persistence is intentionally tab-local. sessionStorage survives a
  // reload in this tab but is not a shared coordination bus between tabs.
  const store = {
    get(key, fallback = null) {
      try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (_) {}
    },
    del(key) {
      try { sessionStorage.removeItem(PREFIX + key); } catch (_) {}
    },
    json(key, fallback = null) {
      return this.get(key, fallback);
    },
    setJson(key, value) {
      this.set(key, value);
    },
  };
  const now = () => Date.now();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const promptText = s => String(s || '').replace(/\r\n?/g, '\n').trim();
  const lower = s => norm(s).toLowerCase();

  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function signature(text) {
    const t = norm(text);
    return `${t.length}:${fnv1a(t.slice(0, 5000))}`;
  }

  function isProjectUrl(href = location.href) {
    try {
      const u = new URL(href, location.origin);
      return u.origin === location.origin && /^\/g\//.test(u.pathname);
    } catch (_) { return false; }
  }

  function routeKey(href = location.href) {
    try {
      const u = new URL(href, location.origin);
      // Regular chats: /c/<id>. Project chats: /g/g-p-.../c/<id>.
      // Conversation IDs are globally unique, so use the trailing /c/<id> as
      // the durable scope in both cases. This is critical for migrating a queue
      // or transaction from a project landing page into the newly-created chat.
      const m = u.pathname.match(/(?:^|\/)c\/([^/?#]+)(?:[/?#]|$)/);
      if (m) return `c:${m[1]}`;
      return `p:${u.pathname.replace(/\/+$/, '') || '/'}`;
    } catch (_) { return 'unknown'; }
  }

  function visible(el) {
    if (!el || !el.isConnected || el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    try {
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
    } catch (_) { return true; }
  }

  function controlVisible(el) {
    if (!visible(el)) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0.02) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return visible(el); }
  }

  function disabled(el) {
    return !el || !!el.disabled || el.getAttribute?.('aria-disabled') === 'true';
  }

  function qFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const list = root.querySelectorAll(sel);
        for (let i = list.length - 1; i >= 0; i--) if (visible(list[i])) return list[i];
      } catch (_) {}
    }
    return null;
  }

  function qAll(selectors, root = document) {
    const out = [], seen = new Set();
    for (const sel of selectors) {
      try {
        for (const el of root.querySelectorAll(sel)) {
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
      } catch (_) {}
    }
    return out;
  }

  function exactButtonLabel(btn) {
    if (!btn) return '';
    // Prefer one semantic label instead of concatenating aria/text/testid. Exact
    // matching against "continue generating" otherwise fails when more than one
    // source is present on the same button.
    const candidates = [
      btn.getAttribute?.('aria-label'),
      btn.textContent,
      btn.getAttribute?.('title'),
      btn.getAttribute?.('data-testid'),
      btn.id,
    ];
    for (const value of candidates) {
      const label = lower(value || '');
      if (label) return label;
    }
    return '';
  }

  const MAX_LENGTH_UI_RE = /(?:you(?:'|’)ve reached the maximum length for this conversation|maximum length for this conversation|keep talking by starting a new chat|start new chat)/i;

  function markerFromProtocolText(text) {
    const clean = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trimEnd();
    if (!clean) return null;
    const tokens = [
      [PROTOCOL.DONE, 'done'],
      [PROTOCOL.HIBERNATE, 'hibernate'],
      [PROTOCOL.WAIT_USER, 'wait-user'],
    ];
    for (const [token, marker] of tokens) {
      const i = clean.lastIndexOf(token);
      if (i < 0) continue;
      const suffix = clean.slice(i + token.length).trim();
      // ChatGPT may append the maximum-length UI after the assistant response.
      // The protocol token itself is intentionally unique, so flattened DOM text
      // such as "...finished.[[CGR_DONE]]" is still authoritative.
      if (!suffix || MAX_LENGTH_UI_RE.test(suffix)) return marker;
    }
    return null;
  }

  function terminalMarker(text, root = null) {
    const rawMarker = markerFromProtocolText(text);
    if (!root) return rawMarker;

    const tokens = [
      [PROTOCOL.DONE, 'done'],
      [PROTOCOL.HIBERNATE, 'hibernate'],
      [PROTOCOL.WAIT_USER, 'wait-user'],
    ];

    // Prefer rendered evidence. Search exact element text first, then exact text
    // nodes because React/Markdown can wrap the marker in a parent whose
    // textContent also includes adjacent content.
    try {
      const nodes = Array.from(root.querySelectorAll('p,div,span,li,h1,h2,h3,h4,h5,h6')).slice(-160).reverse();
      for (const [token, marker] of tokens) {
        const exact = nodes.find(el => {
          if (!visible(el)) return false;
          if (el.closest?.('pre,code,blockquote') || el.querySelector?.('pre,code,blockquote')) return false;
          const value = String(el.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          return value === token;
        });
        if (exact && rawMarker === marker) return marker;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const tailTextNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        tailTextNodes.push(node);
        if (tailTextNodes.length > 240) tailTextNodes.shift();
      }
      for (let i = tailTextNodes.length - 1; i >= 0; i--) {
        const tn = tailTextNodes[i];
        const parent = tn.parentElement;
        if (!parent || !visible(parent) || parent.closest?.('pre,code,blockquote')) continue;
        const value = String(tn.nodeValue || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        for (const [token, marker] of tokens) {
          if (value === token && rawMarker === marker) return marker;
        }
      }
    } catch (_) {}

    // Final fallback for flattened/virtualized ChatGPT DOM. In this dedicated
    // project browser the exact protocol token is the completion contract.
    return rawMarker;
  }

  function classifyError(text) {
    const t = norm(text);
    if (!t) return null;
    for (const rule of ERROR_RULES) {
      const m = t.match(rule.re);
      if (m) return { id: rule.id, kind: rule.kind, text: m[0], sourceText: t.slice(-800) };
    }
    return null;
  }

  function parseWaitMs(text) {
    const t = lower(text);
    let m = t.match(/(?:try again|resets?|wait)[^\d]{0,30}(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
    if (!m) m = t.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const u = m[2].toLowerCase();
    if (u.startsWith('h')) return Math.ceil(n * 3_600_000);
    if (u.startsWith('m')) return Math.ceil(n * 60_000);
    return Math.ceil(n * 1_000);
  }


  function parseResetClockMs(text) {
    const t = String(text || '');
    const m = t.match(/(?:resets?|available again|try again|retry)[^\d]{0,50}(?:at\s*)?(\d{1,2})(?::(\d{2}))\s*(am|pm)?/i);
    if (!m) return 0;
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return 0;
    const ap = String(m[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour > 23) return 0;
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now() + 5_000) d.setDate(d.getDate() + 1);
    return Math.max(0, d.getTime() - now());
  }

  function parseRetryAfterMs(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - now()) : 0;
  }

  function rateWaitMs(text) {
    return Math.max(
      parseWaitMs(text),
      parseResetClockMs(text),
      Math.max(0, Number(S?.rateRetryAt || 0) - now()),
      CFG.rateFallbackMs,
    );
  }

  function log(event, meta = {}) {
    const entry = { at: now(), event, ...meta };
    S.logs.push(entry);
    if (S.logs.length > CFG.logLimit) S.logs.splice(0, S.logs.length - CFG.logLimit);
    try { console.debug(`[${APP}] ${event}`, meta); } catch (_) {}
  }

  function maybeNotify(title, text) {
    try { if (typeof GM_notification === 'function') GM_notification({ title, text, timeout: 9_000 }); } catch (_) {}
  }

  // ---------- durable state ----------------------------------------------------------
  const txnKey = scope => `txn:${scope}`;
  const queueKey = scope => `queue:${scope}`;
  const hibKey = scope => `github:${scope}`;
  const draftKey = scope => `draft:${scope}`;

  const draftWrite = { timer: null, scope: '', text: '' };

  function getDraft(scope = routeKey()) { return String(store.get(draftKey(scope), '') || ''); }

  function cancelPendingDraft(scope = null) {
    if (scope && draftWrite.scope && draftWrite.scope !== scope) return;
    if (draftWrite.timer) clearTimeout(draftWrite.timer);
    draftWrite.timer = null;
    draftWrite.scope = '';
    draftWrite.text = '';
  }

  function flushDraftSave() {
    if (!draftWrite.scope) return;
    const scope = draftWrite.scope;
    const value = draftWrite.text;
    cancelPendingDraft();
    if (norm(value)) store.set(draftKey(scope), value);
    else store.del(draftKey(scope));
  }

  function scheduleDraftSave(text, scope = routeKey()) {
    const value = promptText(text);
    if (draftWrite.timer) clearTimeout(draftWrite.timer);
    draftWrite.scope = scope;
    draftWrite.text = value;
    draftWrite.timer = setTimeout(flushDraftSave, CFG.draftWriteDebounceMs);
  }

  function setDraft(text, scope = routeKey()) {
    cancelPendingDraft(scope);
    const value = promptText(text);
    if (norm(value)) store.set(draftKey(scope), value); else store.del(draftKey(scope));
  }

  function clearDraft(scope = routeKey()) {
    cancelPendingDraft(scope);
    store.del(draftKey(scope));
  }


  function loadTxn(scope = routeKey()) {
    const t = store.json(txnKey(scope), null);
    if (!t || typeof t !== 'object') return null;
    return t.route === scope ? t : null;
  }

  function saveTxn() {
    if (S.txn) store.setJson(txnKey(S.route), S.txn);
    else store.del(txnKey(S.route));
  }

  function clearTxn(reason = 'complete') {
    if (S.txn) log('txn-clear', { reason, source: S.txn.source, continues: S.txn.continueCount || 0 });
    S.txn = null;
    store.del(txnKey(S.route));
    S.verify = null;
    S.recovery = null;
    S.pendingRecoveryReason = '';
    S.composerMissingSince = 0;
    S.controlFault = '';
    kickQueue(`txn-clear:${reason}`, 40);
  }

  function loadQueue(scope = routeKey()) {
    const raw = store.json(queueKey(scope), []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(x => x && typeof x.text === 'string' && norm(x.text)).map(x => ({
      id: String(x.id || crypto.randomUUID?.() || `q-${now()}`),
      text: String(x.text),
      hash: String(x.hash || fnv1a(norm(x.text))),
      createdAt: Number(x.createdAt || now()),
      editedAt: Number(x.editedAt || 0),
    }));
  }

  function saveQueue() {
    store.setJson(queueKey(S.route), S.queue);
    DC.queueFingerprint = '';
  }

  function loadHibernation(scope = routeKey()) {
    const h = store.json(hibKey(scope), null);
    if (!h || typeof h !== 'object' || h.route !== scope) return null;
    if (!['sleeping', 'waking', 'wait-user'].includes(h.phase)) return null;
    return h;
  }

  function saveHibernation() {
    if (S.hib) store.setJson(hibKey(S.route), S.hib);
    else store.del(hibKey(S.route));
  }

  const S = {
    enabled: store.get('enabled', true) !== false,
    projectActive: isProjectUrl(),
    route: routeKey(),
    href: location.href,
    txn: null,
    queue: [],
    queueProcessing: false,
    queueHoldReason: '',
    queueEditingId: '',
    queueEditingOriginalText: '',
    hib: null,
    actionInFlight: false,
    generating: false,
    composerControl: { kind: 'unknown', label: '' },
    error: null,
    pausedUntil: Number(store.get('pausedUntil', 0)) || 0,
    pausedReason: String(store.get('pausedReason', '') || ''),
    blockedReason: String(store.get('blockedReason', '') || ''),
    lastAssistantProgressAt: now(),
    lastControlChangeAt: now(),
    lastNetworkAt: 0,
    lastHttpStatus: 0,
    lastHttpStatusAt: 0,
    lastNetworkFailureAt: 0,
    lastNetworkFailureKind: '',
    suppressTransportErrorsUntil: 0,
    pendingRecoveryReason: '',
    composerMissingSince: 0,
    rateRetryAt: 0,
    lastGenerationEndAt: 0,
    lastGenerationEvidenceAt: 0,
    lastAssistantSig: '',
    lastUserSig: '',
    longThinkingSeenAt: 0,
    longThinkingLastSeenAt: 0,
    logs: [],
    verify: null,
    sendIntent: null,
    recovery: null,
    controlFault: '',
  };
  S.txn = loadTxn(S.route);
  S.queue = loadQueue(S.route);
  S.hib = loadHibernation(S.route);
  store.del('queueUserPaused'); // legacy setting: queueing is always enabled

  const DC = {
    composer: null,
    form: null,
    users: [],
    assistants: [],
    lastUser: null,
    lastAssistant: null,
    messagesDirty: true,
    lastMessageRefreshAt: 0,
    rootObserver: null,
    rootNode: null,
    assistantObserver: null,
    composerObserver: null,
    composerNode: null,
    assistantNode: null,
    longThinkingNode: null,
    evaluateTimer: null,
    evaluateDueAt: 0,
    watchdogTimer: null,
    queuePumpTimer: null,
    queuePumpDueAt: 0,
    wakeTimer: null,
    wakeDueAt: 0,
    queueFingerprint: '',
    uiFingerprint: '',
    queueTray: null,
    queueDragId: '',
  };

  // ---------- DOM adapter -------------------------------------------------------------
  function getComposer() {
    if (DC.composer?.isConnected) return DC.composer;
    DC.composer = qFirst(SELECTORS.composer);
    DC.form = DC.composer?.closest?.('form') || DC.composer?.form || null;
    return DC.composer;
  }

  function composerForm(input = getComposer()) {
    if (input && DC.form?.isConnected && (DC.form.contains(input) || input.form === DC.form)) return DC.form;
    DC.form = input?.closest?.('form') || input?.form || null;
    return DC.form;
  }

  function composerText(el = getComposer()) {
    if (!el) return '';
    if ('value' in el && typeof el.value === 'string') return el.value;
    return el.innerText || el.textContent || '';
  }

  function setComposerText(el, text) {
    if (!el) return false;
    const value = String(text ?? '');
    try {
      el.focus?.();
      if ('value' in el && typeof el.value === 'string') {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement?.prototype || {}, 'value');
        if (desc?.set) desc.set.call(el, value); else el.value = value;
      } else {
        el.textContent = value;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return norm(composerText(el)) === norm(value);
    } catch (_) {
      try {
        if ('value' in el) el.value = value; else el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return norm(composerText(el)) === norm(value);
      } catch (_) { return false; }
    }
  }

  function refreshMessageCache(force = false) {
    const t = now();
    if (!force && !DC.messagesDirty && t - DC.lastMessageRefreshAt < 15_000) return;
    DC.lastMessageRefreshAt = t;
    DC.messagesDirty = false;
    DC.users = qAll(SELECTORS.user).filter(visible);
    DC.assistants = qAll(SELECTORS.assistant).filter(visible);
    DC.lastUser = DC.users.at(-1) || null;
    DC.lastAssistant = DC.assistants.at(-1) || null;
    rebindAssistantObserver();
  }

  function rawNodeText(el) {
    return String(el?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }

  function getMessages(force = false) {
    refreshMessageCache(force);
    return {
      users: DC.users,
      assistants: DC.assistants,
      lastUser: DC.lastUser,
      lastAssistant: DC.lastAssistant,
      lastUserText: rawNodeText(DC.lastUser),
      lastAssistantText: rawNodeText(DC.lastAssistant),
    };
  }

  function assistantIsCurrentTail(msgs = getMessages()) {
    if (!msgs.lastAssistant) return false;
    if (!msgs.lastUser) return true;
    try {
      return !!(msgs.lastUser.compareDocumentPosition(msgs.lastAssistant) & Node.DOCUMENT_POSITION_FOLLOWING);
    } catch (_) { return false; }
  }

  function tailTurnRoot() {
    return DC.lastAssistant?.closest?.('[data-testid^="conversation-turn"],article') || DC.lastAssistant || null;
  }

  function isTailRelevantElement(el) {
    if (!el?.isConnected) return false;
    const assistant = DC.lastAssistant;
    if (!assistant?.isConnected) return true;
    const turn = tailTurnRoot();
    if (turn?.contains?.(el) || assistant.contains?.(el)) return true;

    const ownTurn = el.closest?.('[data-testid^="conversation-turn"],article');
    if (ownTurn && turn && ownTurn !== turn) return false;

    try {
      if (!(assistant.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const form = composerForm(getComposer());
      if (form && !(el.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return true;
    } catch (_) { return false; }
  }

  function findSafeSendButton(input = getComposer()) {
    const form = composerForm(input);
    const roots = form ? [form] : [document];
    for (const root of roots) {
      for (const sel of SELECTORS.send) {
        try {
          for (const b of root.querySelectorAll(sel)) {
            if (!controlVisible(b) || disabled(b)) continue;
            const label = lower(`${b.id || ''} ${b.getAttribute?.('aria-label') || ''} ${b.getAttribute?.('data-testid') || ''}`);
            if (/stop|voice|mic|attach|upload|model|tool|retry|regenerat/.test(label)) continue;
            return b;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  function findStopButton() {
    const form = composerForm(getComposer());
    const roots = form ? [form, document] : [document];
    for (const root of roots) {
      for (const sel of SELECTORS.stop) {
        try {
          const hit = Array.from(root.querySelectorAll(sel)).find(el => controlVisible(el) && !disabled(el));
          if (hit) return hit;
        } catch (_) {}
      }
    }
    return null;
  }

  function findVoiceButton(input = getComposer()) {
    const form = composerForm(input);
    const roots = form ? [form, document] : [document];
    for (const root of roots) {
      for (const sel of SELECTORS.voice) {
        try {
          const hit = Array.from(root.querySelectorAll(sel)).find(el => controlVisible(el) && !disabled(el));
          if (hit) return hit;
        } catch (_) {}
      }
    }
    return null;
  }

  const RETRY_CONTROL_RE = /^(?:retry|try again|regenerate|regenerate response)$/i;

  function retryControlLabel(el) {
    if (!el) return '';
    const values = [
      el.getAttribute?.('aria-label'),
      el.textContent,
      el.getAttribute?.('title'),
      el.getAttribute?.('data-testid'),
    ];
    for (const value of values) {
      const v = norm(value || '');
      if (!v) continue;
      if (RETRY_CONTROL_RE.test(v) || /^retry[-_ ]?button$/i.test(v) || /regenerate/i.test(v)) return v;
    }
    return '';
  }

  function findRetryButton() {
    const turn = tailTurnRoot();

    if (turn) {
      for (const sel of SELECTORS.retry) {
        try {
          const hit = Array.from(turn.querySelectorAll(sel)).find(el => controlVisible(el) && !disabled(el));
          if (hit) return hit;
        } catch (_) {}
      }
    }

    const main = document.querySelector('main');
    if (!main) return null;
    try {
      const buttons = Array.from(main.querySelectorAll('button'));
      for (let i = buttons.length - 1, seen = 0; i >= 0 && seen < 40; i--, seen++) {
        const el = buttons[i];
        if (!isTailRelevantElement(el) || !controlVisible(el) || disabled(el)) continue;
        if (retryControlLabel(el)) return el;
      }
    } catch (_) {}
    return null;
  }

  function findComposerSpinner(input = getComposer()) {
    const form = composerForm(input);
    if (!form) return null;
    const selectors = ['[role="progressbar"]', '[data-state="loading"]', '[data-loading="true"]', '.animate-spin', '[class*="spinner" i]'];
    for (const sel of selectors) {
      try {
        const el = Array.from(form.querySelectorAll(sel)).find(visible);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function hasAssistantBusyEvidence() {
    const assistant = DC.lastAssistant;
    if (!assistant?.isConnected) return false;
    try {
      if (SELECTORS.streaming.some(sel => assistant.matches?.(sel))) return true;
      if (SELECTORS.streaming.some(sel => assistant.querySelector?.(sel))) return true;
      const turn = assistant.closest?.('[data-testid^="conversation-turn"],article');
      if (turn && SELECTORS.streaming.some(sel => turn.querySelector?.(sel))) return true;
    } catch (_) {}
    return false;
  }

  function getComposerControlState() {
    const input = getComposer();
    const hasDraft = !!norm(composerText(input));
    const busyEvidence = hasAssistantBusyEvidence();

    // The composer affordance is only one signal. Typing a human follow-up can
    // legitimately replace Stop with Send while the assistant is still working.
    const stop = findStopButton();
    if (stop && !disabled(stop)) return { kind: 'stop', label: exactButtonLabel(stop), hasDraft, busyEvidence };

    const send = findSafeSendButton(input);
    if (send) return { kind: 'send', label: exactButtonLabel(send), hasDraft, busyEvidence };

    const voice = findVoiceButton(input);
    if (voice) return { kind: 'voice', label: exactButtonLabel(voice), hasDraft, busyEvidence };

    const spinner = findComposerSpinner(input);
    if (spinner) return { kind: 'spinner', label: lower(spinner.getAttribute?.('aria-label') || ''), hasDraft, busyEvidence };

    if (busyEvidence) return { kind: 'streaming', label: '', hasDraft, busyEvidence };
    return { kind: 'idle', label: '', hasDraft, busyEvidence };
  }

  function generationDecision(next, wasGenerating) {
    // Explicit idle controls are trustworthy only when the human draft is gone.
    if (next.kind === 'voice') return false;
    if (next.kind === 'send' && !next.hasDraft) return false;

    const strongBusy = next.kind === 'stop' || next.kind === 'spinner' || next.kind === 'streaming' || next.busyEvidence;
    if (strongBusy) return true;

    // Typing can hide Stop and expose Send. Never let that human-only UI change
    // demote a live generation. Clearing/queueing the draft reveals the real state.
    if (next.kind === 'send' && next.hasDraft && wasGenerating) return true;

    return false;
  }

  function isGenerating() {
    const next = getComposerControlState();
    const prev = S.composerControl || {};
    const t = now();
    const longThinkingBusy = !!DC.longThinkingNode?.isConnected && visible(DC.longThinkingNode);
    const recentAssistantProgress = !!S.txn && t - Number(S.lastAssistantProgressAt || 0) <= CFG.answerSettleMs;
    if (next.kind !== prev.kind || next.busyEvidence !== prev.busyEvidence) S.lastControlChangeAt = t;
    S.composerControl = next;

    const explicitIdle = next.kind === 'voice' || (next.kind === 'send' && !next.hasDraft);
    const strongBusy = !explicitIdle && (next.kind === 'stop' || next.kind === 'spinner' || next.kind === 'streaming' || next.busyEvidence || longThinkingBusy || recentAssistantProgress);
    if (strongBusy) S.lastGenerationEvidenceAt = t;
    const decision = strongBusy ? true : generationDecision(next, S.generating);

    // Typing can replace Stop with Send while the response is still running.
    // Keep that active state until the draft is cleared and real controls return.
    return decision;
  }

  function unfinishedControlSignal(t, marker, control = S.composerControl) {
    if (!t || !t.userTurnConfirmed || t.manualStopped || marker) return '';

    const c = control || {};
    const worked = !!(t.generationObserved || t.assistantObserved);
    const confirmedFor = now() - Number(t.confirmedAt || t.subturnAt || 0);

    // Do not declare a no-start failure during the normal tiny handoff between
    // the user turn appearing and ChatGPT replacing the idle control with Stop.
    if (!worked && confirmedFor < CFG.noStartControlGraceMs) return '';

    if (c.kind === 'voice') {
      if (!worked) return 'voice-no-start';
      return c.busyEvidence ? 'voice-while-busy' : 'voice-without-marker';
    }

    if (c.kind === 'send') {
      // A human draft changes the composer to Send during normal generation.
      // It cannot prove that the assistant stopped, so never fault on it.
      if (c.hasDraft) return '';
      if (!worked) return 'send-no-start';
      return c.busyEvidence ? 'send-while-busy' : 'send-without-marker';
    }

    return '';
  }

  const LONG_THINKING_RE = /our systems are thinking a bit more about this request|thinking a bit more about this request|taking a bit longer to think|still thinking/i;
  function findLongThinkingNotice() {
    // Preserve a previously discovered non-ARIA banner for as long as the exact
    // live node remains visible and still contains the status text. A static
    // banner must not age out merely because React stopped mutating it.
    const cached = DC.longThinkingNode;
    if (cached?.isConnected && visible(cached)) {
      const t = norm(cached.textContent || '');
      const semanticStatus = cached.matches?.('[role="status"],[aria-live]');
      const outsideMessage = !cached.closest?.('[data-message-author-role]');
      if ((semanticStatus || outsideMessage) && t.length <= 1200 && LONG_THINKING_RE.test(t)) return cached;
    }
    DC.longThinkingNode = null;
    const root = document.querySelector('main');
    if (!root) return null;
    try {
      const nodes = root.querySelectorAll('[role="status"],[aria-live]');
      for (let i = Math.max(0, nodes.length - 40); i < nodes.length; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const t = norm(el.textContent || '');
        if (t.length <= 800 && LONG_THINKING_RE.test(t)) { DC.longThinkingNode = el; return el; }
      }
    } catch (_) {}
    return null;
  }

  function updateLongThinking() {
    const hit = findLongThinkingNotice();
    if (hit) {
      DC.longThinkingNode = hit;
      if (!S.longThinkingSeenAt) S.longThinkingSeenAt = now();
      S.longThinkingLastSeenAt = now();
      return true;
    }
    S.longThinkingSeenAt = 0;
    S.longThinkingLastSeenAt = 0;
    return false;
  }

  function collectErrorText(msgs = getMessages()) {
    const chunks = [];
    const tail = msgs.lastAssistantText.slice(-1400);
    if (tail && ASSISTANT_ERROR_TAIL_RE.test(tail)) chunks.push(tail);

    const root = document.querySelector('main') || document;
    const alerts = qAll(SELECTORS.alerts, root).slice(-16);
    for (const el of alerts) {
      if (!controlVisible(el) || !isTailRelevantElement(el)) continue;
      if (el.closest?.('[data-message-author-role="user"]')) continue;
      const t = norm(el.textContent || '');
      if (!t || t.length >= 4000 || MAX_LENGTH_UI_RE.test(t)) continue;
      chunks.push(t);
    }
    return chunks.join('\n').slice(-10_000);
  }

  function classifyHttpStatus(status) {
    const n = Number(status || 0);
    if (!n) return null;
    if (n === 401) return { id: 'auth', kind: 'hard', sourceText: 'HTTP 401' };
    if (n === 403) return { id: 'anti-abuse', kind: 'hard', sourceText: 'HTTP 403' };
    if (n === 429) return { id: 'rate', kind: 'rate', sourceText: 'HTTP 429' };
    if (n === 404) return { id: 'conversation-load', kind: 'reload', sourceText: 'HTTP 404' };
    if (n === 408) return { id: 'timeout', kind: 'continue', sourceText: 'HTTP 408' };
    if ([400, 409, 422, 424, 425].includes(n)) return { id: 'request-failed', kind: 'continue', sourceText: `HTTP ${n}` };
    if (n >= 500 && n <= 599) return { id: 'server', kind: 'continue', sourceText: `HTTP ${n}` };
    return null;
  }

  function suppressIntentionalStopTransportErrors() {
    S.suppressTransportErrorsUntil = Math.max(
      Number(S.suppressTransportErrorsUntil || 0),
      now() + CFG.intentionalStopNetworkSuppressMs,
    );
    S.lastNetworkFailureAt = 0;
    S.lastNetworkFailureKind = '';
  }

  function transportFailureSuppressed() {
    return now() < Number(S.suppressTransportErrorsUntil || 0);
  }

  function noteTransportFailure(kind = 'transport') {
    S.lastNetworkAt = now();
    if (transportFailureSuppressed()) {
      log('transport-failure-suppressed', { kind });
      return;
    }
    S.lastNetworkFailureAt = now();
    S.lastNetworkFailureKind = String(kind || 'transport');
    scheduleEvaluate(`transport-fail:${S.lastNetworkFailureKind}`, 80);
  }

  function clearTransientNetworkError() {
    S.lastNetworkFailureAt = 0;
    S.lastNetworkFailureKind = '';
    S.lastHttpStatus = 0;
    S.lastHttpStatusAt = 0;
  }

  function currentError(msgs = getMessages()) {
    const retry = findRetryButton();
    if (retry) return {
      id: 'retry-control',
      kind: 'continue',
      sourceText: retryControlLabel(retry) || 'Retry control visible',
    };

    const dom = classifyError(collectErrorText(msgs));
    if (dom) return dom;

    const age = now() - Number(S.lastHttpStatusAt || 0);
    if (age < 20_000) {
      const http = classifyHttpStatus(S.lastHttpStatus);
      if (http) return http;
    }

    if (S.lastNetworkFailureAt && now() - S.lastNetworkFailureAt < 20_000 && !transportFailureSuppressed()) {
      return {
        id: S.lastNetworkFailureKind === 'timeout' ? 'timeout' : 'network',
        kind: 'continue',
        sourceText: S.lastNetworkFailureKind || 'transport failure',
      };
    }
    return null;
  }

  function hasComposerAttachments(input = getComposer()) {
    const form = composerForm(input);
    if (!form) return false;
    try { return !!form.querySelector('[data-testid*="attachment" i],[aria-label*="remove file" i],[aria-label*="remove attachment" i]'); }
    catch (_) { return false; }
  }

  function restoreDraftIfSafe() {
    const input = getComposer();
    if (!input || norm(composerText(input)) || hasComposerAttachments(input)) return false;
    const draft = getDraft(S.route);
    if (!norm(draft)) return false;
    return setComposerText(input, draft);
  }

  // ---------- observers ---------------------------------------------------------------
  function rebindAssistantObserver() {
    if (!S.projectActive || !isProjectUrl()) return;
    if (DC.assistantNode === DC.lastAssistant) return;
    try { DC.assistantObserver?.disconnect(); } catch (_) {}
    DC.assistantNode = DC.lastAssistant;
    if (!DC.lastAssistant) return;
    DC.assistantObserver = new MutationObserver(() => {
      if (!S.projectActive || !isProjectUrl()) return;
      S.lastAssistantProgressAt = now();
      if (S.generating) S.lastGenerationEvidenceAt = now();
      scheduleEvaluate('assistant-progress', CFG.tailDebounceMs);
    });
    try {
      DC.assistantObserver.observe(DC.lastAssistant, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'data-is-streaming', 'data-streaming'],
      });
    } catch (_) {}
  }

  function captureLongThinkingFromNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    const insideMessage = !!el.closest?.('[data-message-author-role]');

    const candidates = [];
    if (el.matches?.('[role="status"],[aria-live]')) candidates.push(el);
    if (!insideMessage && (el.childElementCount || 0) <= 12) candidates.push(el);
    try {
      const nested = el.querySelectorAll?.('[role="status"],[aria-live]') || [];
      for (let i = Math.max(0, nested.length - 8); i < nested.length; i++) candidates.push(nested[i]);
    } catch (_) {}

    for (const candidate of candidates) {
      const text = norm(candidate.textContent || '');
      if (text && text.length < 1200 && LONG_THINKING_RE.test(text)) {
        DC.longThinkingNode = candidate;
        S.longThinkingSeenAt ||= now();
        S.longThinkingLastSeenAt = now();
        return true;
      }
    }
    return false;
  }

  function installRootObserver() {
    if (!S.projectActive || !isProjectUrl()) return;
    const root = document.querySelector('main') || document.body;
    if (!root) return;
    try { DC.rootObserver?.disconnect(); } catch (_) {}
    DC.rootNode = root;
    DC.rootObserver = new MutationObserver(records => {
      if (!S.projectActive || !isProjectUrl()) return;
      let structureChanged = false;
      let statusChanged = false;
      let composerChanged = false;
      for (const rec of records) {
        // Token-level DOM churn inside the active assistant is handled by the
        // dedicated tail observer. Do not invalidate the entire message cache.
        if (DC.lastAssistant && (rec.target === DC.lastAssistant || DC.lastAssistant.contains?.(rec.target))) continue;
        // Some status banners keep the same wrapper and only replace a text
        // child. Inspect that small mutation target as well as newly added nodes.
        if (rec.target?.nodeType === 1 && captureLongThinkingFromNode(rec.target)) statusChanged = true;
        for (const node of rec.addedNodes || []) {
          if (captureLongThinkingFromNode(node)) statusChanged = true;
          if (node.nodeType !== 1) continue;
          const el = node;
          if (el.matches?.('[data-message-author-role]') || el.querySelector?.('[data-message-author-role]')) structureChanged = true;
          if (el.matches?.('#prompt-textarea,textarea[name="prompt-textarea"]') || el.querySelector?.('#prompt-textarea,textarea[name="prompt-textarea"]')) composerChanged = true;
          const alertish = el.matches?.('[role="alert"],[data-testid*="error" i]') || el.querySelector?.('[role="alert"],[data-testid*="error" i]');
          let retryish = el.matches?.('button') && !!retryControlLabel(el);
          if (!retryish) {
            try {
              const buttons = Array.from(el.querySelectorAll?.('button') || []).slice(-12);
              retryish = buttons.some(btn => !!retryControlLabel(btn));
            } catch (_) {}
          }
          if (alertish || retryish) statusChanged = true;
        }
        for (const node of rec.removedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (DC.longThinkingNode && (node === DC.longThinkingNode || node.contains?.(DC.longThinkingNode))) DC.longThinkingNode = null;
          if (node.matches?.('[data-message-author-role]') || node.querySelector?.('[data-message-author-role]')) structureChanged = true;
          if (node.matches?.('#prompt-textarea,textarea[name="prompt-textarea"]') || node.querySelector?.('#prompt-textarea,textarea[name="prompt-textarea"]')) composerChanged = true;
        }
      }
      if (structureChanged) DC.messagesDirty = true;
      if (composerChanged) { DC.composer = null; DC.form = null; DC.composerNode = null; }
      if (structureChanged || statusChanged || composerChanged) scheduleEvaluate(structureChanged ? 'structure' : composerChanged ? 'composer-structure' : 'status', CFG.structureDebounceMs);
    });
    try { DC.rootObserver.observe(root, { childList: true, subtree: true }); } catch (_) {}
  }


  function installComposerObserver() {
    if (!S.projectActive || !isProjectUrl()) return;
    const input = getComposer();
    const form = composerForm(input);
    const host = form?.parentElement || form;
    if (!host) return;
    if (DC.composerNode === host && DC.composerObserver) return;
    try { DC.composerObserver?.disconnect(); } catch (_) {}
    DC.composerNode = host;
    DC.composerObserver = new MutationObserver(records => {
      if (!S.projectActive || !isProjectUrl()) return;
      let relevant = false;
      for (const rec of records) {
        // Typing in ProseMirror/contenteditable can produce childList mutations.
        // The input hook already owns draft updates, so ignore those hot-path
        // mutations instead of scheduling a full state evaluation per keystroke.
        if (input && (rec.target === input || input.contains?.(rec.target))) continue;
        const targetEl = rec.target?.nodeType === 1 ? rec.target : rec.target?.parentElement;
        if (targetEl?.closest?.('#cgr-queue-tray')) continue; // our own queue UI churn
        relevant = true;
        break;
      }
      if (!relevant) return;
      DC.composer = null;
      DC.form = null;
      scheduleEvaluate('composer-structure', 80);
    });
    try {
      DC.composerObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-testid', 'aria-label', 'disabled', 'aria-disabled', 'aria-busy'],
      });
    } catch (_) {}
  }

  // ---------- tab-local ownership -----------------------------------------------------
  function verifyTabContext(expectedRoute = S.route) {
    return S.projectActive && isProjectUrl() && S.route === expectedRoute;
  }

  // Human native sends are first represented only as a short-lived in-memory
  // intent. This prevents pointer/click cancellation, autocomplete, or React
  // swallowing Enter from creating a durable transaction for a message that was
  // never actually submitted. The intent is promoted on submit, matching POST,
  // or matching user-turn DOM evidence.
  function setSendIntent(prompt, source, options = {}) {
    flushDraftSave();
    const p = promptText(prompt);
    if (!norm(p)) return null;
    const msgs = getMessages(true);
    S.sendIntent = {
      route: S.route, prompt: p, hash: fnv1a(norm(p)), source, at: now(),
      subturn: !!options.subturn, resumeHib: !!options.resumeHib,
      clearBlocked: !!options.clearBlocked,
      baselineUserCount: msgs.users.length, baselineUserSig: signature(msgs.lastUserText),
      baselineAssistantCount: msgs.assistants.length, baselineAssistantSig: signature(msgs.lastAssistantText),
    };
    log('send-intent', { source, subturn: !!options.subturn });
    return S.sendIntent;
  }

  function validSendIntent() {
    const i = S.sendIntent;
    if (!i) return null;
    if (i.route !== S.route || now() - Number(i.at || 0) > CFG.sendIntentMs) { S.sendIntent = null; return null; }
    return i;
  }

  function promoteSendIntent(evidence = 'unknown') {
    const i = validSendIntent();
    if (!i) return null;
    let t = null;
    if (i.subturn && S.txn) t = beginSubturn(i.prompt, i.source);
    else if (!S.txn) t = armNewTxn(i.prompt, i.source);
    else t = beginSubturn(i.prompt, i.source);
    if (!t) return null;

    // Preserve the pre-send snapshot even if promotion happens after the user
    // turn has already appeared in DOM. This prevents a fast response from being
    // mistaken for the baseline of the new subturn.
    t.baselineUserCount = Number(i.baselineUserCount || 0);
    t.baselineUserSig = String(i.baselineUserSig || '');
    t.baselineAssistantCount = Number(i.baselineAssistantCount || 0);
    t.baselineAssistantSig = String(i.baselineAssistantSig || '');
    t.sendAttempted = true;
    if (evidence === 'network') t.sendObserved = true;
    saveTxn();

    if (i.resumeHib && S.hib && ['sleeping', 'wait-user'].includes(S.hib.phase)) clearHibernation('human-resume-confirmed', { suppressQueueKick: true });
    reconcileQueueClaim('send-intent-promote');
    if (i.clearBlocked && S.blockedReason) clearBlock(`human-send:${evidence}`);
    S.sendIntent = null;
    log('send-intent-promote', { evidence, source: i.source, subturn: i.subturn });
    return t;
  }

  function promoteSendIntentFromDom(msgs) {
    const i = validSendIntent();
    if (!i || !msgs?.lastUserText) return null;
    if (fnv1a(norm(msgs.lastUserText)) !== i.hash) return null;
    return promoteSendIntent('user-dom');
  }

  // ---------- transaction journal -----------------------------------------------------
  function newTxn(prompt, source, queueItemId = null) {
    const msgs = getMessages(true);
    const p = promptText(prompt);
    return {
      schema: 2,
      id: crypto.randomUUID?.() || `txn-${now()}-${Math.random().toString(16).slice(2)}`,
      route: S.route,
      source,
      rootPrompt: p,
      rootPromptHash: fnv1a(norm(p)),
      currentPrompt: p,
      currentPromptHash: fnv1a(norm(p)),
      queueItemId: queueItemId || null,
      createdAt: now(),
      subturnAt: now(),
      dispatchAt: now(),
      baselineUserCount: msgs.users.length,
      baselineUserSig: signature(msgs.lastUserText),
      baselineAssistantCount: msgs.assistants.length,
      baselineAssistantSig: signature(msgs.lastAssistantText),
      userTurnConfirmed: false,
      sendAttempted: false,
      sendObserved: false,
      generationObserved: false,
      assistantObserved: false,
      continueCount: 0,
      resendCount: 0,
      reloadCount: 0,
      reconciledAt: 0,
      nextRecoveryAt: 0,
      manualStopped: false,
      holdReason: '',
    };
  }

  function adoptUntrackedTurn(msgs, source = 'adopt-untracked') {
    if (S.txn || !msgs?.lastUserText) return null;
    if (latestMarker(msgs)) return null;

    const p = promptText(msgs.lastUserText);
    if (!norm(p)) return null;

    const t = newTxn(p, source);
    t.baselineUserCount = Math.max(0, msgs.users.length - 1);
    t.baselineUserSig = '';
    t.baselineAssistantCount = Math.max(0, msgs.assistants.length - 1);
    t.baselineAssistantSig = '';
    t.userTurnConfirmed = true;
    t.confirmedAt = now();
    t.sendAttempted = true;
    t.sendObserved = true;
    t.generationObserved = false;
    t.assistantObserved = !!msgs.lastAssistant;
    t.currentPrompt = p;
    t.currentPromptHash = fnv1a(norm(p));
    t.nextRecoveryAt = 0;
    S.txn = t;
    saveTxn();
    S.verify = null;
    log('txn-adopt', { source, queueItem: !!t.queueItemId });
    return t;
  }

  function armNewTxn(prompt, source, queueItemId = null) {
    const p = promptText(prompt);
    if (!norm(p)) return null;
    if (S.txn && now() - Number(S.txn.subturnAt || 0) < 2_000 && S.txn.currentPromptHash === fnv1a(norm(p))) return S.txn;
    // A caller asking for a new logical task must never accidentally inherit an
    // unrelated transaction that appeared during an await/race. Fail closed.
    if (S.txn) return null;
    S.txn = newTxn(p, source, queueItemId);
    setDraft(p, S.route);
    saveTxn();
    S.verify = null;
    log('txn-arm', { source, queueItem: !!queueItemId, length: p.length });
    return S.txn;
  }

  function beginSubturn(prompt, source) {
    const t = S.txn;
    if (!t) return armNewTxn(prompt, source);
    const msgs = getMessages(true);
    const p = promptText(prompt);
    t.currentPrompt = p;
    t.currentPromptHash = fnv1a(norm(p));
    t.source = source;
    t.subturnAt = now();
    t.dispatchAt = now();
    t.baselineUserCount = msgs.users.length;
    t.baselineUserSig = signature(msgs.lastUserText);
    t.baselineAssistantCount = msgs.assistants.length;
    t.baselineAssistantSig = signature(msgs.lastAssistantText);
    t.userTurnConfirmed = false;
    t.sendAttempted = false;
    t.sendObserved = false;
    t.generationObserved = false;
    t.assistantObserved = false;
    t.manualStopped = false;
    t.holdReason = '';
    t.nextRecoveryAt = 0;
    setDraft(p, S.route);
    saveTxn();
    S.verify = null;
    return t;
  }

  function confirmTxn(msgs) {
    const t = S.txn;
    if (!t || t.route !== S.route) return;
    const lastUserHash = fnv1a(norm(msgs.lastUserText));
    const lastUserChanged = signature(msgs.lastUserText) !== String(t.baselineUserSig || '');
    const countAdvanced = msgs.users.length > Number(t.baselineUserCount || 0) && lastUserChanged;
    const hashMatches = !!msgs.lastUserText && lastUserHash === t.currentPromptHash;
    if (!t.userTurnConfirmed && (hashMatches || countAdvanced)) {
      t.userTurnConfirmed = true;
      t.confirmedAt = now();
      clearDraft(S.route);
      saveTxn();
      log('txn-user-confirmed', { source: t.source, evidence: hashMatches ? 'hash' : 'user-count' });
    }
    const asig = signature(msgs.lastAssistantText);
    if (msgs.assistants.length > Number(t.baselineAssistantCount || 0) || asig !== t.baselineAssistantSig) {
      // Observation is not progress. lastAssistantProgressAt is updated only by
      // an actual signature/DOM mutation in evaluate()/assistantObserver.
      t.assistantObserved = true;
    }
    if (S.generating) t.generationObserved = true;
  }

  function logicalQuietSince() {
    const t = S.txn;
    return Math.max(
      Number(t?.confirmedAt || t?.subturnAt || 0),
      S.lastAssistantProgressAt,
      S.lastControlChangeAt,
      S.lastNetworkAt,
    );
  }

  function latestMarker(msgs = getMessages()) {
    if (!msgs.lastAssistant) return null;
    const direct = terminalMarker(msgs.lastAssistantText, msgs.lastAssistant);
    if (direct) return direct;
    const turn = msgs.lastAssistant.closest?.('[data-testid^="conversation-turn"],article');
    if (!turn) return null;
    return terminalMarker(msgs.lastAssistantText, turn);
  }

  function firstQueueItem(queue = S.queue) {
    return Array.isArray(queue) && queue.length ? queue[0] : null;
  }

  // Queue items are future work only. queueItemId exists briefly so a crash
  // between journaling the transaction and removing the queued item cannot
  // duplicate work. Old hibernation pointers are consumed here for migration.
  function reconcileQueueClaim(reason = 'reconcile') {
    const ids = [...new Set([S.txn?.queueItemId, S.hib?.queueItemId].filter(Boolean))];
    if (!ids.length) return false;

    let removed = false;
    for (const id of ids) {
      const i = S.queue.findIndex(x => x.id === id);
      if (i < 0) continue;
      S.queue.splice(i, 1);
      removed = true;
      log('queue-claim', { id, reason });
    }
    if (removed) saveQueue();

    if (S.txn?.queueItemId) {
      S.txn.queueItemId = null;
      saveTxn();
    }
    if (S.hib?.queueItemId) {
      delete S.hib.queueItemId;
      saveHibernation();
    }
    return removed;
  }

  function clearPause() {
    S.pausedUntil = 0;
    S.pausedReason = '';
    store.set('pausedUntil', 0);
    store.set('pausedReason', '');
  }

  function pauseUntil(ts, reason) {
    S.pausedUntil = Math.max(now(), Number(ts || 0));
    S.pausedReason = String(reason || 'paused');
    store.set('pausedUntil', S.pausedUntil);
    store.set('pausedReason', S.pausedReason);
    log('pause', { reason, until: S.pausedUntil });
    paintUI(true);
  }

  function isPaused() {
    if (S.pausedUntil && S.pausedUntil <= now()) clearPause();
    return S.pausedUntil > now();
  }


  function blockAutomation(reason, message = '') {
    const next = String(reason || 'blocked');
    const changed = S.blockedReason !== next;
    S.blockedReason = next;
    store.set('blockedReason', next);
    if (changed) {
      log('blocked', { reason: next });
      if (message) maybeNotify(`${APP}: waiting for you`, message);
    }
    paintUI(true);
  }

  function clearBlock(reason = 'manual') {
    if (!S.blockedReason) return;
    log('block-clear', { previous: S.blockedReason, reason });
    S.blockedReason = '';
    store.set('blockedReason', '');
    scheduleEvaluate('block-clear', 50);
  }

  // ---------- native send / continue --------------------------------------------------
  function resolveSendAction(input = getComposer()) {
    if (!input) return null;
    const button = findSafeSendButton(input);
    if (button) return { kind: 'button', run: () => button.click() };
    return null;
  }

  async function waitForSendAction(input, expected, timeoutMs = CFG.queueStageReadyMs) {
    const wanted = norm(expected);
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (!input?.isConnected || norm(composerText(input)) !== wanted) return null;
      const action = resolveSendAction(input);
      if (action) return action;
      await sleep(80);
    }
    return input?.isConnected && norm(composerText(input)) === wanted ? resolveSendAction(input) : null;
  }

  async function dispatchPrompt(prompt, source, options = {}) {
    if (!S.enabled || !verifyTabContext() || S.actionInFlight || isPaused()) return false;
    const dispatchRoute = S.route;
    const input = getComposer();
    const p = promptText(prompt);
    if (!input || !norm(p) || hasComposerAttachments(input)) return false;
    if (norm(composerText(input)) !== norm(p) && !setComposerText(input, p)) return false;

    // Reserve the composer before the first await. This prevents the queue pump,
    // GitHub wake, or a second programmatic send from racing the staged prompt
    // while React is still enabling the native Send control.
    S.actionInFlight = true;
    renderQueueList();
    ensureQueueButton();
    try {
      const action = await waitForSendAction(input, p);
      if (!action || S.route !== dispatchRoute) return false;
      if (!verifyTabContext()) return false;
      if (S.route !== dispatchRoute) return false;
      if (!input.isConnected || norm(composerText(input)) !== norm(p)) return false;

      const diskTxn = loadTxn(dispatchRoute);
      if (options.newLogicalTask) {
        if (diskTxn) { S.txn = diskTxn; return false; }
      } else if (S.txn) {
        if (!diskTxn || diskTxn.id !== S.txn.id) { S.txn = diskTxn; return false; }
        S.txn = diskTxn;
      } else if (diskTxn) {
        S.txn = diskTxn;
        return false;
      }

      let queueClaim = null;
      if (options.claimQueueItem) {
        S.queue = loadQueue(dispatchRoute);
        queueClaim = S.queue.find(x => x.id === options.queueItemId) || null;
        if (!queueClaim) return false;
        if (options.expectedQueueHash && queueClaim.hash !== options.expectedQueueHash) return false;
        if (norm(queueClaim.text) !== norm(p)) return false;
      }

      let t;
      if (options.newLogicalTask) t = armNewTxn(p, source, options.queueItemId || null);
      else if (S.txn) t = beginSubturn(p, source);
      else t = armNewTxn(p, source, options.queueItemId || null);
      if (!t) return false;
      if (options.queueItemId) { t.queueItemId = options.queueItemId; saveTxn(); }

      // Journal first, then consume the queued future message. queueItemId is a
      // transient crash-recovery pointer and is cleared by reconciliation.
      if (options.claimQueueItem) reconcileQueueClaim('dispatch-claim');

      if (S.route !== dispatchRoute) return false;
      t.sendObserved = false;
      t.dispatchAt = now();
      saveTxn();
      if (S.route !== dispatchRoute) return false;
      action.run();
      t.sendAttempted = true;
      saveTxn();
      log('dispatch', { source, method: action.kind, queueItem: !!options.queueItemId });
      scheduleEvaluate('dispatch', 120);
      return true;
    } catch (e) {
      log('dispatch-failed', { source, message: String(e?.message || e) });
      return false;
    } finally {
      S.actionInFlight = false;
      renderQueueList();
      ensureQueueButton();
    }
  }


  async function sendLiteralContinue(reason = 'incomplete') {
    if (!verifyTabContext()) return false;
    const t = S.txn;
    if (!t || !t.userTurnConfirmed || t.manualStopped || S.generating || S.actionInFlight || isPaused() || S.blockedReason) return false;
    if (Number(t.continueCount || 0) >= CFG.maxContinuesPerLogicalTask) {
      blockAutomation('continue-safety-cap', 'The same logical task needed too many continuation turns. Queue is preserved; inspect the chat before resuming.');
      return false;
    }
    if (now() < Number(t.nextRecoveryAt || 0)) return false;
    const input = getComposer();
    if (!input || norm(composerText(input)) || hasComposerAttachments(input)) {
      if (!input) S.pendingRecoveryReason = reason;
      return false;
    }
    clearTransientNetworkError();
    // The Stop-triggered abort should have arrived during the 10s grace. Do not
    // let its suppression window hide a genuine failure of the new continuation.
    S.suppressTransportErrorsUntil = 0;
    const nextCount = Number(t.continueCount || 0) + 1;
    const ok = await dispatchPrompt(PROTOCOL.CONTINUE, `continue:${reason}`, { newLogicalTask: false });
    if (!ok || !S.txn) return false;
    S.txn.continueCount = nextCount;
    S.txn.nextRecoveryAt = now() + CFG.recoveryPauseMs;
    saveTxn();
    log('literal-continue', { reason, count: nextCount, cooldown: CFG.recoveryPauseMs });
    return true;
  }

  function postStopControlSettled(control = getComposerControlState()) {
    const c = control || {};
    if (c.kind === 'send' || c.kind === 'voice') return true;
    if (c.kind === 'idle' && !c.busyEvidence) return true;
    return false;
  }

  async function waitForGenerationStop() {
    const deadline = now() + CFG.stopSettleTimeoutMs;
    while (now() < deadline) {
      if (postStopControlSettled()) return true;
      await sleep(250);
    }
    return false;
  }

  async function stopThenContinue(reason = 'recovery') {
    if (!verifyTabContext()) return false;
    const t = S.txn;
    if (!t || !t.userTurnConfirmed || t.manualStopped || isPaused() || S.blockedReason) return false;
    if (latestMarker(getMessages())) return false;

    const recoveryInput = getComposer();
    if (!recoveryInput) {
      S.pendingRecoveryReason = reason;
      S.controlFault = 'composer-missing';
      paintUI(true);
      return false;
    }

    // Human draft owns the composer. Never start Stop -> wait -> continue while
    // the user is typing or an attachment is staged. Queue/send/cancel the draft
    // first; the input hook will re-evaluate recovery once the composer is empty.
    if (norm(composerText(recoveryInput)) || hasComposerAttachments(recoveryInput)) {
      S.pendingRecoveryReason = reason;
      log('recovery-deferred-human-draft', { reason });
      paintUI(true);
      return false;
    }

    const expectedTxnId = t.id;
    if (S.recovery?.txnId === expectedTxnId) return false;
    if (S.actionInFlight) return false;

    const before = getMessages(true);
    const beforeSig = signature(before.lastAssistantText);
    const recovery = { txnId: expectedTxnId, reason, phase: 'stop', startedAt: now() };
    S.recovery = recovery;
    paintUI(true);

    try {
      const stop = findStopButton();

      if (stop && visible(stop) && !disabled(stop)) {
        S.actionInFlight = true;
        try {
          if (!verifyTabContext()) return false;
          const diskTxn = loadTxn(S.route);
          if (!diskTxn || diskTxn.id !== expectedTxnId) { S.txn = diskTxn; return false; }
          S.txn = diskTxn;
          if (!stop.isConnected || disabled(stop) || !controlVisible(stop)) return false;
          suppressIntentionalStopTransportErrors();
          stop.click();
          log('auto-stop', { reason });
        } finally { S.actionInFlight = false; }

        const stopped = await waitForGenerationStop();
        if (!stopped) return false;
        // The long-thinking banner may remain mounted after Stop. Do not feed
        // that stale banner back into normal generation detection here.
        S.generating = false;
        S.lastGenerationEvidenceAt = 0;
        S.lastGenerationEndAt = now();
      } else if (isGenerating()) {
        // A genuinely busy turn without an accessible Stop control is ambiguous,
        // commonly because a human draft is exposing Send. Never destroy the draft.
        scheduleEvaluate(`await-stop:${reason}`, 1_000);
        return false;
      }

      if (S.recovery !== recovery) return false;
      recovery.phase = 'grace';
      recovery.graceAt = now();
      paintUI(true);
      log('recovery-wait', { reason, ms: CFG.recoveryPauseMs });
      await sleep(CFG.recoveryPauseMs);

      // Ten-second grace: any genuine recovery wins over our literal continue.
      if (S.recovery !== recovery) return false;
      if (!S.txn || S.txn.id !== expectedTxnId || S.txn.manualStopped) return false;
      if (!getComposer()) {
        S.pendingRecoveryReason = reason;
        S.controlFault = 'composer-missing';
        return false;
      }
      const after = getMessages(true);
      if (latestMarker(after)) return false;
      if (signature(after.lastAssistantText) !== beforeSig) {
        S.lastAssistantProgressAt = now();
        scheduleEvaluate(`recovery-progress:${reason}`, 500);
        return false;
      }
      // After our own Stop, only live composer/streaming controls can prove the
      // generation restarted. A lingering long-thinking banner cannot.
      if (!postStopControlSettled()) return false;
      S.generating = false;
      return sendLiteralContinue(reason);
    } finally {
      if (S.recovery === recovery) S.recovery = null;
      paintUI(true);
    }
  }

  // ---------- queue -------------------------------------------------------------------
  function queueCount() { return S.queue.length; }
  function queueIndexById(id) { return S.queue.findIndex(x => x.id === id); }

  function enqueuePrompt(text) {
    if (!verifyTabContext()) return null;
    const p = promptText(text);
    if (!norm(p)) return null;
    const item = {
      id: crypto.randomUUID?.() || `q-${now()}-${Math.random().toString(16).slice(2)}`,
      text: p,
      hash: fnv1a(norm(p)),
      createdAt: now(),
      editedAt: 0,
    };
    S.queue.push(item);
    saveQueue();
    log('queue-add', { id: item.id, depth: S.queue.length });
    renderQueueList();
    return item;
  }

  function removeQueueItem(id, reason = 'removed') {
    if (!verifyTabContext() || S.actionInFlight) return false;
    const i = queueIndexById(id);
    if (i < 0) return false;
    S.queue.splice(i, 1);
    saveQueue();
    if (S.queueEditingId === id) cancelQueueEdit('removed');
    log('queue-remove', { id, reason });
    renderQueueList();
    return true;
  }

  function clearPendingQueue() {
    if (!verifyTabContext() || S.actionInFlight) return false;
    if (S.queueEditingId) cancelQueueEdit();
    S.queue = [];
    saveQueue();
    S.queueHoldReason = '';
    renderQueueList();
    return true;
  }

  function clearComposer(input = getComposer()) {
    if (!input) return false;
    const ok = setComposerText(input, '');
    if (ok) clearDraft(S.route);
    return ok;
  }

  function queueCurrentComposer() {
    if (!verifyTabContext() || S.actionInFlight) return false;
    const input = getComposer();
    const p = promptText(composerText(input));
    if (!input || !norm(p)) return false;
    if (hasComposerAttachments(input)) {
      maybeNotify(`${APP}: not queued`, 'Messages with attachments are not queued because attachments cannot be reconstructed safely.');
      return false;
    }
    const item = enqueuePrompt(p);
    if (!item) return false;
    if (!clearComposer(input)) {
      removeQueueItem(item.id, 'composer-clear-failed');
      return false;
    }
    kickQueue('queued', 40);
    return true;
  }

  function captureQueueRects() {
    const m = new Map();
    document.querySelectorAll?.('#cgr-queue-list [data-queue-id]').forEach(el => m.set(el.dataset.queueId, el.getBoundingClientRect()));
    return m;
  }

  function animateQueueReflow(before) {
    if (!before?.size) return;
    requestAnimationFrame(() => {
      document.querySelectorAll?.('#cgr-queue-list [data-queue-id]').forEach(el => {
        const old = before.get(el.dataset.queueId); if (!old) return;
        const next = el.getBoundingClientRect();
        const dy = old.top - next.top;
        if (Math.abs(dy) < 1 || !el.animate) return;
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    });
  }

  function moveQueueItem(id, targetIndex) {
    if (!verifyTabContext() || S.actionInFlight) return false;
    const from = queueIndexById(id);
    if (from < 0) return false;
    const before = captureQueueRects();
    const [item] = S.queue.splice(from, 1);
    const to = Math.max(0, Math.min(S.queue.length, targetIndex > from ? targetIndex - 1 : targetIndex));
    S.queue.splice(to, 0, item);
    saveQueue();
    renderQueueList();
    animateQueueReflow(before);
    return true;
  }

  function beginQueueEdit(id) {
    if (!verifyTabContext() || S.actionInFlight) return false;
    const item = S.queue.find(x => x.id === id);
    const input = getComposer();
    if (!item || !input || norm(composerText(input))) return false;
    clearDraft(S.route);
    S.queueEditingId = id;
    S.queueEditingOriginalText = item.text;
    setComposerText(input, item.text);
    renderQueueList();
    return true;
  }

  function cancelQueueEdit() {
    if (!S.queueEditingId) return;
    const input = getComposer();
    if (input) clearComposer(input);
    S.queueEditingId = '';
    S.queueEditingOriginalText = '';
    renderQueueList();
  }

  function commitQueueEdit() {
    if (!verifyTabContext() || S.actionInFlight) return false;
    const id = S.queueEditingId;
    const item = S.queue.find(x => x.id === id);
    const input = getComposer();
    if (!item || !input) return false;
    const p = promptText(composerText(input));
    if (!norm(p)) { removeQueueItem(id, 'edit-empty'); clearComposer(input); cancelQueueEdit(); return true; }
    item.text = p;
    item.hash = fnv1a(norm(p));
    item.editedAt = now();
    saveQueue();
    clearComposer(input);
    S.queueEditingId = '';
    S.queueEditingOriginalText = '';
    renderQueueList();
    return true;
  }

  async function dispatchQueuedItem(item, source, newLogicalTask) {
    const ok = await dispatchPrompt(item.text, source, {
      newLogicalTask,
      queueItemId: item.id,
      claimQueueItem: true,
      expectedQueueHash: item.hash,
    });
    return ok || (
      !S.queue.some(x => x.id === item.id) &&
      S.txn?.currentPromptHash === item.hash &&
      S.txn?.source === source
    );
  }

  function queueReleaseBlockReason(msgs = getMessages()) {
    if (!assistantIsCurrentTail(msgs) || latestMarker(msgs) !== 'done') return 'waiting-for-cgr-done';
    if (S.error) return `error:${S.error.id || 'unknown'}`;
    if (S.recovery || S.pendingRecoveryReason || S.controlFault) return 'recovery';
    if (S.hib) return `hibernate:${S.hib.phase || 'active'}`;
    if (S.txn) return 'active-task';
    if (S.generating) return 'generating';
    if (S.verify) return 'verifying';
    if (isPaused()) return `paused:${S.pausedReason || 'active'}`;
    if (S.blockedReason) return `blocked:${S.blockedReason}`;
    if (S.actionInFlight) return 'action-in-flight';
    if (S.sendIntent) return 'send-intent';
    if (!navigator.onLine) return 'offline';
    return '';
  }

  function kickQueue(reason = 'event', delay = 0) {
    if (!verifyTabContext() || !S.queue.length) return;
    const due = now() + Math.max(0, delay);
    if (DC.queuePumpTimer && DC.queuePumpDueAt <= due) return;
    if (DC.queuePumpTimer) clearTimeout(DC.queuePumpTimer);
    DC.queuePumpDueAt = due;
    DC.queuePumpTimer = setTimeout(() => {
      DC.queuePumpTimer = null; DC.queuePumpDueAt = 0;
      processQueue().catch(e => log('queue-error', { reason, message: String(e?.message || e) }));
    }, Math.max(0, due - now()));
  }

  async function processQueue() {
    if (!verifyTabContext() || S.queueProcessing || !S.enabled || !S.queue.length) return false;
    const pumpRoute = S.route;

    // DONE is necessary but not sufficient. The same canonical gate also
    // requires every recovery/error/hibernate activity to be fully settled.
    const initialBlock = queueReleaseBlockReason();
    if (initialBlock) {
      S.queueHoldReason = initialBlock;
      return false;
    }
    if (S.lastGenerationEndAt && now() - S.lastGenerationEndAt < CFG.interTurnSettleMs) {
      kickQueue('settle', CFG.interTurnSettleMs);
      return false;
    }

    const input = getComposer();
    if (!input || norm(composerText(input)) || hasComposerAttachments(input)) return false;

    S.queueProcessing = true;
    try {
      if (!verifyTabContext(pumpRoute)) {
        if (S.route === pumpRoute) kickQueue('tab-context', CFG.queueBlockedRetryMs);
        return false;
      }

      // This tab's durable state after async staging is the dispatch truth.
      const diskTxn = loadTxn(pumpRoute);
      const diskHib = loadHibernation(pumpRoute);
      S.txn = diskTxn;
      S.hib = diskHib;
      S.queue = loadQueue(pumpRoute);
      reconcileQueueClaim('queue-pump');

      if (S.route !== pumpRoute) return false;

      const freshMsgs = getMessages(true);
      const freshError = currentError(freshMsgs);
      if (freshError) S.error = freshError;

      // Re-run the exact same gate after durable state and live DOM refresh.
      // This closes races where recovery, an error, or hibernation begins while
      // the pump is staging.
      const freshBlock = queueReleaseBlockReason(freshMsgs);
      if (freshBlock) {
        S.queueHoldReason = freshBlock;
        return false;
      }

      const freshItem = firstQueueItem(S.queue);
      if (!freshItem) {
        S.queueHoldReason = '';
        renderQueueList();
        return false;
      }

      // Re-select the freshly persisted head after async staging so edit/reorder
      // operations in this tab cannot race dispatch.
      const accepted = await dispatchQueuedItem(freshItem, 'queue', true);
      if (!accepted) {
        S.queue = loadQueue(S.route);
        if (norm(composerText(input)) === norm(freshItem.text)) clearComposer(input);
        kickQueue('queue-dispatch-not-ready', CFG.queuePumpRetryMs);
        return false;
      }

      S.queueHoldReason = '';
      return true;
    } finally {
      S.queueProcessing = false;
      renderQueueList();
      paintUI(true);
    }
  }

  // ---------- GitHub hibernation ------------------------------------------------------
  function clearHibernation(reason = 'complete', options = {}) {
    if (S.hib) log('github-clear', { reason, phase: S.hib.phase, cycle: S.hib.cycle || 0 });
    S.hib = null;
    store.del(hibKey(S.route));
    if (DC.wakeTimer) clearTimeout(DC.wakeTimer);
    DC.wakeTimer = null; DC.wakeDueAt = 0;
    if (!options.suppressQueueKick) kickQueue('github-clear', 50);
    paintUI(true);
  }

  function armHibernation() {
    const previous = S.hib;
    S.hib = {
      route: S.route,
      phase: 'sleeping',
      wakeAt: now() + CFG.githubHibernateMs,
      cycle: Number(previous?.cycle || 0) + 1,
      armedAt: now(),
    };
    saveHibernation();
    scheduleWakeTimer();
    paintUI(true);
  }

  function setWaitUser() {
    const entering = S.hib?.phase !== 'wait-user';
    S.hib = {
      route: S.route,
      phase: 'wait-user',
      wakeAt: 0,
      cycle: Number(S.hib?.cycle || 0),
      armedAt: now(),
    };
    saveHibernation();
    if (DC.wakeTimer) clearTimeout(DC.wakeTimer);
    DC.wakeTimer = null; DC.wakeDueAt = 0;
    if (entering) maybeNotify(`${APP}: waiting for you`, 'The current task needs your input.');
    paintUI(true);
  }

  function scheduleWakeTimer(delayOverride = null) {
    if (DC.wakeTimer) clearTimeout(DC.wakeTimer);
    DC.wakeTimer = null; DC.wakeDueAt = 0;
    if (!S.enabled || !S.hib || S.hib.phase !== 'sleeping' || S.hib.route !== S.route) return;
    const delay = delayOverride == null ? Math.max(0, S.hib.wakeAt - now()) : Math.max(0, delayOverride);
    DC.wakeDueAt = now() + delay;
    DC.wakeTimer = setTimeout(() => {
      DC.wakeTimer = null; DC.wakeDueAt = 0;
      attemptGithubWake('timer').catch(e => log('github-wake-error', { message: String(e?.message || e) }));
    }, Math.min(delay + 200, 2_147_000_000));
  }

  async function attemptGithubWake(reason = 'timer', force = false) {
    if (!verifyTabContext() || !S.enabled || !S.hib || S.hib.phase !== 'sleeping') return false;
    if (S.hib.route !== S.route) { scheduleWakeTimer(CFG.githubWrongRouteRetryMs); return false; }
    if (!force && now() < S.hib.wakeAt) { scheduleWakeTimer(); return false; }
    if (!navigator.onLine || isPaused() || S.blockedReason || S.actionInFlight || S.txn || S.generating || S.error) { scheduleWakeTimer(CFG.githubWakeBlockedRetryMs); return false; }
    const input = getComposer();
    if (!input || norm(composerText(input)) || hasComposerAttachments(input)) { scheduleWakeTimer(CFG.githubWakeBlockedRetryMs); return false; }
    const wakeRoute = S.route;
    if (!verifyTabContext(wakeRoute)) { if (S.route === wakeRoute) scheduleWakeTimer(CFG.githubWakeBlockedRetryMs); return false; }
    const diskTxn = loadTxn(wakeRoute);
    const diskHib = loadHibernation(wakeRoute);
    if (diskTxn) { S.txn = diskTxn; scheduleWakeTimer(CFG.githubWakeBlockedRetryMs); return false; }
    if (diskHib) S.hib = diskHib;
    if (!S.hib || S.hib.phase !== 'sleeping') return false;
    S.hib.phase = 'waking';
    S.hib.wakeAt = 0;
    saveHibernation();
    const ok = await dispatchPrompt(PROTOCOL.WAKE, 'github-wake', { newLogicalTask: true });
    if (!ok && !S.txn) {
      S.hib.phase = 'sleeping';
      S.hib.wakeAt = now() + CFG.githubWakeBlockedRetryMs;
      saveHibernation();
      scheduleWakeTimer();
    }
    if (ok) log('github-wake-send', { reason, cycle: S.hib.cycle || 0 });
    return ok;
  }

  // ---------- completion and recovery FSM --------------------------------------------
  function markerBelongsToTxn(msgs, t = S.txn) {
    if (!t || !t.userTurnConfirmed || !assistantIsCurrentTail(msgs) || !msgs.lastUserText) return false;
    return fnv1a(norm(msgs.lastUserText)) === t.currentPromptHash;
  }

  function resetVerification(reason = 'activity') {
    if (S.verify) log('verify-cancel', { reason: S.verify.reason, because: reason });
    S.verify = null;
  }

  function cancelRecovery(reason = 'cancelled') {
    if (S.recovery) {
      log('recovery-cancel', { reason, recoveryReason: S.recovery.reason, phase: S.recovery.phase });
      S.recovery = null;
    }
    S.pendingRecoveryReason = '';
    if (S.controlFault === 'composer-missing') S.controlFault = '';
    paintUI(true);
  }

  function armVerification(msgs, reason) {
    const t = S.txn;
    if (!t || !t.userTurnConfirmed || t.manualStopped) return false;
    const sig = signature(msgs.lastAssistantText);
    const key = `${sig}:${reason}`;
    if (!S.verify || S.verify.key !== key) {
      S.verify = { key, sig, reason, since: now() };
      log('verify-arm', { reason });
      paintUI(true);
    }
    return true;
  }

  async function maybeFinishVerification(msgs, err) {
    const v = S.verify;
    const t = S.txn;
    if (!v || !t || S.generating || t.manualStopped) return false;
    if (signature(msgs.lastAssistantText) !== v.sig) { resetVerification('assistant-changed'); return false; }
    if (now() < Number(t.nextRecoveryAt || 0)) return false;
    if (now() - logicalQuietSince() < CFG.incompleteVerifyMs) return false;
    if (now() - v.since < CFG.incompleteVerifyMs) return false;
    if (err?.kind === 'hard' || err?.kind === 'rate' || err?.kind === 'reload') return false;
    resetVerification('confirmed-dead');
    return stopThenContinue(v.reason);
  }

  function reconcileOrphanTerminalMarker(marker) {
    if (S.txn || !marker) return false;
    if (marker === 'hibernate') {
      if (!S.hib) {
        armHibernation();
        log('orphan-marker-reconcile', { marker });
      }
      return true;
    }
    if (marker === 'wait-user') {
      if (!S.hib || S.hib.phase !== 'wait-user') {
        setWaitUser();
        log('orphan-marker-reconcile', { marker });
      }
      return true;
    }
    return false;
  }

  async function completeLogicalTask(marker, msgs) {
    const t = S.txn;
    if (!t) return false;
    if (!verifyTabContext()) return false;
    const diskTxn = loadTxn(S.route);
    if (!diskTxn || diskTxn.id !== t.id) { S.txn = diskTxn; return false; }
    S.txn = diskTxn;
    S.queue = loadQueue(S.route);
    const diskHib = loadHibernation(S.route);
    if (diskHib) S.hib = diskHib;
    reconcileQueueClaim('terminal-marker');

    // A terminal protocol marker commits the subturn. Stale verifier/error/
    // transport state from the just-finished generation must not veto the next
    // queue step or GitHub wake.
    resetVerification('terminal-marker');
    S.recovery = null;
    S.pendingRecoveryReason = '';
    S.controlFault = '';
    S.error = null;
    clearTransientNetworkError();
    S.suppressTransportErrorsUntil = 0;

    if (marker === 'hibernate') {
      armHibernation();
      clearTxn('hibernate');
      return true;
    }
    if (marker === 'wait-user') {
      setWaitUser();
      clearTxn('wait-user');
      return true;
    }
    if (marker === 'done') {
      if (S.hib) clearHibernation('done-marker');
      S.lastGenerationEndAt = now();
      clearTxn('done-marker');
      maybeNotify(`${APP}: task done`, 'The current task reached [[CGR_DONE]].');
      return true;
    }
    return false;
  }

  async function recoverUnconfirmedSend(msgs, err) {
    const t = S.txn;
    if (!t || t.userTurnConfirmed) return false;
    const elapsed = now() - Number(t.subturnAt || t.createdAt || 0);
    if (elapsed < CFG.sendConfirmMs) return false;

    const lastUserHash = fnv1a(norm(msgs.lastUserText));
    const lastUserChanged = signature(msgs.lastUserText) !== String(t.baselineUserSig || '');
    if (lastUserHash === t.currentPromptHash || (msgs.users.length > Number(t.baselineUserCount || 0) && lastUserChanged)) {
      confirmTxn(msgs); return false;
    }

    // If a request was observed, reconcile by one controlled reload before ever
    // deciding it was unsent. No blind duplicate sends.
    if ((t.sendAttempted || t.sendObserved) && !t.reconciledAt) {
      return reloadForRecovery('ambiguous-send');
    }
    if ((t.sendAttempted || t.sendObserved) && t.reconciledAt && now() - t.reconciledAt < CFG.postReloadReconcileMs) return false;

    if (Number(t.resendCount || 0) >= CFG.maxResendAttempts) {
      if (t.holdReason !== 'send-unconfirmed') {
        t.holdReason = 'send-unconfirmed';
        saveTxn();
        maybeNotify(`${APP}: send needs attention`, 'The last message could not be confirmed after reconciliation. This chat is held without affecting other project chats.');
      }
      return false;
    }

    // At this point there is no user turn, no assistant progress, and either no
    // observed send or a post-reload reconciliation. One resend is safe enough.
    if (msgs.assistants.length > Number(t.baselineAssistantCount || 0)) return false;
    const input = getComposer();
    if (!input || hasComposerAttachments(input)) return false;
    if (norm(composerText(input)) && norm(composerText(input)) !== norm(t.currentPrompt)) return false;
    if (!setComposerText(input, t.currentPrompt)) return false;
    t.resendCount = Number(t.resendCount || 0) + 1;
    t.sendObserved = false;
    t.subturnAt = now();
    t.reconciledAt = 0;
    saveTxn();
    return dispatchPrompt(t.currentPrompt, `resend:${err?.id || 'unconfirmed'}`, { newLogicalTask: false });
  }

  async function reloadForRecovery(reason) {
    const t = S.txn;
    if (!t || S.actionInFlight || isPaused()) return false;
    if (Number(t.reloadCount || 0) >= CFG.maxReloadsPerLogicalTask) return false;
    if (t.lastReloadAt && now() - t.lastReloadAt < CFG.reloadCooldownMs) return false;
    const expectedTxnId = t.id;
    S.actionInFlight = true;
    try {
      if (!verifyTabContext()) return false;
      const diskTxn = loadTxn(S.route);
      if (!diskTxn || diskTxn.id !== expectedTxnId) { S.txn = diskTxn; return false; }
      S.txn = diskTxn;
      const live = S.txn;
      if (Number(live.reloadCount || 0) >= CFG.maxReloadsPerLogicalTask) return false;
      if (live.lastReloadAt && now() - live.lastReloadAt < CFG.reloadCooldownMs) return false;
      live.reloadCount = Number(live.reloadCount || 0) + 1;
      live.lastReloadAt = now();
      live.reconciledAt = now();
      saveTxn();
      log('reload', { reason, count: live.reloadCount });
      location.reload();
      return true;
    } finally {
      // Normally navigation destroys this context. If reload is blocked, unlock.
      setTimeout(() => { S.actionInFlight = false; }, 2_000);
    }
  }

  async function reloadWithoutTxn(reason = 'conversation-load') {
    if (S.actionInFlight || isPaused()) return false;
    const key = `page-reloads:${S.route}`;
    const cutoff = now() - 5 * 60_000;
    const hist = (store.json(key, []) || []).map(Number).filter(x => x > cutoff);
    if (hist.length >= 2) {
      blockAutomation('page-reload-safety-cap', 'ChatGPT still cannot load this conversation after two recovery reloads. Queue is preserved.');
      return false;
    }
    S.actionInFlight = true;
    try {
      if (!verifyTabContext()) return false;
      hist.push(now());
      store.setJson(key, hist);
      log('page-reload', { reason, count: hist.length });
      location.reload();
      return true;
    } finally {
      setTimeout(() => { S.actionInFlight = false; }, 2_000);
    }
  }

  async function handleError(err, msgs) {
    const t = S.txn;
    if (!err) return false;

    // These are not recoverable generation glitches. Do not automate through
    // authentication, anti-abuse, policy, or hard conversation-context gates.
    if (['auth', 'anti-abuse', 'policy'].includes(err.id)) {
      blockAutomation(err.id, `${err.id} needs human attention. Queue and task state are preserved.`);
      return true;
    }

    if (!t) return false;
    if (!t.userTurnConfirmed) return recoverUnconfirmedSend(msgs, err);
    if (t.manualStopped) return false;

    // Every other recognized ChatGPT/product error follows one deterministic
    // recovery path: Stop if possible -> fully idle -> wait 10s -> "continue".
    resetVerification(`error:${err.id}`);
    return stopThenContinue(`error:${err.id}`);
  }
  async function maybeRecoverStall(msgs, longThinking) {
    const t = S.txn;
    if (!t || !t.userTurnConfirmed || t.manualStopped) return false;
    if (latestMarker(msgs)) return false;

    // The purple "our systems are thinking a bit more..." state is treated as
    // a failed turn immediately: Stop -> 10 seconds -> literal continue.
    if (longThinking) return stopThenContinue('long-thinking');

    const quietFor = now() - Math.max(
      S.lastAssistantProgressAt,
      S.lastControlChangeAt,
      Number(t.confirmedAt || t.subturnAt || 0),
    );

    if (quietFor < CFG.incompleteVerifyMs) return false;
    return stopThenContinue('stuck-5m');
  }
  async function evaluate(reason = 'event') {
    detectRouteChange();
    if (!S.projectActive || !isProjectUrl()) return;
    ensureObservers();
    refreshMessageCache();
    const msgs = getMessages();
    promoteSendIntentFromDom(msgs);

    const prevGenerating = S.generating;
    S.generating = isGenerating();
    if (prevGenerating && !S.generating) S.lastGenerationEndAt = now();

    const aSig = signature(msgs.lastAssistantText);
    const uSig = signature(msgs.lastUserText);
    if (aSig !== S.lastAssistantSig) { S.lastAssistantSig = aSig; S.lastAssistantProgressAt = now(); resetVerification('assistant-change'); }
    if (uSig !== S.lastUserSig) S.lastUserSig = uSig;

    confirmTxn(msgs);
    const marker = latestMarker(msgs);
    let err = currentError(msgs);
    // A terminal protocol marker commits the prior turn. Do not let a stale
    // transient toast from that already-committed turn pin the queue forever.
    if (!S.txn && marker && ['continue', 'send', 'reload'].includes(err?.kind || '')) err = null;
    S.error = err;
    const longThinking = updateLongThinking();

    if (!S.enabled) { paintUI(); return; }
    if (!navigator.onLine) { paintUI(); return; }
    if (S.blockedReason) { paintUI(); scheduleWatchdog(); return; }
    if (isPaused()) { paintUI(); scheduleWatchdog(); return; }

    // The exact long-thinking product banner is strong current-turn evidence.
    // If recovery lost its journal, adopt the visible user/assistant tail now
    // instead of waiting for the generic five-minute orphan fallback.
    if (longThinking && !marker && !S.hib && !S.txn && msgs.lastUserText &&
        assistantIsCurrentTail(msgs) && !['auth', 'anti-abuse', 'policy'].includes(err?.id || '')) {
      adoptUntrackedTurn(msgs, 'long-thinking-adopt');
    }

    // Rendered protocol is durable evidence too. If the journal disappeared
    // across reload/update, reconstruct sleep/wait ownership before any queue
    // item can advance.
    if (!S.txn && marker && reconcileOrphanTerminalMarker(marker)) {
      paintUI(true);
      scheduleWatchdog();
      return;
    }

    // A failed UI can outlive the journal after reload/navigation/script install.
    // Recoverable Retry/error states may adopt only the current visible tail.
    if (!S.txn && err && !['auth', 'anti-abuse', 'policy'].includes(err.id)) {
      const adopted = adoptUntrackedTurn(msgs, `error-adopt:${err.id}`);
      if (adopted) {
        await handleError(err, msgs);
        paintUI(true);
        scheduleWatchdog();
        return;
      }
    }

    if (S.txn) {
      const t = S.txn;

      if (longThinking && !t.userTurnConfirmed && msgs.lastUserText && assistantIsCurrentTail(msgs)) {
        confirmTxn(msgs);
        if (!t.userTurnConfirmed && (t.sendAttempted || t.sendObserved || S.generating)) {
          const visiblePrompt = promptText(msgs.lastUserText);
          if (norm(visiblePrompt)) {
            t.currentPrompt = visiblePrompt;
            t.currentPromptHash = fnv1a(norm(visiblePrompt));
            t.userTurnConfirmed = true;
            t.confirmedAt = now();
            t.sendAttempted = true;
            t.sendObserved = true;
            t.assistantObserved = !!msgs.lastAssistant;
            t.generationObserved = true;
            clearDraft(S.route);
            saveTxn();
            log('txn-long-thinking-reconcile', { source: t.source });
          }
        }
      }

      // The protocol marker is authoritative. Once its rendered tail is stable
      // for the short settle window, stale Stop/busy UI cannot veto completion.
      const markerBelongsToCurrentSubturn = markerBelongsToTxn(msgs, t);
      if (marker && markerBelongsToCurrentSubturn && now() - S.lastAssistantProgressAt >= CFG.answerSettleMs) {
        await completeLogicalTask(marker, msgs);
        paintUI(true);
        scheduleWatchdog();
        return;
      }

      // Manual Stop and reconciliation holds are sacred. They belong only to
      // this transaction/chat and never freeze unrelated project conversations.
      if (t.manualStopped || t.holdReason) { paintUI(); scheduleWatchdog(); return; }

      // SPA composer remount/disappearance is a real failure class. Give React a
      // short grace window, then preserve a pending recovery until the composer
      // comes back instead of spinning, reloading, or losing the logical task.
      const composerNow = getComposer();
      if (!composerNow) {
        S.composerMissingSince ||= now();
        if (err && !['auth', 'anti-abuse', 'policy'].includes(err.id)) {
          S.pendingRecoveryReason = `error:${err.id}`;
        } else if (longThinking) {
          S.pendingRecoveryReason = 'long-thinking';
        } else if (now() - S.composerMissingSince >= CFG.composerMissingGraceMs) {
          S.pendingRecoveryReason ||= 'composer-missing';
        }
        if (S.pendingRecoveryReason) S.controlFault = 'composer-missing';
        paintUI(); scheduleWatchdog(); return;
      }

      if (S.composerMissingSince) {
        const missingFor = now() - S.composerMissingSince;
        S.composerMissingSince = 0;
        if (missingFor >= CFG.composerMissingGraceMs && !S.pendingRecoveryReason) {
          S.pendingRecoveryReason = 'composer-remounted';
        }
      }

      if (S.pendingRecoveryReason) {
        const pendingReason = S.pendingRecoveryReason;
        S.pendingRecoveryReason = '';
        if (S.controlFault === 'composer-missing') S.controlFault = '';
        await stopThenContinue(pendingReason);
        paintUI(); scheduleWatchdog(); return;
      }

      // A visible/recognized error owns recovery before any native continuation.
      if (err) {
        await handleError(err, msgs);
        paintUI(); scheduleWatchdog(); return;
      }

      if (!t.userTurnConfirmed) {
        await recoverUnconfirmedSend(msgs, err);
        paintUI(); scheduleWatchdog(); return;
      }

      // Strong UI invariant: after this sub-turn has visibly done work, Stop is
      // the expected primary control until a terminal marker commits the turn.
      // Send/Voice without a marker means ChatGPT has dropped back to an idle
      // composer while our logical task is still unfinished.
      const controlSignal = unfinishedControlSignal(t, marker);
      S.controlFault = controlSignal || '';
      if (controlSignal) {
        if (now() - S.lastControlChangeAt >= CFG.controlMismatchGraceMs) {
          await stopThenContinue(`control:${controlSignal}`);
        } else {
          scheduleEvaluate(`control-grace:${controlSignal}`, CFG.controlMismatchGraceMs);
        }
        paintUI(); scheduleWatchdog(); return;
      }

      S.controlFault = '';

      if (await maybeRecoverStall(msgs, longThinking)) {
        paintUI(); scheduleWatchdog(); return;
      }

      if (S.generating) {
        paintUI(); scheduleWatchdog(); return;
      }

      // Idle + confirmed + no terminal marker remains unfinished. The verifier
      // now waits five full quiet minutes, then uses the same Stop/10s/continue path.
      if (!marker) {
        armVerification(msgs, 'missing-terminal-marker');
        await maybeFinishVerification(msgs, err);
        paintUI(); scheduleWatchdog(); return;
      }
    }

    // A journal can be missing after installation/reload while the rendered tail
    // remains unfinished. The same five-minute no-progress rule may adopt that
    // current tail, but never an active hibernation or a safety-blocked response.
    if (!S.txn && !S.hib && !marker && assistantIsCurrentTail(msgs) && msgs.lastUserText &&
        !['auth', 'anti-abuse', 'policy'].includes(err?.id || '') &&
        now() - S.lastAssistantProgressAt >= CFG.incompleteVerifyMs) {
      const adopted = adoptUntrackedTurn(msgs, 'untracked-stuck-5m');
      if (adopted) {
        await stopThenContinue('untracked-stuck-5m');
        paintUI(true);
        scheduleWatchdog();
        return;
      }
    }

    // No active journal. Account/security/rate states still own the scheduler.
    if (!S.txn && err?.kind === 'hard') {
      blockAutomation(err.id, `${err.id} needs human attention. Queue is preserved.`);
      scheduleWatchdog();
      return;
    }
    if (!S.txn && err?.kind === 'rate') {
      const wait = rateWaitMs(err.sourceText);
      pauseUntil(now() + wait, 'rate-limit');
      scheduleWatchdog();
      return;
    }
    if (!S.txn && err?.kind === 'reload') {
      await reloadWithoutTxn(err.id);
      scheduleWatchdog();
      return;
    }

    // No active journal. Hibernation has priority over ordinary queued work.
    if (S.hib?.phase === 'sleeping' && now() >= Number(S.hib.wakeAt || 0)) await attemptGithubWake('due');
    if (!S.txn && !S.hib && S.queue.length) await processQueue();
    paintUI();
    scheduleWatchdog();
  }

  function removeRuntimeUi() {
    document.getElementById('cgr-root')?.remove();
    document.getElementById('cgr-queue-tray')?.remove();
    document.getElementById('cgr-queue-button')?.remove();
    DC.queueTray = null;
    DC.queueFingerprint = '';
    DC.uiFingerprint = '';
  }

  function deactivateProjectRuntime(reason = 'left-project') {
    try { DC.rootObserver?.disconnect(); } catch (_) {}
    try { DC.assistantObserver?.disconnect(); } catch (_) {}
    try { DC.composerObserver?.disconnect(); } catch (_) {}
    DC.rootObserver = null;
    DC.assistantObserver = null;
    DC.composerObserver = null;
    DC.rootNode = null;
    DC.assistantNode = null;
    DC.composerNode = null;
    DC.composer = null;
    DC.form = null;
    DC.longThinkingNode = null;

    for (const key of ['watchdogTimer', 'queuePumpTimer', 'wakeTimer']) {
      if (DC[key]) clearTimeout(DC[key]);
      DC[key] = null;
    }
    DC.queuePumpDueAt = 0;
    DC.wakeDueAt = 0;
    S.queueProcessing = false;
    S.queueEditingId = '';
    S.queueEditingOriginalText = '';
    S.queueHoldReason = '';
    S.generating = false;
    S.lastGenerationEvidenceAt = 0;
    S.error = null;
    S.verify = null;
    S.sendIntent = null;
    S.recovery = null;
    S.pendingRecoveryReason = '';
    S.controlFault = '';
    removeRuntimeUi();
    log('runtime-off', { reason, href: location.href });
  }

  function activateProjectRuntime(reason = 'entered-project') {
    if (!S.projectActive || !isProjectUrl()) return false;
    DC.messagesDirty = true;
    DC.composer = null;
    DC.form = null;
    refreshMessageCache(true);
    installRootObserver();
    installComposerObserver();
    rebindAssistantObserver();
    reconcileQueueClaim('runtime-activate');
    restoreDraftIfSafe();
    ensureQueueButton();
    renderQueueList();
    scheduleWakeTimer();
    paintUI(true);
    log('runtime-on', { reason, route: S.route });
    return true;
  }

  // ---------- route migration ---------------------------------------------------------
  function projectKeyFromUrl(href = location.href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^\/g\/([^/?#]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function migrateScope(oldScope, newScope, oldHref, newHref) {
    if (!oldScope || !newScope || oldScope === newScope) return;
    const oldProject = projectKeyFromUrl(oldHref);
    const sameProject = !!oldProject && oldProject === projectKeyFromUrl(newHref);
    if (sameProject && oldScope.startsWith('p:') && newScope.startsWith('c:')) {
      const oldTxn = store.json(txnKey(oldScope), null);
      if (oldTxn) { oldTxn.route = newScope; store.setJson(txnKey(newScope), oldTxn); store.del(txnKey(oldScope)); }
      const oldQueue = store.json(queueKey(oldScope), []);
      if (Array.isArray(oldQueue) && oldQueue.length) {
        const existing = store.json(queueKey(newScope), []);
        const ids = new Set((existing || []).map(x => x.id));
        const merged = [...(existing || [])];
        for (const x of oldQueue) if (!ids.has(x.id)) merged.push(x);
        store.setJson(queueKey(newScope), merged); store.del(queueKey(oldScope));
      }
      const oldHib = store.json(hibKey(oldScope), null);
      if (oldHib) { oldHib.route = newScope; store.setJson(hibKey(newScope), oldHib); store.del(hibKey(oldScope)); }
      const oldDraft = String(store.get(draftKey(oldScope), '') || '');
      if (norm(oldDraft) && !store.get(draftKey(newScope), '')) store.set(draftKey(newScope), oldDraft);
      store.del(draftKey(oldScope));
    }
  }

  function detectRouteChange() {
    if (location.href === S.href) return false;

    const old = S.route;
    const oldHref = S.href;
    const wasProject = S.projectActive;
    const nextHref = location.href;
    const nextIsProject = isProjectUrl(nextHref);
    const next = routeKey(nextHref);
    S.href = nextHref;

    if (!nextIsProject) {
      if (wasProject) flushDraftSave();
      S.projectActive = false;
      deactivateProjectRuntime('left-project-route');
      return true;
    }

    S.projectActive = true;

    // Query/hash churn inside the same project conversation is not a state change.
    if (wasProject && next === old) return false;

    if (wasProject) flushDraftSave();

    if (DC.queuePumpTimer) clearTimeout(DC.queuePumpTimer);
    DC.queuePumpTimer = null;
    DC.queuePumpDueAt = 0;
    S.queueProcessing = false;
    S.queueEditingId = '';
    S.queueEditingOriginalText = '';
    S.queueHoldReason = '';
    DC.queueDragId = '';
    DC.queueFingerprint = '';

    if (wasProject) migrateScope(old, next, oldHref, nextHref);
    S.route = next;

    S.txn = loadTxn(next);
    S.queue = loadQueue(next);
    S.hib = loadHibernation(next);
    reconcileQueueClaim('route-change');
    S.verify = null;
    S.sendIntent = null;
    S.recovery = null;
    S.pendingRecoveryReason = '';
    S.composerMissingSince = 0;
    S.controlFault = '';
    S.generating = false;
    S.lastGenerationEvidenceAt = 0;
    clearTransientNetworkError();
    S.suppressTransportErrorsUntil = 0;
    S.lastAssistantSig = '';
    S.lastUserSig = '';
    S.lastAssistantProgressAt = now();
    S.lastControlChangeAt = now();

    activateProjectRuntime(wasProject ? 'project-route-change' : 'returned-to-project');
    scheduleEvaluate('project-route-ready', 50);
    return true;
  }

  // ---------- minimal network observer ------------------------------------------------
  function isConversationRequest(url, method = 'GET') {
    if (!S.projectActive || !isProjectUrl()) return false;
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'POST') return false;
    const u = String(url || '');
    return /(?:\/backend-api\/.*conversation|\/conversation|\/responses)(?:[/?#]|$)/i.test(u);
  }

  function installNetworkObserver() {
    try {
      if (!UW.__CGR1_FETCH_PATCHED__ && typeof UW.fetch === 'function') {
        UW.__CGR1_FETCH_PATCHED__ = true;
        const orig = UW.fetch.bind(UW);
        UW.fetch = async function (input, init = {}) {
          const url = typeof input === 'string' ? input : input?.url || '';
          const method = init?.method || input?.method || 'GET';
          const tracked = isConversationRequest(url, method);
          if (tracked) {
            S.lastNetworkAt = now();
            S.lastNetworkFailureAt = 0;
            S.lastNetworkFailureKind = '';
            S.lastHttpStatus = 0;
            S.lastHttpStatusAt = 0;
            if (validSendIntent()) promoteSendIntent('network');
            if (S.txn && now() - Number(S.txn.dispatchAt || S.txn.subturnAt || 0) < 10_000) { S.txn.sendObserved = true; saveTxn(); }
          }
          try {
            const res = await orig(input, init);
            if (tracked) {
              S.lastNetworkAt = now();
              S.lastNetworkFailureAt = 0;
              S.lastNetworkFailureKind = '';
              S.lastHttpStatus = Number(res?.status || 0);
              S.lastHttpStatusAt = now();
              if (S.lastHttpStatus === 429) {
                const retryMs = parseRetryAfterMs(res?.headers?.get?.('retry-after'));
                if (retryMs) S.rateRetryAt = now() + retryMs;
              }
              scheduleEvaluate('fetch-end', 80);
            }
            return res;
          } catch (e) {
            if (tracked) noteTransportFailure(e?.name === 'AbortError' ? 'abort' : 'fetch');
            throw e;
          }
        };
      }
    } catch (e) { log('fetch-hook-failed', { message: String(e?.message || e) }); }

    try {
      const X = UW.XMLHttpRequest;
      if (X?.prototype && !X.prototype.__CGR1_PATCHED__) {
        X.prototype.__CGR1_PATCHED__ = true;
        const open = X.prototype.open;
        const send = X.prototype.send;
        X.prototype.open = function (method, url, ...rest) {
          this.__cgr1Method = method; this.__cgr1Url = url;
          return open.call(this, method, url, ...rest);
        };
        X.prototype.send = function (...args) {
          const tracked = isConversationRequest(this.__cgr1Url, this.__cgr1Method);
          if (tracked) {
            S.lastNetworkAt = now();
            S.lastNetworkFailureAt = 0;
            S.lastNetworkFailureKind = '';
            S.lastHttpStatus = 0;
            S.lastHttpStatusAt = 0;
            this.__cgr1TransportFailed = false;
            if (validSendIntent()) promoteSendIntent('network');
            if (S.txn && now() - Number(S.txn.dispatchAt || S.txn.subturnAt || 0) < 10_000) { S.txn.sendObserved = true; saveTxn(); }

            const fail = kind => {
              this.__cgr1TransportFailed = true;
              noteTransportFailure(kind);
            };
            this.addEventListener('error', () => fail('xhr-error'), { once: true });
            this.addEventListener('timeout', () => fail('timeout'), { once: true });
            this.addEventListener('abort', () => fail('abort'), { once: true });
            this.addEventListener('loadend', () => {
              S.lastNetworkAt = now();
              S.lastHttpStatus = Number(this.status || 0);
              S.lastHttpStatusAt = now();
              if (!this.__cgr1TransportFailed && S.lastHttpStatus > 0) {
                S.lastNetworkFailureAt = 0;
                S.lastNetworkFailureKind = '';
              }
              if (S.lastHttpStatus === 429) {
                const retryMs = parseRetryAfterMs(this.getResponseHeader?.('Retry-After'));
                if (retryMs) S.rateRetryAt = now() + retryMs;
              }
              scheduleEvaluate('xhr-end', 80);
            }, { once: true });
          }
          return send.apply(this, args);
        };
      }
    } catch (e) { log('xhr-hook-failed', { message: String(e?.message || e) }); }
  }

  // ---------- input hooks -------------------------------------------------------------
  function isComposerTarget(target) {
    const input = getComposer();
    return !!input && (target === input || input.contains?.(target));
  }

  function isSendButtonTarget(target) {
    const b = target?.closest?.('button');
    if (!b) return false;
    const known = findSafeSendButton();
    if (known && (b === known || known.contains?.(target))) return true;
    const l = exactButtonLabel(b);
    return /send|submit/.test(l) && !/stop|retry|regenerat|attach|model|tool/.test(l);
  }

  function isStopButtonTarget(target) {
    const b = target?.closest?.('button');
    if (!b) return false;
    const stop = findStopButton();
    return b === stop || /stop generating|stop response/.test(exactButtonLabel(b));
  }

  function hasComposerPopup(input = getComposer()) {
    if (!input) return false;
    try {
      if (input.getAttribute?.('aria-expanded') === 'true') return true;
      const active = input.getAttribute?.('aria-activedescendant'); if (active && visible(document.getElementById(active))) return true;
      const form = composerForm(input); if (form && Array.from(form.querySelectorAll('[role="listbox"],[role="menu"]')).some(visible)) return true;
    } catch (_) {}
    return false;
  }

  function humanSendMustQueue() {
    // The evaluator owns clearing S.generating. Human input may respect it or
    // promote it from fresh busy evidence, but it never demotes it.
    if (S.generating) return true;

    // Input handlers may only promote idle -> generating from fresh independent
    // evidence. The evaluator remains the sole owner of clearing S.generating.
    const next = getComposerControlState();

    // If the evaluator already considers the turn idle, a real idle composer
    // control should remain usable immediately.
    if (next.kind === 'voice' || (next.kind === 'send' && !next.hasDraft)) return false;

    const longThinkingBusy = !!DC.longThinkingNode?.isConnected && visible(DC.longThinkingNode);
    const recentAssistantProgress = !!S.txn && now() - Number(S.lastAssistantProgressAt || 0) <= CFG.answerSettleMs;
    const busy = next.kind === 'stop' || next.kind === 'spinner' || next.kind === 'streaming' ||
      next.busyEvidence || longThinkingBusy || recentAssistantProgress;
    if (!busy) return false;

    S.composerControl = next;
    S.generating = true;
    S.lastGenerationEvidenceAt = now();
    return true;
  }

  function interceptBusyHumanSend(input = getComposer()) {
    if (!humanSendMustQueue()) return false;
    if (hasComposerAttachments(input)) {
      maybeNotify(`${APP}: wait for current response`, 'This message has attachments, so it cannot be queued safely. It was not sent.');
      return true;
    }
    queueCurrentComposer();
    return true;
  }

  function installInputHooks() {
    document.addEventListener('input', e => {
      if (!S.projectActive || !isProjectUrl()) return;
      if (isComposerTarget(e.target)) {
        if (S.queueEditingId) {
          cancelPendingDraft(S.route);
          ensureQueueButton();
          renderQueueList();
          return;
        }
        const txt = promptText(composerText(e.target));
        if (norm(txt)) scheduleDraftSave(txt, S.route);
        else {
          if (!validSendIntent()) clearDraft(S.route);
          kickQueue('composer-cleared', 80);
          if (S.txn || S.controlFault || S.pendingRecoveryReason) scheduleEvaluate('composer-cleared-recovery', 50);
        }
        ensureQueueButton();
        renderQueueList();
      }
    }, true);

    // A real click is the trustworthy boundary for native Stop/Send controls.
    // Script-generated HTMLElement.click() events are untrusted and must not be
    // mistaken for human intervention.
    document.addEventListener('click', e => {
      if (!S.projectActive || !isProjectUrl()) return;
      if (isStopButtonTarget(e.target)) {
        if (e.isTrusted && !S.actionInFlight && S.txn) {
          cancelRecovery('manual-stop');
          suppressIntentionalStopTransportErrors();
          S.txn.manualStopped = true;
          saveTxn();
          resetVerification('manual-stop');
          paintUI(true);
        }
        return;
      }
      if (!isSendButtonTarget(e.target)) return;
      if (S.actionInFlight) {
        // HTMLElement.click() from our own dispatcher is untrusted and must pass.
        if (e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); }
        return;
      }
      if (S.queueEditingId) { e.preventDefault(); e.stopImmediatePropagation(); commitQueueEdit(); return; }
      const input = getComposer();
      const p = promptText(composerText(input));
      const hasAttachments = hasComposerAttachments(input);
      if (!norm(p) && !hasAttachments) return;

      // Native Send and Enter obey the same queue rule. A busy message with
      // attachments is blocked rather than sent because attachments cannot be
      // reconstructed safely in the queue.
      if (e.isTrusted && interceptBusyHumanSend(input)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      // Attachment-only idle sends stay native; there is no reconstructable
      // text to journal as a transaction prompt.
      if (!norm(p)) return;
      if (e.isTrusted) cancelRecovery('human-send');
      setSendIntent(p, 'human-click', {
        subturn: !!S.txn,
        resumeHib: !!S.hib,
        clearBlocked: !!S.blockedReason,
      });
    }, true);

    document.addEventListener('keydown', e => {
      if (!S.projectActive || !isProjectUrl()) return;
      if (e.isComposing || !isComposerTarget(e.target) || !S.enabled) return;
      if (e.repeat && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.key === 'Escape' && S.queueEditingId) { e.preventDefault(); e.stopImmediatePropagation(); cancelQueueEdit(); return; }
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey) return;
      if (S.queueEditingId) { e.preventDefault(); e.stopImmediatePropagation(); commitQueueEdit(); return; }
      if (S.actionInFlight) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.ctrlKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        const input = getComposer(); const p = promptText(composerText(input)); if (!norm(p)) return;
        cancelRecovery('ctrl-enter');
        const active = !!S.txn || S.generating;
        const hadHib = !!S.hib;
        const hadBlock = !!S.blockedReason;
        dispatchPrompt(p, active ? 'ctrl-enter-steer' : 'ctrl-enter', { newLogicalTask: !active })
          .then(ok => {
            if (!ok) return;
            if (hadHib && S.hib) clearHibernation('human-resume-confirmed', { suppressQueueKick: true });
            if (hadBlock && S.blockedReason) clearBlock('ctrl-enter-confirmed');
          })
          .catch(err => log('ctrl-enter-error', { message: String(err?.message || err) }));
        return;
      }
      if (hasComposerPopup(e.target)) return;
      const isHumanWaitReply = S.hib?.phase === 'wait-user' && !S.txn && !S.generating;
      const isBlockedReply = !!S.blockedReason && !S.generating;
      if (!isHumanWaitReply && !isBlockedReply && interceptBusyHumanSend(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Idle Enter remains native, but only records an ephemeral intent. If a
      // slash/autocomplete UI or React swallows the keystroke, nothing durable is
      // created and the intent simply expires.
      const p = promptText(composerText(e.target));
      if (!norm(p)) return;
      setSendIntent(p, isBlockedReply ? 'blocked-human-reply' : isHumanWaitReply ? 'wait-user-reply' : 'native-enter', {
        subturn: !!S.txn,
        resumeHib: !!S.hib,
        clearBlocked: isBlockedReply,
      });
    }, true);

    document.addEventListener('submit', e => {
      if (!S.projectActive || !isProjectUrl()) return;
      const input = getComposer();
      if (!input || !e.target?.contains?.(input)) return;
      const p = promptText(composerText(input));
      const hasAttachments = hasComposerAttachments(input);
      if (!norm(p) && !hasAttachments) return;

      // Form submit is a third native send path. Guard it with the same rule so
      // keyboard, button, and submit events cannot disagree about generation.
      if (e.isTrusted && !S.actionInFlight && interceptBusyHumanSend(input)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (!norm(p)) return;
      if (!validSendIntent()) {
        setSendIntent(p, (S.generating || S.txn) ? 'native-submit-followup' : 'native-submit', {
          subturn: !!S.txn, resumeHib: !!S.hib, clearBlocked: !!S.blockedReason,
        });
      }
      promoteSendIntent('submit');
    }, true);
  }

  // ---------- UI ----------------------------------------------------------------------
  function ensureQueueTray() {
    const input = getComposer();
    const form = composerForm(input);
    const host = form?.parentElement;
    if (!input || !form || !host) return null;
    let tray = document.getElementById('cgr-queue-tray');
    if (!tray) {
      tray = document.createElement('section');
      tray.id = 'cgr-queue-tray';
      tray.setAttribute('aria-label', 'Queued follow-up messages');
      tray.innerHTML = `<div class="cgr-queue-tray-head"><div class="cgr-queue-tray-title"><span>Queued</span><span id="cgr-queue-tray-count"></span></div></div><div id="cgr-queue-list" class="cgr-queue-list" role="list"></div>`;
    }
    if (tray.parentElement !== host || tray.nextElementSibling !== form) {
      try { host.insertBefore(tray, form); } catch (_) { try { host.prepend(tray); } catch (_) {} }
    }
    DC.queueTray = tray;
    tray.hidden = !queueCount();
    return tray;
  }

  function animateQueueCardOut(row, done) {
    if (!row?.animate) { done(); return; }
    const h = row.getBoundingClientRect?.().height || 44;
    const a = row.animate([{ opacity: 1, transform: 'translateY(0)', maxHeight: `${h}px` }, { opacity: 0, transform: 'translateY(-5px) scale(.985)', maxHeight: '0px' }], { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    a.addEventListener('finish', done, { once: true });
    a.addEventListener('cancel', done, { once: true });
  }

  function renderQueueList() {
    if (!S.projectActive || !isProjectUrl()) { document.getElementById('cgr-queue-tray')?.remove(); DC.queueTray = null; return; }
    const tray = ensureQueueTray();
    if (!tray) return;
    const list = tray.querySelector('#cgr-queue-list');
    const count = tray.querySelector('#cgr-queue-tray-count');
    if (count) count.textContent = queueCount() ? String(queueCount()) : '';
    tray.hidden = !queueCount();
    if (!list || !queueCount()) { if (list) list.textContent = ''; return; }
    const fp = S.queue.map((x, i) => `${i}:${x.id}:${x.hash}:${x.editedAt}`).join('|') + `|edit:${S.queueEditingId}|active:${!!S.txn || S.generating}|hib:${S.hib?.phase || ''}|sysPause:${isPaused()}|block:${S.blockedReason}|error:${S.error?.id || ''}|action:${S.actionInFlight}|online:${navigator.onLine}`;
    if (fp === DC.queueFingerprint && list.childNodes.length) return;
    DC.queueFingerprint = fp;
    list.textContent = '';
    const nextQueueId = firstQueueItem(S.queue)?.id || '';
    S.queue.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `cgr-queue-item ${S.queueEditingId === item.id ? 'is-editing' : ''}`;
      row.dataset.queueId = item.id; row.setAttribute('role', 'listitem'); row.draggable = !S.actionInFlight && S.queueEditingId !== item.id;

      const grip = document.createElement('button');
      grip.type = 'button'; grip.className = 'cgr-queue-grip'; grip.disabled = S.actionInFlight; grip.title = 'Drag to reorder · Arrow keys move'; grip.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';
      grip.addEventListener('keydown', e => { if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); moveQueueItem(item.id, queueIndexById(item.id) + (e.key === 'ArrowUp' ? -1 : 2)); });
      row.appendChild(grip);

      const body = document.createElement('div'); body.className = 'cgr-queue-body';
      const text = document.createElement('div'); text.className = 'cgr-queue-text'; text.textContent = item.text; text.title = item.text; text.addEventListener('dblclick', () => beginQueueEdit(item.id));
      const meta = document.createElement('div'); meta.className = 'cgr-queue-meta'; meta.textContent = S.queueEditingId === item.id ? 'Editing in composer · Enter saves · Esc cancels' : item.id === nextQueueId ? 'Next · waits for [[CGR_DONE]]' : `Follow-up ${index + 1}`;
      body.append(text, meta); row.appendChild(body);

      const actions = document.createElement('div'); actions.className = 'cgr-queue-actions-inline';
      if (S.queueEditingId !== item.id) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'cgr-queue-icon-action'; edit.disabled = S.actionInFlight; edit.title = 'Edit queued message'; edit.innerHTML = '<svg viewBox="0 0 20 20"><path d="M4 13.8V16h2.2l7.1-7.1-2.2-2.2L4 13.8Zm10.9-6.5a.8.8 0 0 0 0-1.1l-1.1-1.1a.8.8 0 0 0-1.1 0l-.9.9L14 8.2l.9-.9Z"/></svg>'; edit.addEventListener('click', () => beginQueueEdit(item.id)); actions.appendChild(edit);
      }
      const del = document.createElement('button'); del.type = 'button'; del.className = 'cgr-queue-icon-action cgr-queue-remove'; del.disabled = S.actionInFlight; del.title = 'Delete queued message'; del.innerHTML = '<svg viewBox="0 0 20 20"><path d="m6.1 6.1 7.8 7.8m0-7.8-7.8 7.8"/></svg>'; del.addEventListener('click', () => animateQueueCardOut(row, () => removeQueueItem(item.id, 'ui-remove'))); actions.appendChild(del); row.appendChild(actions);

      row.addEventListener('dragstart', e => { DC.queueDragId = item.id; row.classList.add('is-dragging'); try { e.dataTransfer.setData('text/plain', item.id); } catch (_) {} });
      row.addEventListener('dragend', () => { DC.queueDragId = ''; row.classList.remove('is-dragging'); });
      row.addEventListener('dragover', e => { if (!DC.queueDragId || DC.queueDragId === item.id) return; e.preventDefault(); });
      row.addEventListener('drop', e => { if (!DC.queueDragId || DC.queueDragId === item.id) return; e.preventDefault(); const r = row.getBoundingClientRect(); moveQueueItem(DC.queueDragId, queueIndexById(item.id) + (e.clientY > r.top + r.height / 2 ? 1 : 0)); DC.queueDragId = ''; });
      list.appendChild(row);
    });
  }

  function ensureQueueButton() {
    if (!S.projectActive || !isProjectUrl()) { document.getElementById('cgr-queue-button')?.remove(); return; }
    const input = getComposer();
    if (!input) return;
    let btn = document.getElementById('cgr-queue-button');
    if (btn?.isConnected) {
      const badge = btn.querySelector('b');
      if (badge) { badge.textContent = queueCount() ? String(queueCount()) : ''; badge.hidden = !queueCount(); }
      btn.disabled = S.actionInFlight || !norm(composerText(input)) || hasComposerAttachments(input);
      return;
    }
    const send = findSafeSendButton(input);
    const form = composerForm(input);
    const parent = send?.parentElement || form;
    if (!parent) return;
    btn = document.createElement('button');
    btn.id = 'cgr-queue-button'; btn.type = 'button'; btn.setAttribute('aria-label', 'Queue follow-up');
    btn.innerHTML = '<svg viewBox="0 0 20 20"><path d="M4 5.5h9M4 10h9M4 14.5h6.5"/><path d="m14 12.5 2 2 2-2"/></svg><span>Queue</span><b></b>';
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (S.queueEditingId) commitQueueEdit(); else queueCurrentComposer(); });
    try { if (send && send.parentElement === parent) parent.insertBefore(btn, send); else parent.appendChild(btn); } catch (_) {}
    const badge = btn.querySelector('b'); if (badge) { badge.textContent = queueCount() ? String(queueCount()) : ''; badge.hidden = !queueCount(); }
    btn.disabled = S.actionInFlight || !norm(composerText(input)) || hasComposerAttachments(input);
  }

  function statusText() {
    if (!S.enabled) return ['Off', 'muted'];
    if (!navigator.onLine) return ['Offline', 'warn'];
    if (S.blockedReason) return [`Waiting · ${S.blockedReason}`, 'error'];
    if (isPaused()) return [`Paused · ${S.pausedReason}`, 'warn'];
    if (S.hib?.phase === 'sleeping') return [`GitHub sleep ${Math.max(1, Math.ceil((S.hib.wakeAt - now()) / 60_000))}m`, 'warn'];
    if (S.hib?.phase === 'waking') return ['Checking GitHub', 'active'];
    if (S.hib?.phase === 'wait-user') return ['Waiting for you', 'warn'];
    if (S.txn?.manualStopped) return ['Stopped by you', 'warn'];
    if (S.txn?.holdReason) return [`Waiting · ${S.txn.holdReason}`, 'warn'];
    if (S.controlFault === 'composer-missing') return ['Waiting for composer', 'warn'];
    if (S.pendingRecoveryReason && (norm(composerText(getComposer())) || hasComposerAttachments(getComposer()))) return ['Recovery pending · draft', 'warn'];
    if (S.recovery?.phase === 'grace') return [`Recovery wait ${Math.max(0, Math.ceil((CFG.recoveryPauseMs - (now() - Number(S.recovery.graceAt || now()))) / 1000))}s`, 'warn'];
    if (S.recovery) return ['Stopping stuck turn', 'warn'];
    if (S.actionInFlight) return ['Recovering', 'active'];
    if (S.error?.id === 'retry-control') return ['Retry detected', 'warn'];
    if (S.error) return [S.error.id, S.error.kind === 'hard' ? 'error' : 'warn'];
    if (S.verify) {
      const verifyRemain = CFG.incompleteVerifyMs - (now() - S.verify.since);
      const quietRemain = CFG.incompleteVerifyMs - (now() - logicalQuietSince());
      return [`Verifying ${Math.max(1, Math.ceil(Math.max(verifyRemain, quietRemain) / 1000))}s`, 'warn'];
    }
    if (S.generating) return [S.longThinkingSeenAt ? 'Long thinking' : 'Generating', 'active'];
    if (S.txn) return [S.txn.userTurnConfirmed ? 'Waiting for finish marker' : 'Confirming send', 'active'];
    if (S.queue.length) {
      const reason = queueReleaseBlockReason();
      return [reason ? `Queue ${S.queue.length} · ${reason === 'waiting-for-cgr-done' ? 'waiting for DONE' : 'held'}` : `Queue ${S.queue.length} · ready`, 'active'];
    }
    if (!assistantIsCurrentTail(getMessages()) || latestMarker(getMessages()) !== 'done') return ['Untracked unfinished turn', 'warn'];
    return ['Healthy', 'ok'];
  }

  function ensureUI() {
    if (!S.projectActive || !isProjectUrl()) { removeRuntimeUi(); return; }
    if (!document.body || document.getElementById('cgr-root')) return;
    const root = document.createElement('div'); root.id = 'cgr-root';
    root.innerHTML = `<button id="cgr-pill" type="button"><span id="cgr-dot"></span><span id="cgr-status">Starting</span></button><div id="cgr-panel" hidden><div class="cgr-head"><strong>${APP}</strong><span>v${VERSION}</span></div><div class="cgr-row"><span>Automation</span><button id="cgr-toggle"></button></div><div class="cgr-note" id="cgr-detail"></div><div class="cgr-actions"><button id="cgr-recover">Continue now</button><button id="cgr-wake">GitHub wake now</button><button id="cgr-clear-queue">Clear pending</button><button id="cgr-clear-state">Clear state</button></div></div>`;
    document.body.appendChild(root);
    root.querySelector('#cgr-pill').addEventListener('click', () => { const p = root.querySelector('#cgr-panel'); p.hidden = !p.hidden; paintUI(true); });
    root.querySelector('#cgr-toggle').addEventListener('click', () => { S.enabled = !S.enabled; store.set('enabled', S.enabled); if (S.enabled) scheduleEvaluate('enabled', 0); paintUI(true); });
    root.querySelector('#cgr-recover').addEventListener('click', async () => { clearPause(); clearBlock('panel-continue'); if (S.txn) { S.txn.manualStopped = false; saveTxn(); } const msgs = getMessages(true); S.generating = isGenerating(); if (!S.generating && S.txn?.userTurnConfirmed) await sendLiteralContinue('manual'); scheduleEvaluate('manual-recover', 100); });
    root.querySelector('#cgr-wake').addEventListener('click', () => attemptGithubWake('manual', true));
    root.querySelector('#cgr-clear-queue').addEventListener('click', clearPendingQueue);
    root.querySelector('#cgr-clear-state').addEventListener('click', () => { clearPause(); clearBlock('manual-clear'); clearTxn('manual-clear'); clearHibernation('manual-clear'); paintUI(true); });
  }

  function paintUI(force = false) {
    if (!S.projectActive || !isProjectUrl()) { removeRuntimeUi(); return; }
    ensureUI(); ensureQueueButton(); renderQueueList();
    const root = document.getElementById('cgr-root'); if (!root) return;
    const [text, state] = statusText();
    const fp = `${text}|${state}|${S.queue.length}|${S.queueHoldReason}|${S.txn?.continueCount || 0}|${S.hib?.phase || ''}|${S.composerControl?.kind || ''}|${S.composerControl?.busyEvidence ? 1 : 0}|${S.recovery?.phase || ''}|${S.controlFault || ''}|${S.pendingRecoveryReason || ''}`;
    if (!force && fp === DC.uiFingerprint) return;
    DC.uiFingerprint = fp;
    root.dataset.state = state;
    root.querySelector('#cgr-status').textContent = text;
    root.querySelector('#cgr-toggle').textContent = S.enabled ? 'On' : 'Off';
    const parts = [];
    if (S.txn) parts.push(`continues ${S.txn.continueCount || 0}/${CFG.maxContinuesPerLogicalTask}`, `reloads ${S.txn.reloadCount || 0}/${CFG.maxReloadsPerLogicalTask}`);
    if (S.queueHoldReason) parts.push(`queue: ${S.queueHoldReason}`);
    if (S.controlFault) parts.push(`fault: ${S.controlFault}`);
    parts.push(`control: ${S.composerControl?.kind || 'unknown'}${S.composerControl?.busyEvidence ? '+busy' : ''}`);
    parts.push('completion: marker required');
    root.querySelector('#cgr-detail').textContent = parts.join(' · ');
  }

  function addStyles() {
    GM_addStyle(`
      #cgr-root{position:fixed;right:14px;bottom:14px;z-index:2147483600;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:CanvasText}
      #cgr-pill{display:flex;align-items:center;gap:7px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:999px;padding:7px 10px;background:color-mix(in srgb,Canvas 92%,transparent);color:CanvasText;box-shadow:0 5px 20px rgba(0,0,0,.16);backdrop-filter:blur(12px);cursor:pointer}
      #cgr-dot{width:8px;height:8px;border-radius:50%;background:#6b7280}#cgr-root[data-state="ok"] #cgr-dot{background:#22c55e}#cgr-root[data-state="active"] #cgr-dot{background:#3b82f6}#cgr-root[data-state="warn"] #cgr-dot{background:#f59e0b}#cgr-root[data-state="error"] #cgr-dot{background:#ef4444}
      #cgr-panel{position:absolute;right:0;bottom:42px;width:285px;padding:12px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 96%,transparent);box-shadow:0 14px 50px rgba(0,0,0,.25);backdrop-filter:blur(16px)}#cgr-panel[hidden]{display:none}.cgr-head,.cgr-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.cgr-head{margin-bottom:10px}.cgr-head span{opacity:.55;font-size:10px}.cgr-row{padding:7px 0;border-top:1px solid color-mix(in srgb,CanvasText 9%,transparent)}.cgr-row button,.cgr-actions button{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:8px;background:color-mix(in srgb,CanvasText 7%,transparent);color:CanvasText;padding:5px 8px;cursor:pointer}.cgr-note{margin-top:8px;padding:8px;border-radius:8px;background:color-mix(in srgb,CanvasText 5%,transparent);opacity:.75;font-size:11px}.cgr-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}
      #cgr-queue-tray{width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px;border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:18px;background:color-mix(in srgb,Canvas 86%,transparent);box-shadow:0 6px 22px rgba(0,0,0,.08);backdrop-filter:blur(18px);animation:cgrTrayIn .16s cubic-bezier(.2,.8,.2,1)}#cgr-queue-tray[hidden]{display:none!important}.cgr-queue-tray-head{height:24px;display:flex;align-items:center;justify-content:space-between;padding:0 5px 3px 8px}.cgr-queue-tray-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;opacity:.72}.cgr-queue-tray-title #cgr-queue-tray-count{display:grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:color-mix(in srgb,CanvasText 9%,transparent);font-size:9px}.cgr-queue-list{display:flex;flex-direction:column;gap:5px;max-height:min(30dvh,280px);overflow-y:auto;scrollbar-width:thin;scrollbar-gutter:stable;padding:1px}.cgr-queue-item{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:48px;padding:7px 8px 7px 5px;border:1px solid color-mix(in srgb,CanvasText 9%,transparent);border-radius:13px;background:color-mix(in srgb,CanvasText 4.5%,Canvas);transition:background .13s ease,border-color .13s ease,transform .13s ease,opacity .13s ease;animation:cgrQueueCardIn .17s cubic-bezier(.2,.8,.2,1)}.cgr-queue-item.is-dragging{opacity:.45}.cgr-queue-grip{width:18px;height:28px;border:0;background:transparent;padding:6px 4px;display:grid;grid-template-columns:repeat(2,3px);gap:3px;align-content:center;justify-content:center;opacity:.28;cursor:grab;color:CanvasText}.cgr-queue-grip span{width:3px;height:3px;border-radius:50%;background:currentColor}.cgr-queue-body{min-width:0}.cgr-queue-text{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cgr-queue-meta{margin-top:2px;font-size:9.5px;opacity:.46}.cgr-queue-actions-inline{display:flex;align-items:center;gap:3px}.cgr-queue-action,.cgr-queue-icon-action{border:0;color:CanvasText;background:transparent;cursor:pointer}.cgr-queue-action{height:28px;padding:0 9px;border-radius:9px;font-size:10.5px;font-weight:600;background:color-mix(in srgb,CanvasText 8%,transparent)}.cgr-queue-icon-action{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;opacity:.48}.cgr-queue-icon-action:hover{opacity:.9;background:color-mix(in srgb,CanvasText 8%,transparent)}.cgr-queue-icon-action svg{width:15px;height:15px;fill:currentColor;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}.cgr-queue-remove svg{fill:none}
      #cgr-queue-button{margin-inline:3px;border:0;border-radius:999px;background:transparent;color:CanvasText;min-height:32px;padding:0 8px;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:560;cursor:pointer;white-space:nowrap;opacity:.62}#cgr-queue-button:hover:not(:disabled){background:color-mix(in srgb,CanvasText 8%,transparent);opacity:.92}#cgr-queue-button:disabled{opacity:.28}#cgr-queue-button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5}#cgr-queue-button b{min-width:16px;height:16px;padding:0 4px;border-radius:999px;display:inline-grid;place-items:center;background:color-mix(in srgb,CanvasText 10%,transparent);font-size:9px}
      @keyframes cgrTrayIn{from{opacity:0;transform:translateY(5px) scale(.995)}to{opacity:1;transform:none}}@keyframes cgrQueueCardIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){#cgr-queue-tray,.cgr-queue-item{animation:none!important}.cgr-queue-item{transition:none!important}}
    `);
  }

  // ---------- scheduling --------------------------------------------------------------
  function scheduleEvaluate(reason = 'event', delay = 0) {
    const due = now() + Math.max(0, delay);
    if (DC.evaluateTimer && DC.evaluateDueAt <= due) return;
    if (DC.evaluateTimer) clearTimeout(DC.evaluateTimer);
    DC.evaluateDueAt = due;
    DC.evaluateTimer = setTimeout(() => {
      DC.evaluateTimer = null; DC.evaluateDueAt = 0;
      evaluate(reason).catch(e => log('evaluate-error', { reason, message: String(e?.message || e) }));
    }, Math.max(0, due - now()));
  }

  function scheduleWatchdog() {
    if (DC.watchdogTimer) clearTimeout(DC.watchdogTimer);
    DC.watchdogTimer = null;
    if (!S.projectActive || !isProjectUrl()) return;
    let delay;
    if (document.hidden) delay = CFG.hiddenWatchdogMs;
    else if (S.blockedReason) delay = CFG.idleWatchdogMs;
    else if (S.hib?.phase === 'sleeping') delay = CFG.idleWatchdogMs;
    else if (isPaused()) delay = Math.min(CFG.idleWatchdogMs, Math.max(1_000, S.pausedUntil - now()));
    else delay = (!!S.txn || S.generating || !!S.verify || !!S.sendIntent || S.hib?.phase === 'waking') ? CFG.activeWatchdogMs : CFG.idleWatchdogMs;
    DC.watchdogTimer = setTimeout(() => scheduleEvaluate('watchdog', 0), delay);
  }

  function ensureObservers() {
    if (!S.projectActive || !isProjectUrl()) return;
    const currentRoot = document.querySelector('main') || document.body;
    if (!DC.rootObserver || !DC.rootNode?.isConnected || DC.rootNode !== currentRoot) installRootObserver();
    installComposerObserver();
    rebindAssistantObserver();
  }

  function installRouteHooks() {
    try {
      if (!UW.__CGR1_HISTORY__) {
        UW.__CGR1_HISTORY__ = true;
        for (const name of ['pushState', 'replaceState']) {
          const orig = UW.history[name];
          UW.history[name] = function (...args) { const r = orig.apply(this, args); queueMicrotask(() => window.dispatchEvent(new Event('cgr1:route'))); return r; };
        }
      }
    } catch (_) {}
    window.addEventListener('popstate', () => scheduleEvaluate('popstate', 0));
    window.addEventListener('cgr1:route', () => scheduleEvaluate('route', 0));
  }

  function installMenu() {
    const inProject = fn => (...args) => {
      if (!verifyTabContext()) return;
      return fn(...args);
    };
    try {
      GM_registerMenuCommand('Toggle ChatGPT Resilience', inProject(() => { S.enabled = !S.enabled; store.set('enabled', S.enabled); paintUI(true); if (S.enabled) scheduleEvaluate('menu-enable', 0); }));
      GM_registerMenuCommand('Continue unfinished task now', inProject(() => { clearPause(); clearBlock('menu'); if (S.txn) { S.txn.manualStopped = false; saveTxn(); sendLiteralContinue('menu'); } }));
      GM_registerMenuCommand('Clear pending queue', inProject(clearPendingQueue));
      GM_registerMenuCommand('GitHub wake now', inProject(() => attemptGithubWake('menu', true)));
      GM_registerMenuCommand('Clear recovery state', inProject(() => { clearPause(); clearBlock('menu-clear'); clearTxn('menu-clear'); clearHibernation('menu-clear'); paintUI(true); }));
    } catch (_) {}
  }

  function selfTest() {
    const cases = [
      ['done marker', terminalMarker('hello\n[[CGR_DONE]]'), 'done'],
      ['hibernate marker', terminalMarker('hello\n[[CGR_HIBERNATE_GITHUB_10M]]'), 'hibernate'],
      ['wait marker', terminalMarker('hello\n[[CGR_WAIT_USER]]'), 'wait-user'],
      ['marker must be final', terminalMarker('[[CGR_DONE]]\nextra'), null],
      ['marker before max-length UI', terminalMarker('work complete\n[[CGR_HIBERNATE_GITHUB_10M]]\nYou’ve reached the maximum length for this conversation, but you can keep talking by starting a new chat.'), 'hibernate'],
      ['flattened hibernate marker', terminalMarker('work complete.[[CGR_HIBERNATE_GITHUB_10M]]'), 'hibernate'],
      ['flattened done marker', terminalMarker('all done.[[CGR_DONE]]'), 'done'],
      ['stream error continues', classifyError('Error in message stream')?.kind, 'continue'],
      ['KeepChatGPT NetworkError continues', classifyError('NetworkError when attempting to fetch resource.')?.kind, 'continue'],
      ['KeepChatGPT something-wrong continues', classifyError('Something went wrong. If this issue persists please contact us through our help center.')?.kind, 'continue'],
      ['conversation not found classified', classifyError('Conversation not found')?.kind, 'reload'],
      ['upstream reset continues', classifyError('upstream connect error or disconnect/reset before headers')?.kind, 'continue'],
      ['timeout continues', classifyError('Message-delivery timeout')?.kind, 'continue'],
      ['HTTP 520 server', classifyHttpStatus(520)?.id, 'server'],
      ['HTTP 422 recoverable request', classifyHttpStatus(422)?.kind, 'continue'],
      ['rate classified', classifyError('Too many requests. Try again in 45 seconds')?.kind, 'rate'],
      ['auth blocks', classifyError('Session expired. Please sign in')?.kind, 'hard'],
      ['maximum length ignored', classifyError('This conversation has reached its maximum length')?.kind || null, null],
      ['wait parser', parseWaitMs('Try again in 45 seconds'), 45000],
      ['classifier can recognize network phrase', classifyError('We should handle network error conditions carefully')?.id || null, 'network'],
      ['normal prose tail guard', ASSISTANT_ERROR_TAIL_RE.test('We should handle network error conditions carefully.'), false],
      ['product error tail guard', ASSISTANT_ERROR_TAIL_RE.test('There was an error generating a response. Try again'), true],
      ['retry label exact', RETRY_CONTROL_RE.test('Retry'), true],
      ['try again label exact', RETRY_CONTROL_RE.test('Try again'), true],
      ['ordinary retry prose is not exact control', RETRY_CONTROL_RE.test('I will retry this operation'), false],
      ['queue head is first future message', firstQueueItem([{id:'a'},{id:'b'}])?.id, 'a'],
      ['empty queue has no head', firstQueueItem([]), null],
      ['draft Send preserves active generation until draft clears', generationDecision({ kind:'send', hasDraft:true, busyEvidence:false }, true), true],
      ['idle draft does not invent generation', generationDecision({ kind:'send', hasDraft:true, busyEvidence:false }, false), false],
      ['empty Send is idle', generationDecision({ kind:'send', hasDraft:false, busyEvidence:false }, true), false],
      ['busy evidence wins over draft Send', generationDecision({ kind:'send', hasDraft:true, busyEvidence:true }, false), true],
      ['voice beats stale busy evidence', generationDecision({ kind:'voice', hasDraft:false,busyEvidence:true }, true), false],
      ['empty Send beats stale busy evidence', generationDecision({ kind:'send',hasDraft:false,busyEvidence:true }, true), false],
      ['post-stop Send is settled even with stale busy attr', postStopControlSettled({ kind:'send', hasDraft:true, busyEvidence:true }), true],
      ['post-stop Voice is settled even with stale busy attr', postStopControlSettled({ kind:'voice', hasDraft:false, busyEvidence:true }), true],
      ['post-stop Stop is not settled', postStopControlSettled({ kind:'stop', hasDraft:false, busyEvidence:false }), false],
      ['post-stop spinner is not settled', postStopControlSettled({ kind:'spinner', hasDraft:false, busyEvidence:false }), false],
      ['hibernate is not queue completion', markerFromProtocolText('x[[CGR_HIBERNATE_GITHUB_10M]]') === 'done', false],
      ['wait-user is not queue completion', markerFromProtocolText('x[[CGR_WAIT_USER]]') === 'done', false],
      ['error text never unlocks queue', markerFromProtocolText('Something went wrong. Retry') === 'done', false],
      ['only DONE marker unlocks queue policy', markerFromProtocolText('x[[CGR_DONE]]') === 'done', true],
      ['normal chat runtime off', isProjectUrl('https://chatgpt.com/c/abc-123'), false],
      ['normal new-chat runtime off', isProjectUrl('https://chatgpt.com/'), false],
      ['project runtime on', isProjectUrl('https://chatgpt.com/g/g-p-project/c/abc-123'), true],
      ['regular chat route parser remains harmless', routeKey('https://chatgpt.com/c/abc-123'), 'c:abc-123'],
      ['project chat route', routeKey('https://chatgpt.com/g/g-p-project/c/abc-123'), 'c:abc-123'],
      ['nested project chat route', routeKey('https://chatgpt.com/g/g-p-project/project/c/abc-123'), 'c:abc-123'],
      ['project key stable', projectKeyFromUrl('https://chatgpt.com/g/g-p-project/c/abc-123'), 'g-p-project'],
      ['voice after work means unfinished', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: true, generationObserved: true, manualStopped: false, confirmedAt: now() - 5000 }, null, { kind: 'voice', hasDraft: false, busyEvidence: false }), 'voice-without-marker'],
      ['voice no-start after grace means unfinished', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: false, generationObserved: false, manualStopped: false, confirmedAt: now() - 5000 }, null, { kind: 'voice', hasDraft: false, busyEvidence: false }), 'voice-no-start'],
      ['send+busy+draft is normal composer UI', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: true, generationObserved: true, manualStopped: false }, null, { kind: 'send', hasDraft: true, busyEvidence: true }), ''],
      ['send+draft without busy evidence is still not a stop signal', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: true, generationObserved: true, manualStopped: false, confirmedAt: now() - 5000 }, null, { kind: 'send', hasDraft: true, busyEvidence: false }), ''],
      ['send after work without draft means unfinished', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: true, generationObserved: true, manualStopped: false, confirmedAt: now() - 5000 }, null, { kind: 'send', hasDraft: false, busyEvidence: false }), 'send-without-marker'],
      ['terminal marker defeats control signal', unfinishedControlSignal({ userTurnConfirmed: true, assistantObserved: true, generationObserved: true, manualStopped: false }, 'done', { kind: 'voice', hasDraft: false, busyEvidence: false }), ''],
    ];
    // The classifier alone intentionally matches generic prose; collectErrorText
    // is the guard that prevents normal assistant prose from reaching it. Keep
    // that behavior explicit in the test output instead of pretending otherwise.
    return cases.map(([name, got, expected], i) => ({ i, name, got, expected, pass: got === expected }));
  }

  function boot() {
    // State is tab-local and survives reloads only in this browser tab.
    if (S.txn && !S.txn.userTurnConfirmed && S.txn.reconciledAt) {
      S.txn.reconciledAt = now();
      saveTxn();
    }

    addStyles();
    installInputHooks();
    installMenu();

    if (S.projectActive && isProjectUrl()) {
      activateProjectRuntime('boot');
      scheduleEvaluate('boot', 250);
    } else {
      deactivateProjectRuntime('boot-outside-project');
    }

    window.addEventListener('online', () => { if (S.projectActive && isProjectUrl()) scheduleEvaluate('online', 250); });
    window.addEventListener('offline', () => { if (S.projectActive && isProjectUrl()) paintUI(true); });
    window.addEventListener('visibilitychange', () => {
      if (S.projectActive && isProjectUrl()) {
        if (!document.hidden) scheduleEvaluate('visible', 100);
        scheduleWatchdog();
      }
    });
    window.addEventListener('focus', () => { if (S.projectActive && isProjectUrl()) scheduleEvaluate('focus', 100); });
    window.addEventListener('beforeunload', flushDraftSave);
  }

  try {
    UW.ChatGPTResilience = Object.freeze({
      version: VERSION,
      protocol: PROTOCOL,
      selfTest,
      continueNow: () => verifyTabContext() ? sendLiteralContinue('console') : false,
      githubWakeNow: () => verifyTabContext() ? attemptGithubWake('console', true) : false,
      githubCancel: () => verifyTabContext() ? clearHibernation('console') : false,
      queueNow: () => verifyTabContext() ? queueCurrentComposer() : false,
      state: () => ({
        projectActive: S.projectActive && isProjectUrl(),
        storage: 'tab-session',
        route: S.route,
        enabled: S.enabled,
        generating: S.generating,
        sendIntent: validSendIntent() ? { source: S.sendIntent.source, ageMs: now() - S.sendIntent.at, subturn: S.sendIntent.subturn } : null,
        error: S.error,
        verify: S.verify ? { ...S.verify } : null,
        recovery: S.recovery ? { ...S.recovery } : null,
        controlFault: S.controlFault,
        pendingRecoveryReason: S.pendingRecoveryReason,
        composerMissingSince: S.composerMissingSince,
        retryVisible: S.error?.id === 'retry-control',
        transport: {
          lastFailureAt: S.lastNetworkFailureAt,
          lastFailureKind: S.lastNetworkFailureKind,
          suppressedUntil: S.suppressTransportErrorsUntil,
          lastHttpStatus: S.lastHttpStatus,
        },
        pausedUntil: S.pausedUntil,
        pausedReason: S.pausedReason,
        blockedReason: S.blockedReason,
        composer: { ...S.composerControl },
        txn: S.txn ? { ...S.txn, rootPrompt: `[${S.txn.rootPrompt?.length || 0} chars]`, currentPrompt: `[${S.txn.currentPrompt?.length || 0} chars]` } : null,
        queue: S.queue.map(x => ({ ...x, text: `[${x.text.length} chars]` })),
        github: S.hib ? { ...S.hib } : null,
        logs: S.logs.slice(-40),
      }),
    });
  } catch (_) {}

  installNetworkObserver();
  installRouteHooks();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else if (document.body) boot();
  else {
    const timer = setInterval(() => { if (document.body) { clearInterval(timer); boot(); } }, 100);
  }
})();