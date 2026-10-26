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

## Automated study pipeline (v1.3.36+)

The existing durable queue and recovery state machine now recognize these additional **final-line** markers:

- `[[STUDY_STEP_DONE:S01]]` through `S06`: save verified stage, download and queue next stage.
- `[[STUDY_STEP_MORE:S01]]` through `S07`: same stage continues in another turn (e.g., one topic at a time).
- `[[STUDY_FINAL_READY]]`: complete, do not queue another stage.
- `[[STUDY_WAIT_FOR_HUMAN]]`: pause for human action, no queued progression.

These markers are **alternatives**, not additions, to `[[CGR_DONE]]`. Don't emit both. Each marker must be the final standalone line, outside code fences.

Stage prompts load at completion time from [studyshit/prompts](https://github.com/creativeidiot123/studyshit/tree/main/prompts) using Tampermonkey's `GM_xmlhttpRequest` permission. The current code path explicitly preserves the existing queue's transactional send and no-duplicate rules; it does **not** send prompts through a second parallel sender.

**Bootstrap:** Upload a lecture PPT in a new ChatGPT Study Project conversation. The Study Project's instructions (stored in [studyshit/PROJECT-INSTRUCTIONS.txt](https://github.com/creativeidiot123/studyshit/blob/main/PROJECT-INSTRUCTIONS.txt)) load/execute Stage 01. Once Stage 01 commits and emits its marker, the userscript takes over the next stages.

**Recovery:** Tampermonkey menu → **Retry study next stage** if the remote prompt fails to download. The browser session/tab must remain open; this is client-side automation, not a hosted unattended worker. Attachments are not re-uploaded by the userscript. Saving HTML to GitHub still depends on the ChatGPT model's connected GitHub access and verified writes.
