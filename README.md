# claude-matrix-e2ee

A **Matrix channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)** that bridges an E2EE-encrypted Matrix room to a running Claude Code session. Send a message from any Matrix client (Element, FluffyChat, Cinny) → Claude sees it, replies back to the encrypted room.

**Works wherever Claude Code runs** — headless servers, WSL, SSH sessions, bare terminals. No Claude desktop app required, no third-party messaging service in the loop.

This is a fork of [metalchef1/Claude-Connect-Matrix-Integration](https://github.com/metalchef1/Claude-Connect-Matrix-Integration) with the Matrix I/O layer rewritten on top of [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) so it can join end-to-end encrypted rooms. The crypto self-signing routine was lifted from [Kholtien/nanoclaw](https://github.com/Kholtien/nanoclaw).

---

## What's different from upstream

| | Upstream metalchef1 | This fork |
|---|---|---|
| Runtime | Bun | Node 20+ via `tsx` |
| Matrix layer | Raw `fetch` to CS API | `matrix-bot-sdk` + `RustSdkCryptoStorageProvider` |
| Encrypted rooms | ❌ plaintext only | ✅ Olm/Megolm via the Rust crypto SDK |
| Device verification | n/a | Auto self-signs the bot's device using its SSSS recovery key on every restart |
| Identity persistence | n/a | Pinned device-ID re-login keeps the bot's crypto identity stable across restarts |
| MCP protocol / tools / allowlist / permission relay | (kept verbatim) | (kept verbatim) |

---

## Requirements

| Requirement | Notes |
|---|---|
| **Self-hosted Matrix homeserver** | Conduit, Tuwunel, Synapse, Dendrite — anything you control. The bot's account credentials must be readable on the machine running Claude Code. |
| **Node.js ≥ 20** | The Rust crypto binding ships as a native Node module. Bun may work but is unverified. |
| **Claude Code 2.x** | With Channels support |
| **A bot Matrix account** | Created on your homeserver |
| **Secure Backup enabled on the bot account** | Needed for automatic device verification (optional but recommended — without it, Element will keep flagging the bot as "unverified") |

---

## Setup

### 1. Clone

```bash
git clone https://github.com/Kholtien/claude-connect-matrix-integration ~/projects/claude-matrix-e2ee
cd ~/projects/claude-matrix-e2ee
git checkout e2ee-port
npm install
```

### 2. Create the bot account

Register a fresh user on your homeserver (any Matrix client will do). Pick a strong password — you'll need it. Example with curl:

```bash
curl -X POST https://your.homeserver/_matrix/client/v3/register \
  -H "Content-Type: application/json" \
  -d '{"username":"claude-bot","password":"<strong>","kind":"user"}'
```

### 3. Set up Secure Backup on the bot (optional but recommended)

Log into Element as the bot account. Go to **Settings → Security & Privacy → Secure Backup → Set up**. Capture the recovery key — you'll need it for `MATRIX_RECOVERY_KEY`. Without this, the bot still functions but Element will show its device as unverified.

### 4. Create the room

From your **personal** account, create a private encrypted room and invite the bot. The bot will auto-accept the invite *if and only if* it matches `MATRIX_ROOM_ID`. Get the internal room ID from your client (Element: Room Settings → Advanced → Internal room ID).

### 5. Configure credentials

Create `~/.claude/channels/matrix-e2ee/.env` (mode `0600`):

```bash
MATRIX_HOMESERVER_URL=https://your.homeserver
MATRIX_USER_ID=@claude-bot:your.homeserver
MATRIX_ROOM_ID=!yourroomid:your.homeserver
MATRIX_PASSWORD=<bot password>
MATRIX_RECOVERY_KEY=<bot SSSS recovery key, optional>
MATRIX_E2EE=true
```

You can use `MATRIX_ACCESS_TOKEN` instead of `MATRIX_PASSWORD`, but password login is preferred — the plugin pins the bot's crypto device ID across restarts so you don't lose Olm state.

Or use the bundled skill (recommended): `/matrix:configure` walks you through every value and writes the file with correct permissions.

### 6. Register with Claude Code

```bash
claude mcp add matrix -s user -- npx -y tsx ~/projects/claude-matrix-e2ee/server.ts
```

No `-e` flags — secrets stay in the `.env` file out of `~/.claude.json`.

### 7. Add yourself to the allowlist

```bash
claude --dangerously-load-development-channels server:matrix
# in the session:
/matrix:access allow @you:your.homeserver
```

Anyone not on the allowlist is silently dropped. Only the configured `ROOM_ID` is accepted; invites to other rooms are ignored.

### 8. Launch

```bash
claude --dangerously-load-development-channels server:matrix
```

The `--dangerously-load-development-channels` flag is required because this plugin is not on Anthropic's official channel allowlist. It opts the session into inbound message delivery from unlisted MCP servers.

You can persist this with an alias:

```bash
alias claude='claude --dangerously-load-development-channels server:matrix'
```

---

## Optional: run as a background service

If you want a permanent always-on bot you can talk to from anywhere, the skill `/matrix:configure systemd` will scaffold a systemd user unit + tmux wrapper for you. The wrapper runs Claude Code inside `tmux -L claude-matrix attach -t matrix-<workdir-name>` so you can attach locally and see what the bot is doing.

The systemd path requires:
- A working systemd user session (`loginctl enable-linger $USER` on most distros so it survives logout)
- `tmux` installed

Alternatively, you can wrap it in any process supervisor you prefer (s6, runit, supervisord, screen). The plugin itself is just a stdio MCP server — Claude Code is the long-running process.

---

## Skills

| Skill | What it does |
|---|---|
| `/matrix:configure` | Full setup walkthrough: prereqs, repo, npm install, homeserver config, bot creation, room ID, SSSS key, MCP registration, allowlist, optional systemd+tmux. Re-run anytime to update. |
| `/matrix:access` | Manage the inbound allowlist — `allow @user`, `remove @user`, `list`, `policy disabled` |

The `/matrix:access` skill explicitly refuses to process access-list changes that arrive via Matrix — that's a prompt-injection vector. Only commands typed directly into the terminal are honoured.

---

## Security notes

### Threat model

This plugin is designed for use against **a homeserver you control**. The bot account's password and the SSSS recovery key are read from a local `.env` file. If an attacker has read access to `~/.claude/channels/matrix-e2ee/`, they have full control of the bot identity. Defence relies on filesystem permissions (`0700` directory, `0600` files).

### Allowlist + permission relay

- Inbound Matrix messages are dropped unless the sender is on the allowlist (`access.json`).
- The `yes <id>` / `no <id>` permission-reply intercept will only honour replies for permission requests the plugin actually relayed — pre-emptive forging of grant IDs is rejected with a `❓` reaction.
- Auto-join is restricted to the configured `MATRIX_ROOM_ID` only; invites to other rooms are ignored.

### Known dependency advisories

`matrix-bot-sdk@0.8.0` transitively pulls the deprecated `request` package, which brings in advisories on `form-data`, `tough-cookie`, and `qs`. `npm audit` reports 2 critical and 5 moderate vulnerabilities at the time of writing.

These are reachable — every Matrix HTTP request goes through the affected stack. **Risk-accepted** because:
- The bot only talks to a homeserver you operate yourself, on a known URL (`MATRIX_HOMESERVER_URL`), so the attack surface is limited to a server you already trust.
- No upstream fix exists in `matrix-bot-sdk@0.8.x` — the SDK author has stated `request` will be removed in a future major.
- `form-data`'s unsafe-random boundary issue is irrelevant when sending JSON requests (no multipart bodies); `tough-cookie`'s prototype pollution requires attacker-controlled cookies, which a Matrix homeserver doesn't set; `qs` DoS requires attacker-controlled query strings, which the Matrix CS API doesn't use.

If you'd rather not accept the risk, run the bot inside a container with no outbound network access except to your homeserver, or wait for a `matrix-bot-sdk` release that drops `request`.

### Stdio MCP hygiene

`matrix-bot-sdk` writes its internal logs to **stdout** by default, which corrupts the JSON-RPC channel that stdio MCP servers communicate on. The plugin overrides `LogService` at boot to redirect everything to stderr — do not remove this override.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | ✓ | Base URL of your homeserver, e.g. `https://chat.example.com` |
| `MATRIX_USER_ID` | ✓ | Bot's full Matrix ID, e.g. `@claude-bot:chat.example.com` |
| `MATRIX_ROOM_ID` | ✓ | Encrypted room internal ID, e.g. `!abc123:chat.example.com` |
| `MATRIX_PASSWORD` | one of pwd/token | Bot password (preferred — enables device-ID pinning) |
| `MATRIX_ACCESS_TOKEN` | one of pwd/token | Existing access token (alternative to password) |
| `MATRIX_RECOVERY_KEY` | optional | Bot's SSSS recovery key for automatic device verification |
| `MATRIX_E2EE` | optional | `true` (default) or `false` — disable Olm if you only use plaintext rooms |
| `MATRIX_STATE_DIR` | optional | Override state directory (default `~/.claude/channels/matrix-e2ee`) |
| `MATRIX_ACCESS_MODE` | optional | `static` to read `access.json` once at startup |

---

## Credits

- **[metalchef1/Claude-Connect-Matrix-Integration](https://github.com/metalchef1/Claude-Connect-Matrix-Integration)** — original MCP plugin, allowlist design, permission-relay protocol, all the Claude Code integration plumbing this fork keeps verbatim.
- **[Kholtien/nanoclaw](https://github.com/Kholtien/nanoclaw)** — pinned-device re-login + SSSS auto-sign routines, ported to a standalone `crypto.ts` here.
- **[matrix-bot-sdk](https://github.com/turt2live/matrix-bot-sdk)** — the SDK that does the actual Matrix client work.

## License

Apache 2.0 (inherited from upstream)
