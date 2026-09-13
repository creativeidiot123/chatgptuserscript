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

### Important: this repository is currently private

Tampermonkey cannot reliably fetch the unauthenticated `raw.githubusercontent.com` URL of a private repository. For true remote auto-updates, either:

1. make this repository public, or
2. publish only `chatgpt-resilience.user.js` to a small public distribution repo/gist.

If you keep this repo private, use a local clone/local-file development workflow instead.

## Project prompt

See `PROJECT-INSTRUCTIONS.txt`. The project uses these terminal markers:

- `[[CGR_DONE]]`
- `[[CGR_HIBERNATE_GITHUB_5M]]`
- `[[CGR_WAIT_USER]]`

No terminal marker means the logical task is not proven complete.


## Project-only scope

The userscript only runs on ChatGPT project routes matching:

```text
https://chatgpt.com/g/*
```

It does not run on ordinary chats such as `https://chatgpt.com/c/*`.
