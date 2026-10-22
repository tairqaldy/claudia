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
| Its turn ends but background work is still running | "paused", not "done" | 🔔 |
| It runs far past its usual time | one calm check-in | silent |
| Your usage limits reset and it picks back up | a short heads-up | 🔔 |
| The laptop goes on battery while sessions work, or drops to 20% | a warning | 🔔 |

Quick back-and-forth at the laptop stays quiet: anything that finishes in under 30 seconds doesn't ping. Each "done" message replies to its "on it" message, so every task becomes a small thread. Sessions are called by their title, not their folder.

## When you're away

Send `/away` (or just tell her you're heading out). Until you're back:

- **A finished session waits for you.** Its "done" ping gets a few buttons (Ship it, Test it, More…). Reply to the ping in your own words, or tap a button, and the same session on your laptop keeps going. If you don't answer within 8 minutes, it stops as usual.
- **Questions become buttons.** When a session asks you something, the options arrive as buttons. Plans arrive with Approve and Change it, and permission prompts with Allow and Deny.
- **Screenshots work too.** Reply to a ping with a photo and the session gets it with "take a look at this".
- **The laptop stays awake** while sessions are working.

Typing on the laptop again switches away mode off by itself, and so does `/back`. At the laptop nothing ever waits on your phone: these hooks answer at once, in about a quarter of a second.

## Starting work from your phone

`/new` lists your recent projects. Pick one, then tap a shortcut or type the task. Claudia starts a Claude Code session on the laptop (`claude -p`, using your normal Claude login), and you get the usual pings. That session waits for you when it's done, as if you were away. You can also just tell her: "tell qn5 to commit and push" or "start a review in finow".

This needs the `claude` CLI on the laptop to be logged in. If it isn't, she'll tell you to run `claude` and then `/login` once.

## Shortcuts

Shortcuts are small Markdown files in `recipes/`: Ship it, Test it, Review, Deploy, Polish UI, Optimize, Sync docs, Save summary and Continue. Put your own in `~/.claudia/recipes/` (the same key overrides a built-in one):

```markdown
---
label: Ship it
order: 10
---
Commit the work from this session with a clear message and push it...
```

She also learns. Once a day she looks at the prompts you typed recently, and if you keep asking for the same kind of thing, she offers to turn it into a shortcut.

## Talking to her

Just text her, or send a photo. She knows which sessions are open, what they're working on, how long they've been at it, and what they said last. She keeps a small notebook about you: your projects, your preferences, things you asked her to remember. That way she isn't meeting you for the first time every day. Tell her "no sounds after 1am" and she sets quiet hours: pings still arrive, just silently. Each morning she sends a short digest of what got done.

| Command | |
| --- | --- |
| `/status` | what's running right now |
| `/away`, `/back` | sessions wait for you here, or not |
| `/new` | start a task in one of your projects |
| `/laptop` | battery, CPU, memory, keep awake, screenshot, leftover node processes |
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

- **Hooks**: most run in the background (`SessionStart`, `UserPromptSubmit`, `StopFailure`, `Notification`, `SessionEnd`, `PostToolUse`), so they never slow a session down. Three can carry your answer back, so they wait for Claudia: `Stop`, `PermissionRequest`, and `PreToolUse` for `AskUserQuestion` and `ExitPlanMode`. Claudia answers those at once unless you're away. If she isn't running, the first hook starts her.
- **The daemon** is one small Node process. It listens on localhost and long-polls Telegram, and it's idle almost all the time.
- **Times** come from the hooks, not guesses. "Usually" is the median of your last 20 tasks in that project that ran longer than 30 seconds.
- **Memory** lives in `~/.claudia/memory.json`. It holds up to 40 short notes she manages herself, plus your last 40 messages. Nothing else.

## Privacy and cost

- Everything runs on your machine. The hooks only talk to `127.0.0.1`.
- Two things leave your laptop:
  - The messages Claudia sends, which go to Telegram.
  - When a task runs long, its prompt and final message, which go to Anthropic so she can write the ping. Your chats with her go there too.
  - Screenshots you ask for with `/laptop`, which are sent to your Telegram chat and deleted from the laptop right after.
- For habit learning she keeps your last 300 typed prompts in `~/.claudia/state.json`. Turn it off with `"learnHabits": false`.
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
| `holdMinutes` | `8` | while you're away, how long a finished session waits for your reply (1–9) |
| `remotePermissionMode` | `acceptEdits` | permission mode for sessions you start from your phone |
| `digestTime` | `10:00` | daily digest; `""` turns it off |
| `learnHabits` | `true` | suggest shortcuts for things you keep asking for |
| `autoKeepAwake` | `true` | keep the laptop awake while you're away and sessions work |
| `claudePath` | found automatically | path to the `claude` CLI, if it isn't found |

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
- She can't stop a session mid-task. To fully drive a session from your phone, use Claude's own Remote Control in the Claude app.
- A session resumed from your phone while it's open in the desktop app won't show the new turn there until you reopen it.
- Keep-awake prevents idle sleep, not sleep from closing the lid.
- When the laptop sleeps, so does she.

## License

MIT
