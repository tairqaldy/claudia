# claudia

Claudia texts you on Telegram while your Claude Code sessions work. She lets you know when something long starts, when it's done and how long it took, and when a session is stuck waiting on you. You can text her back any time: "what's running?", "what did qn5 end up doing?", or anything else.

```
on it · qn5: fixing the checkout tests, usually ~15m          (silent)
done ✓ all 42 tests pass, nothing committed yet. took 14m
qn5 needs you: postgres or sqlite?
```

She runs on your laptop, so she's awake whenever your laptop is.

## What you need

- Claude Code: the desktop app, the CLI, or an IDE extension
- Node.js 22 or newer
- A Telegram bot. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
- An Anthropic API key, optional. With one, Claudia writes her own messages and can chat (she uses Claude Haiku 5.5). Without one she still pings you, just with plain templates.

## Install

```bash
git clone https://github.com/tairqaldy/claudia.git
cd claudia
npm install
npm run setup
```

Setup does four things:

1. It asks for your keys.
2. It adds Claudia's hooks to `~/.claude/settings.json`, keeping a backup next to it.
3. It sets her to start when you log in.
4. It gives you a link to tap in Telegram. That link pairs her with your chat, and she ignores everyone else.

## What she sends

| When | What | Sound |
| --- | --- | --- |
| A task has been running for 30s | "on it", with the usual time for that project | silent |
| It finishes | what got done, anything you need to do, how long it took | 🔔 |
| It asks you something, or needs a permission, and you haven't answered in 20s | the question | 🔔 |
| It hits an API error | the error | 🔔 |
| It runs far past its usual time | one calm check-in | silent |

Quick back-and-forth at the laptop stays quiet: anything that finishes in under 30 seconds doesn't ping. Each "done" message replies to its "on it" message, so every task becomes a small thread.

## Talking to her

Just text her. She knows which sessions are open, what they're working on, how long they've been at it, and what they said last. She keeps a small notebook about you: your projects, your preferences, things you asked her to remember. That way she isn't meeting you for the first time every day.

| Command | |
| --- | --- |
| `/status` | what's running right now |
| `/mute 2h` | no sounds for a while (messages still arrive) |
| `/unmute` | sounds back on |
| `/notes` | what she remembers about you |
| `/forget 3` | delete a note |

## How it works

```
Claude Code hooks ──> src/hook.mjs ──> claudia daemon (127.0.0.1:47833) ──> Telegram
                                              │
                                     Claude Haiku 5.5 (her voice + chat)
```

- **Hooks**: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`, plus `PreToolUse` and `PostToolUse` for `AskUserQuestion` and `ExitPlanMode` only. They run async, so they never slow a session down. If Claudia isn't running, the first hook starts her.
- **The daemon** is one small Node process. It listens on localhost and long-polls Telegram, and it's idle almost all the time.
- **Times** come from the hooks, not guesses. "Usually" is the median of your last 20 tasks in that project that ran longer than 30 seconds.
- **Memory** lives in `~/.claudia/memory.json`. It holds up to 40 short notes she manages herself, plus your last 40 messages. Nothing else.

## Privacy and cost

- Everything runs on your machine. The hooks only talk to `127.0.0.1`.
- Two things leave your laptop:
  - The messages Claudia sends, which go to Telegram.
  - When a task runs long, its prompt and final message, which go to Anthropic so she can write the ping. Your chats with her go there too.
- Haiku 5.5 is $0.10 per million input tokens. A ping is about 1–2k tokens, so a busy day costs a few cents.
- Keys live in `~/.claudia/config.json` and never leave your machine except to call Telegram and Anthropic.

## Settings

`~/.claudia/config.json`, then `npm run restart`:

| Key | Default | |
| --- | --- | --- |
| `quietSeconds` | `30` | tasks shorter than this never ping |
| `askDelaySeconds` | `20` | how long to wait before a "needs you" ping |
| `name` | your username | what she calls you |
| `timezone` | your system's | for times in her messages |
| `model` | `claude-haiku-5-5` | |
| `port` | `47833` | |
| `anthropicWorkspace` | | only if your API key isn't tied to a workspace |

## Commands

```bash
npm run status     # running? paired? what she sees
npm run logs       # last 40 log lines
npm start          # start in the background
npm stop
npm run restart
node bin/claudia.mjs test               # send a test ping
node bin/claudia.mjs hooks on|off
node bin/claudia.mjs autostart on|off
npm run uninstall  # removes hooks and autostart; add -- --purge to delete keys and memory too
```

If you move the folder or reinstall Node, run `node bin/claudia.mjs hooks on` and `node bin/claudia.mjs autostart on` again, since both point at absolute paths.

## Limits

- She only sees Claude Code. The regular Claude chat (claude.ai, or the desktop app's Chat tab) has no hooks.
- Pressing Esc to interrupt a session doesn't fire a hook. Instead of saying it's done, she'll report it as quiet ("no activity for 12m").
- She watches, but she can't drive sessions yet.
- When the laptop sleeps, so does she.

## License

MIT
