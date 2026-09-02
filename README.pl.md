<p align="center">
  <a href="https://corrocode.dev">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Corro Code logo">
    </picture>
  </a>
</p>
<p align="center">Otwartoźródłowy agent kodujący AI.</p>
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

### Instalacja

```bash
# YOLO
curl -fsSL https://corrocode.dev/install | bash

# Menedżery pakietów
npm i -g corro-ai@latest        # albo bun/pnpm/yarn
scoop install corro             # Windows
choco install corro             # Windows
brew install anomalyco/tap/corro # macOS i Linux (polecane, zawsze aktualne)
brew install corro              # macOS i Linux (oficjalna formuła brew, rzadziej aktualizowana)
sudo pacman -S corro            # Arch Linux (Stable)
paru -S corro-bin               # Arch Linux (Latest from AUR)
mise use -g corro               # dowolny system
nix run nixpkgs#corro           # lub github:anomalyco/corro dla najnowszej gałęzi dev
```

> [!TIP]
> Przed instalacją usuń wersje starsze niż 0.1.x.

### Aplikacja desktopowa (BETA)

Corro Code jest także dostępny jako aplikacja desktopowa. Pobierz ją bezpośrednio ze strony [releases](https://github.com/anomalyco/corro/releases) lub z [corro.ai/download](https://corrocode.dev/download).

| Platforma             | Pobieranie                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `corro-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `corro-desktop-mac-x64.dmg`     |
| Windows               | `corro-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` lub AppImage        |

```bash
# macOS (Homebrew)
brew install --cask corro-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/corro-desktop
```

#### Katalog instalacji

Skrypt instalacyjny stosuje następujący priorytet wyboru ścieżki instalacji:

1. `$OPENCODE_INSTALL_DIR` - Własny katalog instalacji
2. `$XDG_BIN_DIR` - Ścieżka zgodna ze specyfikacją XDG Base Directory
3. `$HOME/bin` - Standardowy katalog binarny użytkownika (jeśli istnieje lub można go utworzyć)
4. `$HOME/.corro/bin` - Domyślny fallback

```bash
# Przykłady
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://corrocode.dev/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://corrocode.dev/install | bash
```

### Agents

Corro Code zawiera dwóch wbudowanych agentów, między którymi możesz przełączać się klawiszem `Tab`.

- **build** - Domyślny agent z pełnym dostępem do pracy developerskiej
- **plan** - Agent tylko do odczytu do analizy i eksploracji kodu
  - Domyślnie odmawia edycji plików
  - Pyta o zgodę przed uruchomieniem komend bash
  - Idealny do poznawania nieznanych baz kodu lub planowania zmian

Dodatkowo jest subagent **general** do złożonych wyszukiwań i wieloetapowych zadań.
Jest używany wewnętrznie i można go wywołać w wiadomościach przez `@general`.

Dowiedz się więcej o [agents](https://corrocode.dev/docs/agents).

### Dokumentacja

Więcej informacji o konfiguracji Corro Code znajdziesz w [**dokumentacji**](https://corrocode.dev/docs).

### Współtworzenie

Jeśli chcesz współtworzyć Corro Code, przeczytaj [contributing docs](./CONTRIBUTING.md) przed wysłaniem pull requesta.

### Budowanie na Corro Code

Jeśli pracujesz nad projektem związanym z Corro Code i używasz "corro" jako części nazwy (na przykład "corro-dashboard" lub "corro-mobile"), dodaj proszę notatkę do swojego README, aby wyjaśnić, że projekt nie jest tworzony przez zespół Corro Code i nie jest z nami w żaden sposób powiązany.

---

**Dołącz do naszej społeczności** [Discord](https://discord.gg/corro) | [X.com](https://x.com/corro)
