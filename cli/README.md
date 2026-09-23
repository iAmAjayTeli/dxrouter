# DXRouter — local AI router & token saver

**Save 20–40% tokens with RTK + auto-fallback to free and cheap AI models.**

**Connect any AI coding tool (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw…) to 40+ providers and 100+ models.**

[📖 Repository](https://github.com/iAmAjayTeli/dxrouter) • [📝 Changelog](https://github.com/iAmAjayTeli/dxrouter/blob/master/CHANGELOG.md)

---

## 🤔 Why DXRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls…) burn tokens fast
- ❌ Expensive APIs ($20–50/month per provider)

**DXRouter addresses this:**

- ✅ **RTK token saver** — auto-compress `tool_result`, saving 20–40% of tokens
- ✅ **Maximise subscriptions** — track quota and use every bit before reset
- ✅ **Auto fallback** — subscription → cheap → free, with no downtime
- ✅ **Multi-account** — round-robin between accounts per provider
- ✅ **Universal** — works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick start

**Option 1 — from source (recommended).**

DXRouter has no npm release channel. There is deliberately no `npm i -g` instruction here:
the name `dxrouter` on the public npm registry belongs to an unrelated package, so
installing it would not get you this software. Run it from a checkout instead.

```bash
git clone https://github.com/iAmAjayTeli/dxrouter.git
cd dxrouter
npm install
npm run dev            # dashboard on http://localhost:20127
```

To run the CLI launcher from that checkout:

```bash
node cli/cli.js        # or `npm link` inside cli/ to get a `dxrouter` command
```

Because this is a source checkout, the dashboard's update check reports its own release
state and refuses to self-update — update the checkout with `git pull` instead. See
"Updating" below.

**Option 2 — Docker (server/VPS).**

Images are published to GHCR by this repository's own workflow
(`.github/workflows/docker-publish.yml`):

```bash
docker run -d --name dxrouter -p 20127:20127 \
  -v "$HOME/.9router:/app/data" -e DXR_DATA_DIR=/app/data \
  ghcr.io/iamajayteli/dxrouter:latest
```

🎉 Dashboard opens at `http://localhost:20127`

**Connect a free provider (no signup needed):**

Dashboard → Providers → connect **Kiro AI** or **OpenCode Free** → done.

**Use it from your CLI tool:**

```
Claude Code / Codex / OpenClaw / Cursor / Cline settings:
  Endpoint: http://localhost:20127/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

An API key is required even on loopback — a local port is authenticated, not trusted.

---

## 🚀 CLI options

```bash
dxrouter                   # start with default settings (port 20127)
dxrouter --port 8080       # custom port            (-p)
dxrouter --host 127.0.0.1  # bind address           (-H)
dxrouter --no-browser      # don't open a browser   (-n)
dxrouter --tray            # run in the system tray (-t)
dxrouter --skip-update     # skip the update check
dxrouter --help            # show all options       (-h)
```

Binding a non-loopback address additionally requires `DXR_ALLOW_NETWORK=1`; without it the
launcher refuses to start rather than silently exposing the gateway.

**Dashboard**: `http://localhost:20127/dashboard`

---

## 🔄 Updating

DXRouter publishes no release channel yet, so self-update is disabled rather than
unimplemented: `POST /api/version/update` answers `409` and explains why, and the
dashboard reports `canSelfUpdate: false`. The version check asks DXRouter's own GitHub
releases and never the npm registry, so an upstream release can never be offered as an
update to this product.

To update a source checkout:

```bash
git pull
npm install
```

---

## 🛠️ Supported CLI tools

Claude Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool speaking an OpenAI- or Claude-compatible API works.

---

## 💾 Data location

- **macOS/Linux**: `~/.9router/db/data.sqlite`
- **Windows**: `%APPDATA%/9router/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.9router` to persist)
- Override with `DXR_DATA_DIR`, which is honoured everywhere.

The directory name is still `9router`, and that is deliberate: renaming it would orphan
every existing install's credentials and usage history. Where an install keeps its data and
what product it is are separate questions — see `src/lib/dataDir.js`.

---

## 📚 Documentation

- **Repository**: https://github.com/iAmAjayTeli/dxrouter
- **Architecture**: `FINAL-ARCHITECTURE.md`
- **Docker**: `DOCKER.md`

---

## 🙏 Acknowledgments

- **[9Router](https://github.com/decolua/9router)** — the upstream project DXRouter is
  forked from. DXRouter is a separate product with its own identity, release source and
  loopback port (20127, where upstream uses 20128); the two can be installed side by side.
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — original Go implementation

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
