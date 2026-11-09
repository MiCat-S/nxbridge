# nxbridge

[简体中文](README.md) | **English**

Lets **Claude Code** and **Codex CLI** on the same computer message each other and work together as equal peers.

## Introduction

### What it solves

Claude Code and Codex each have their strengths, but they can't talk to each other out of the box. If you want one to write code and the other to review it, you have to copy and paste between two windows yourself.

nxbridge adds a local message channel between them. Once it's installed, you can tell either side something like "ask Codex to review this change" or "hand the tests to Claude". It sends the task to the other side, and the result comes back when the work is done.

### How it works

- **Both sides stay the official CLIs.** Each keeps its own login, model, context and permission settings. nxbridge only relays messages. It never calls a model itself and never turns one side into the other's subagent.
- **It plugs in through the official plugin systems.** Setup installs the nxbridge plugin with each CLI's own plugin commands:
  - On the Claude side, Claude uses its native `SendMessage` to send to `nxbridge:codex`. The plugin also shows pairing status and notices in the status bar.
  - On the Codex side, Codex gets a set of `claude.*` tools (such as `claude.send_message` and `claude.status`) and receives messages through hooks.
- **A local coordinator.** A small background process handles pairing, delivery and health checks. All of its data lives in `~/.nxbridge`, and the message log is a local SQLite database kept for 7 days by default. All traffic stays on your machine. Nothing is uploaded.
- **Pairs.** One Claude window and one Codex session form a pair. You can have several pairs on one computer, and they don't affect each other.

### Key features

- **Finds a partner for you.** If a window of the other CLI is open in the same project directory, you're asked whether to pair with it. If there isn't one, nxbridge starts a partner in the background.
- **Background partners recover on their own.** If a Claude or Codex session that nxbridge started in the background exits, nxbridge relaunches the same session instead of starting a new one.
- **Reliable delivery.** A message whose delivery is uncertain is never resent automatically. When a message can't be delivered, you're told why and what to do next.
- **Movable sessions.** A Codex session can move between your own window and the background without losing its context or its partner.
- **Stays within its authority.** It never approves actions for you. It doesn't change your model, approval or sandbox settings, install system services, or edit shell profiles.

### Language

- nxbridge's status bar notices, command output and full manual ([`publish/README.md`](publish/README.md)) are currently available only in Simplified Chinese.
- Messages between the two AIs can be in any language, and you can talk to them in whatever language you like.

## Deployment

### 1. Prepare your environment

| Requirement | Notes |
|---|---|
| Node.js 24–26 | Needs the built-in `node:sqlite`. Run `node -v` to check your version. |
| Claude Code | Logged in. Tested with 2.1.308, 2.1.316 and 2.1.317. |
| Codex CLI | Logged in. Tested with 0.164.0 and 0.166.0. |

- If either CLI is older than the tested versions, the setup check warns you, but it may still work. Upgrade first if you can.
- In each project directory you plan to use, open `claude` and `codex` once and accept each one's directory trust prompt. In a directory that hasn't been trusted, background sessions stop and wait for you.
- Platforms:
  - **macOS:** In daily use on a real Mac running macOS 27 (Apple silicon). See [Using it on macOS](#using-it-on-macos) for what to watch out for. The author's official verification isn't finished yet.
  - **Windows and WSL (Ubuntu 22.04):** Verified by the author.
  - **Other Linux distributions:** Should work, but haven't been tested separately.

### 2. Download

Pick one:

- **Release package (recommended):** Download the latest zip from [Releases](../../releases), unzip it, and go into the extracted `nxbridge-0.1.1` folder.
- **Clone the repository:**

  ```sh
  git clone https://github.com/MiCat-S/nxbridge.git
  cd nxbridge/publish
  ```

### 3. Install

Run these in the folder from the previous step:

```sh
node nxbridge.mjs setup --dry-run   # preview: runs every check but writes nothing
node nxbridge.mjs setup             # install
```

Setup does the following:

- Copies the runtime files to `~/.nxbridge`. After that, you can delete the folder you downloaded or cloned.
- Installs the nxbridge plugin with each CLI's official plugin commands.
- Puts an `nxbridge` command in a directory on your PATH that you can write to, preferring `~/.local/bin` or `~/bin`. If no such directory exists, it prints a full command you can run directly. Use that command wherever this README says `nxbridge`.

If any check fails, setup writes nothing and tells you why. If setup is interrupted, run the same command again to finish.

### 4. Activate the plugins

1. **Claude Code:** Run `/reload-plugins` in any window that's already open, or open a new window.
2. **Codex:** Start a new session and trust the nxbridge hooks in `/hooks`. nxbridge won't do this for you.

### 5. Match the permission modes on both sides

Claude Code holds messages from a session in a different permission class and asks you to review each one. A held message is discarded if you don't act on it within 5 minutes (the default). There are two classes:

- **Full access:** Claude's bypass mode (plan mode counts as this class too), and Codex with `approval_policy = "never"` plus `sandbox_mode = "danger-full-access"`.
- **Ask first:** Claude's default, auto and accept-edits modes, and Codex's default (auto) settings.

**Both sides only need to be in the same class. Using bypass on both sides is recommended.** Set it in the configuration files, so the Claude and Codex sessions nxbridge starts in the background use the same mode:

- **Claude:** In `~/.claude/settings.json`:

  ```json
  { "permissions": { "defaultMode": "bypassPermissions" } }
  ```

  For a one-off session, you can instead start Claude with `claude --dangerously-skip-permissions`.
- **Codex:** In `~/.codex/config.toml`:

  ```toml
  approval_policy = "never"
  sandbox_mode = "danger-full-access"
  ```

If the classes don't match, the Claude status bar tells you what to change. If you'd rather not match them, you can release each held message by hand in Claude's review dialog.

Note: changes to Codex's approval and sandbox settings only apply to new sessions.

### 6. Check the installation

```sh
nxbridge doctor   # check the installation and runtime health
nxbridge status   # show pairs and the state of both sides
```

> **Windows:** If you're told initialization is needed, run `nxbridge bootstrap` once, then send the message again.

## Usage

There are no special commands to learn. Just tell either side, in plain language, that you want it to work with the other. The AI calls nxbridge to send the message itself.

### Option 1: Open both windows yourself

1. Open Claude Code and Codex in the same project directory.
2. Tell one side what you want. For example, in Claude:
   - "Ask Codex to review my last commit"
   - "You fix this bug, then hand it to Codex to double-check"
   - "Ask Codex what it thinks of this plan"
3. The first time a message is sent, Claude shows a picker: **pair with an existing window / start a background partner / don't pair for now**. Choose the open Codex window, and the original message is sent automatically.
4. From then on, the two sides talk to each other. When Codex replies, Claude carries on and tells you the result.

### Option 2: Open one side and let nxbridge start the partner

If no window of the other CLI is open in the same directory, nxbridge starts a partner in the background, so you don't need a second window.

- **To see what the background session is doing, or to take it over:**

  ```sh
  nxbridge open codex               # open the background Codex session
  nxbridge open claude              # open the background Claude (when it's idle or waiting for you)
  nxbridge open claude --interrupt  # interrupt Claude first if it's busy, then take over
  ```

  Taking over is only temporary. When you close the window, the session goes back to the background.
- **When the background session is waiting for your approval:** If background Codex reaches an action that needs approval, such as running a command, writing outside the workspace or accessing the network, it stops and waits. The Claude status bar says "Codex 在等你批准操作" (Codex is waiting for you to approve an action). Run `nxbridge open codex` in a terminal in the project directory to see the pending request and answer yes or no. The task isn't interrupted. nxbridge never approves anything for you.
- **Automatic recovery:** If a background session crashes or is closed, nxbridge relaunches the same session within a few seconds, retrying up to 3 times. A recovered session doesn't start working on its own and never resends messages whose delivery was uncertain.

### When messages get delivered

| Recipient | Woken up when idle? |
|---|---|
| A session nxbridge started in the background | Yes, whenever a message arrives |
| A Codex window you opened yourself (Linux / WSL) | Yes, if it was opened with `codex --no-daemon` or you picked it yourself in the pairing picker |
| A Codex window you opened yourself (macOS / Windows) | No. The message arrives after you type something in that window |

If the recipient can't be woken, the message is saved, and Claude and the status bar tell you how many messages haven't reached which Codex window yet. For fully automatic back-and-forth, use Option 2 so nxbridge starts Codex in the background, or use `adopt` (below) to hand your session over to the background.

### Moving a Codex session between your window and the background

A Codex session with a lot of context can move between your own window (including the ChatGPT app) and the background. It keeps the same session and the same partner:

```sh
nxbridge adopt codex     # hand over to the background; if the window is still open, it waits until you close it
nxbridge release codex   # hand back to your own window for good; it waits for the current background turn to finish
```

If you close your own Codex window, the pair stays. The next time Claude sends a message, you choose: continue the session in the background / wait for me to reopen the window / start a new background Codex / unpair.

### Changing partners, pausing and turning off

- **Change partners or unpair:** In Claude, type `/nxbridge pair` (or just say "switch partners"). In Codex, type `nxbridge pair`.
- **Pause or resume messaging:** `nxbridge pause` / `nxbridge resume`.
- **Make nxbridge leave one side completely alone:** Tell the AI "turn off Codex" or "turn off Claude". Only you can turn it back on: type `/nxbridge on codex` in Claude, or run `nxbridge on codex` in a terminal.
- **Watch the conversation live:** `nxbridge watch`.

### Multiple pairs

You can have several pairs on one computer. Each window talks only to its own partner:

- Running `/clear` in Claude or switching conversations in Codex keeps the same partner.
- If you close a window and later open the same conversation with `--resume`, the original partner is reconnected.
- When you run `pause`, `unpair`, `restart`, `open`, `adopt`, `release` and similar commands from an outside terminal, use `--pair`, `--member` or `--session` to choose the target. You can find the IDs with `nxbridge status`.

### Using it on macOS

nxbridge is in daily use on this setup:

- macOS 27.0 (Apple silicon), Node.js 26.7, Claude Code 2.1.308, Codex 0.166.0 (installed with Homebrew)
- Features in use: installing and updating many times, messaging in both directions, background Codex and Claude partners, several pairs running at once, and handing sessions to the background with `adopt`

Things to watch out for on macOS:

- **Codex windows you open yourself aren't woken up.** Since Codex 0.166, sessions run in a shared background service by default, so a message to your own window arrives only after you type something in that window. For fully automatic back-and-forth, let nxbridge start Codex in the background, or hand your session over with `nxbridge adopt codex`.
- **Background Codex still runs in Codex's shared background service.** On Linux and Windows, nxbridge runs background Codex on its own. On macOS this hasn't changed yet. nxbridge never stops or restarts that service.
- **Before nxbridge can start Claude in the background, trust the project directory from the command line.** Run `claude` once in that directory and accept the trust prompt. Trusting it only in the Claude desktop app isn't enough.
- **The ChatGPT app may hold a Codex session.** If `nxbridge adopt codex` says the session is in use, close that session in the ChatGPT app first. If it still says so, quit the ChatGPT app (⌘Q).
- **If something goes wrong:** Send the full output of `nxbridge doctor` to the author. To help the author collect macOS verification evidence, see [`publish/tools/macos-validation.md`](publish/tools/macos-validation.md) (in Chinese).

## Common commands

| Command | What it does |
|---|---|
| `nxbridge status` | Show all pairs and the state of both sides |
| `nxbridge doctor` | Check the installation and runtime health |
| `nxbridge pair` | List windows without a partner and pair one by number |
| `nxbridge watch` | Watch messages between the two sides live |
| `nxbridge pause` / `resume` | Pause / resume messaging |
| `nxbridge open claude\|codex` | Take over a session nxbridge started in the background |
| `nxbridge adopt codex` | Hand a Codex session over to the background |
| `nxbridge release codex` | Hand a background Codex session back to your own window |
| `nxbridge on` / `off` | Turn one side on / off |
| `nxbridge config list` | Show the configuration |

## Updating

Download and unzip the new version, then run this in its folder:

```sh
node nxbridge.mjs update --from .
```

When the update finishes, it lists what you need to do. Usually that's running `/reload-plugins` in the Claude windows you have open. If the Codex plugin changed, you also need to trust the hooks again in `/hooks`. Sessions that are working during the update aren't interrupted.

## Uninstalling

```sh
nxbridge uninstall --dry-run   # preview what will happen
nxbridge uninstall             # uninstall, keeping settings and the message log
nxbridge uninstall --purge     # also delete ~/.nxbridge
```

Neither CLI's own session history is ever deleted.

## Configuration

- The configuration file is `~/.nxbridge/config.toml`. Create it if you need it. nxbridge never modifies it.
- You can also use `nxbridge config list` and `nxbridge config set <key> <value>`.
- If you normally start Claude or Codex through a wrapper, set the command used for background launches with `nxbridge setup --claude-command <command> --claude-command-arg <argument>`.

Notification rules, Codex's shared background service, troubleshooting and more are covered in the full manual, [`publish/README.md`](publish/README.md) (Simplified Chinese).

## Repository layout

- `publish/`: the release package, unmodified. Its contents are identical to the zip in Releases.
  - Don't edit, add or remove any files in it. The installer checks every file against `publish.json` and refuses to install if anything differs.
  - `.gitattributes` turns off line-ending conversion for this directory, so a clone on Windows doesn't change the files either.
- `README.md` / `README.en.md`: this guide in Chinese and English.

## License

MIT. See [`publish/LICENSE`](publish/LICENSE). Licenses for the bundled third-party dependencies are in [`publish/THIRD-PARTY-NOTICES.md`](publish/THIRD-PARTY-NOTICES.md).
