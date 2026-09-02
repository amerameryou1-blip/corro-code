<p align="center">
  <a href="https://corrocode.dev">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Corro Code logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://corrocode.dev/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/corro-ai"><img alt="npm" src="https://img.shields.io/npm/v/corro-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/corro/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/corro/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![Corro Code Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://corrocode.dev)

---

### Installation

```bash
# YOLO
curl -fsSL https://corrocode.dev/install | bash

# Package managers
npm i -g corro-ai@latest        # or bun/pnpm/yarn
scoop install corro             # Windows
choco install corro             # Windows
brew install anomalyco/tap/corro # macOS and Linux (recommended, always up to date)
brew install corro              # macOS and Linux (official brew formula, updated less)
sudo pacman -S corro            # Arch Linux (Stable)
paru -S corro-bin               # Arch Linux (Latest from AUR)
mise use -g corro               # Any OS
nix run nixpkgs#corro           # or github:anomalyco/corro for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

Corro Code is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/corro/releases) or [corro.ai/download](https://corrocode.dev/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `corro-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `corro-desktop-mac-x64.dmg`     |
| Windows               | `corro-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask corro-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/corro-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.corro/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://corrocode.dev/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://corrocode.dev/install | bash
```

### Agents

Corro Code includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://corrocode.dev/docs/agents).

### Documentation

For more info on how to configure Corro Code, [**head over to our docs**](https://corrocode.dev/docs).

### Contributing

If you're interested in contributing to Corro Code, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on Corro Code

If you are working on a project that's related to Corro Code and is using "corro" as part of its name, for example "corro-dashboard" or "corro-mobile", please add a note to your README to clarify that it is not built by the Corro Code team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/corro) | [X.com](https://x.com/corro)

---

# Corro Code quickstart

Corro Code is this product's identity: renamed UI, copper theme, `corro` CLI
command, and a hosted backend (sign-ups, 6-hour trial windows, NVIDIA key
pool, telemetry, ad ledger).

1. `cp corro.json.example corro.json` in your project (config aliases
   `corro.json` / `corro.jsonc`; legacy names still load).
2. Sign in and export your session:
   `export CORRO_JWT=$(node script/corro-login.mjs you@mail.com password)`
   (append `--save` to store it in `~/.config/corro/auth.json`).
3. Run `corro` (installed bin) or `bun run dev`, pick a "Corro pool" model.
   Free-tier routing enforces your trial window server-side; set your own
   NVIDIA key in the provider options to bypass it.
