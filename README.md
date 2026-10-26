# ChatGPT Resilience

Protocol-first userscript for ChatGPT with durable queueing, dead-turn recovery, long-thinking recovery, and GitHub Actions hibernation.

## Install

Stable userscript path:

`chatgpt-resilience.user.js`

The script is configured with:

```text
@updateURL   https://raw.githubusercontent.com/creativeidiot123/chatgptuserscript/main/chatgpt-resilience.user.js
@downloadURL https://raw.githubusercontent.com/creativeidiot123/chatgptuserscript/main/chatgpt-resilience.user.js
```

Tampermonkey requires a `@version` value for update checks, so **bump the version every time you want an installed copy to update**.

### Public distribution

This repository is currently public, so the raw GitHub update URL is reachable without GitHub authentication. Updates require a userscript `@version` increment.

## Project prompt

See `PROJECT-INSTRUCTIONS.txt`. The project uses these terminal markers:

- `[[CGR_DONE]]`
- `[[CGR_HIBERNATE_GITHUB_10M]]`
- `[[CGR_WAIT_USER]]`

No terminal marker means the logical task is not proven complete.


## Project-only scope

The userscript only runs on ChatGPT project routes matching:

```text
https://chatgpt.com/g/*
```

It does not run on ordinary chats such as `https://chatgpt.com/c/*`.

## Automated study pipeline (v1.3.37+)

The existing durable queue and recovery state machine now recognize these additional **final-line** markers:

- `[[STUDY_STEP_DONE:S01]]` through `S06`: stage claims completion, queue a single independent verification turn for that stage, NOT the next stage.
- `[[STUDY_STEP_MORE:S01]]` through `S07`: same stage continues in another turn (e.g., one topic at a time).
- `[[STUDY_VERIFY_PASS:S01]]` through `S06`: matching, owned verification succeeded; only now queue the next stage.
- `[[STUDY_VERIFY_FAIL:S01]]` through `S07`: verification failed; queue the SAME stage in repair mode with the verifier's findings. Limit to three failures per stage.
- `[[STUDY_FINAL_READY]]`: Stage S07 release claim; queue independent S07 verification before final acceptance.
- `[[STUDY_VERIFY_PASS:S07]]`: verified final completion, stop pipeline.
- `[[STUDY_WAIT_FOR_HUMAN]]`: pause for human action, no queued progression.

These markers are **alternatives**, not additions, to `[[CGR_DONE]]`. Don't emit both. Each marker must be the final standalone line, outside code fences.

Stage and verification prompts (including `08-verify-stage.txt`) load at completion time from [studyshit/prompts](https://github.com/creativeidiot123/studyshit/tree/main/prompts) using Tampermonkey's `GM_xmlhttpRequest` permission. The current code path explicitly preserves the existing queue's transactional send and no-duplicate rules; it does **not** send prompts through a second parallel sender.

**Bootstrap:** Upload a lecture PPT in a new ChatGPT Study Project conversation. The Study Project's instructions (stored in [studyshit/PROJECT-INSTRUCTIONS.txt](https://github.com/creativeidiot123/studyshit/blob/main/PROJECT-INSTRUCTIONS.txt)) load/execute Stage 01. Once Stage 01 commits and emits its marker, the userscript takes over the next stages.

**Recovery:** Tampermonkey menu → **Retry study next stage** if the remote stage/verification prompt fails to download. The guard fails closed if a pending verifier is removed from the queue; it will not silently send unrelated queued work instead. The browser session/tab must remain open; this is client-side automation, not a hosted unattended worker. Attachments are not re-uploaded by the userscript. Saving HTML to GitHub still depends on the ChatGPT model's connected GitHub access and verified writes.

## New tab / browser handoff (v1.3.41+)

Moving the study chat to a new tab or another browser no longer strands the pipeline at **Study handoff pending**:

- A `[[STUDY_VERIFY_PASS:Sxx]]` / `[[STUDY_VERIFY_FAIL:Sxx]]` verdict is accepted without tab-local gate state when the rendered conversation proves it answers a `[STUDYSHIT AUTO VERIFY Sxx]` prompt for the same stage (literal `continue` recovery turns in between are allowed; any other human turn is not). A same-stage manual-review stop is never overridden.
- A send is confirmed from the rendered user bubble even when ChatGPT renders the prompt as Markdown or keeps only recent turns mounted. This stops the reload → resend loop that posted the same prompt twice.
- An auto prompt that ChatGPT restores into the composer after the conversation has moved past it is cleared instead of being sent again, and stale queued auto prompts are dropped before dispatch.

Run only **one** tab with the userscript on a given study chat.

## Recovery diagnostics (v1.3.40+)

The common **Something went wrong** product error is recognized alongside **Something seems to have gone wrong**, including the standard help-center suffix when the error card is appended to a long response. These use the existing guarded Stop → settle → wait → continue path.

Verification ownership survives Stop → wait → `continue`. An owned verification result is recorded before its transaction is cleared, so retrying a failed next-prompt download after a reload does not strand the pipeline. PASS and FAIL still require a matching pending gate; unrelated or quoted markers never authorize advancement. The status pill reports **Study handoff pending** rather than Healthy while progression is unresolved.

State is session-local. Moving a chat to another tab or browser does not transfer verification ownership, the queue or the active transaction. In that situation, re-check the last completed stage in the existing conversation and produce a fresh completion claim to establish a new verification gate; do not treat an orphan PASS token as permission to advance.

For a stopped run, open the active ChatGPT tab's **Web Console** (Firefox: Ctrl+Shift+K; Chromium: Ctrl+Shift+J), not Firefox's browser-wide Browser Console. Run:

```js
JSON.stringify({version: window.ChatGPTResilience?.version, state: window.ChatGPTResilience?.state()}, null, 2)
```

The snapshot includes recent runtime events and the study gate/handoff. Inspect it for private content before sharing; error snippets or route identifiers may be present. If the API is unavailable, report that exact result and the version shown by clicking the status pill. General favicon/browser-console warnings alone do not identify a userscript failure.

Run the recovery regression suite with Node.js:

```text
node --test tests/study-recovery.test.cjs
node --check chatgpt-resilience.user.js
```

These tests exercise the actual study transition functions with a mocked browser boundary. They cover recovered PASS/FAIL/final verification, duplicate handling, failed prompt download and reload, unrelated turns, and the three-failure stop. They do not replace live browser validation of DOM detection and native Stop/Send.
