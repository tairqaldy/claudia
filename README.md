# claudia

Claudia texts you on Telegram while your Claude Code sessions work. Every task gets one card: it shows up quietly while the task works, follows along as it goes, and comes back with a sound when it's done or needs you. You can text her back any time ("what's qn5 doing?"), reply to a card to tell that session what to do next, or have her start new work on the laptop.

```
⏳ qn5 · checkout tests                         (silent, edited as it goes)
working since 14:02 · usually ~15m
▸ running npm test

✅ qn5 · checkout tests · 14m                   (comes back with a sound)
all 42 pass after giving each worker its own stripe mock. nothing's committed yet.
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

Each task has exactly one card in the chat. It always reads the same way: an icon and the task's name first, then one sentence.

| When | The card | Sound |
| --- | --- | --- |
| A task has been running for 30s (right away for work you started from your phone) | ⏳ working since 14:02, usually ~15m, and what it's doing right now, updated as it goes | silent |
| It runs far past its usual time | the same card says "running long" | silent |
| It asks you something, or needs a permission, and you haven't answered in 20s | 🟠 needs you, with the question | 🔔 |
| It finishes | ✅ the outcome and anything you need to do, or 🟠 if it ended on a question, or 🔴 if it got stuck | 🔔 |
| It hits an API error | 🔴 the error in plain words | 🔔 |
| Its turn ends but background work is still running | ⏸ paused, not done | silent |
| The laptop goes on battery while sessions work, or drops to 20% | a warning | 🔔 |

When a task finishes, its working card is replaced by the outcome at the bottom of the chat, so nothing piles up. Tasks that finish within a few seconds of each other arrive as one message ("3 finished · 1 needs you"). Quick back-and-forth at the laptop stays quiet: anything that finishes in under 30 seconds doesn't ping. Sessions are called by their title, not their folder.

A pinned **right now** message always shows what's running, what needs you, and what got done today, with a button that opens the app.

Reply to any card to tell that session what to do next ("commit it", "now add a test for the empty cart"). A question ending in "?" goes to Claudia instead, who can read the session and answer.

## Your terminal

```bash
node bin/claudia.mjs terminal on
```

adds a small hook to your PowerShell profile (and zsh/bash on macOS and Linux). When a command you ran takes longer than a minute, a card arrives with how it went and its last lines of output: quietly if it worked, with a sound if it failed or ran over 3 minutes. Reply to a failed one ("fix it") and a Claude Code session starts in that folder with the command and its output. The hook skips Claude Code's own shells and never slows your prompt. `terminal off` removes it and leaves the rest of your profile as it was.

## When you're away

Send `/away` (or just tell her you're heading out). Until you're back:

- **A finished session waits for you.** Its "done" ping gets a few buttons (Ship it, Test it, More…). Reply to the ping in your own words, or tap a button, and the same session on your laptop keeps going. If you don't answer within 8 minutes, it stops as usual.
- **Questions become buttons.** When a session asks you something, the options arrive as buttons. Plans arrive with Approve and Change it, and permission prompts with Allow and Deny.
- **Screenshots work too.** Reply to a ping with a photo and the session gets it with "take a look at this".
- **The laptop stays awake** while sessions are working.

Typing on the laptop again switches away mode off by itself, and so does `/back`. At the laptop nothing ever waits on your phone: these hooks answer at once, in about a quarter of a second.

## Starting work from your phone

`/new` lists your recent projects. Pick one, then tap a shortcut or type the task. Claudia starts a Claude Code session on the laptop (`claude -p`, using your normal Claude login), and its card shows up right away. Its questions, plans and risky commands come to you as buttons, and it waits for you when it's done, as if you were away.

Or just tell her what you want, the way you'd tell Claude: "install zod in qn5 and use it for the checkout form", "run the tests in finow and fix what fails", "plan a dark mode for the site first". She starts it in the right project. Ask for a plan and the session plans first, then sends the plan to approve or change before it touches anything.

This needs the `claude` CLI on the laptop to be logged in. If it isn't, she'll tell you to run `claude` and then `/login` once.

## The Mini App

Tap **claudia** (the menu button in her chat), or send `/app`. You get four screens:

- **Sessions:** what's working with live timers against the usual time, anything that needs you with answer buttons, and what finished lately.
- **Session:** the conversation so far, shortcut chips and a reply box.
- **Start something:** pick a project, tap a shortcut or describe the task, then run it. Face ID confirms first.
- **Laptop:** battery, CPU, memory, keep-awake, leftover node processes you can stop, and a screenshot sent to your chat.

It follows Telegram's light or dark theme, uses Telegram's back button and haptics, and updates live.

**How it reaches your laptop:** the daemon serves the app on its own local port (`appPort`, 47834 by default), separate from the hook port. A [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) gives it the public https address Telegram requires, and Claudia points her menu button at it on every start.

- Install `cloudflared` once: `winget install Cloudflare.cloudflared`, or `brew install cloudflared` on a Mac.
- Every API call must carry Telegram's signed `initData` from your account; anything else gets a 401.
- To use your own domain or a named tunnel, set `appUrl` in the config. Set `"miniApp": false` to turn it off.

The built app is committed in `app/dist`. To change it, edit `app/src` and run `npm run build:app`. Adding `?mock` to the local URL shows the screens with sample data, no Telegram needed.

The design system lives in the Paper file "Claudia Mini App": tokens, components, patterns, motion and the UX playbook.

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
  - When a task runs long, its prompt and final message, which go to Anthropic so she can write the card's one-line gist. Your chats with her go there too.
  - With the terminal hook on, the last lines of a long command's output, which go to your Telegram chat. The hook keeps a transcript of each terminal in `~/.claudia/terminal` to read those lines from; files older than a day are deleted.
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
| `miniApp` | `true` | serve the Telegram Mini App |
| `appPort` | `47834` | local port for the Mini App (only this port is tunneled) |
| `appUrl` | | your own https address for the app, instead of a quick tunnel |
| `terminalSeconds` | `60` | terminal commands shorter than this never ping (run `terminal on` again after changing it) |

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
node bin/claudia.mjs terminal on|off|status
npm run uninstall  # removes hooks and autostart; add -- --purge to delete keys and memory too
```

If you move the folder or reinstall Node, run `node bin/claudia.mjs hooks on` and `node bin/claudia.mjs autostart on` again, since both point at absolute paths.

## Limits

- She only sees Claude Code. The regular Claude chat (claude.ai, or the desktop app's Chat tab) has no hooks.
- Pressing Esc to interrupt a session doesn't fire a hook. Instead of saying it's done, she'll report it as quiet ("no activity for 12m").
- She can't type into a session mid-task. A reply to a working session's card waits until it stops; to fully drive a running session from your phone, use Claude's own Remote Control in the Claude app.
- The terminal hook covers PowerShell (any app's terminal that loads your profile, like Cursor's or VS Code's) and zsh/bash. Output lines are captured on PowerShell only.
- A session resumed from your phone while it's open in the desktop app won't show the new turn there until you reopen it.
- Keep-awake prevents idle sleep, not sleep from closing the lid.
- When the laptop sleeps, so does she.

## License

MIT
