# CORRO CODE — HANDOFF (continue here, no context needed beyond this file)

## What this is
Full opencode engine (all tools/agents/models/sessions) rebranded end-to-end as **Corro Code**,
Windows desktop client + trial backend. Owner tests the app live; Google login is PARKED
(user order) — app must open straight into the full product, no gate.

## Workspace (Windows, PowerShell 5.1 — NOT bash)
Root: `C:\Users\amera\OneDrive\Desktop\New folder (2)\`
- `opencode-dev\` = the product. Git repo (init'd by us), branch `main`. Log:
  `7ee5bce` prompts baseline → `86c2704` locale rebrand → `b50dacc` desktop identity →
  `502ebfb` auth module+gate → `2f910ca` gate-context fix → `+1` gate parked (signed-out goes straight in).
  Working tree currently has UNCOMMITTED redesign edits (wordmark, home, URLs, plugin, provision).
- `corro-code-backend\` = trial backend (Vercel). Pushed `e6900e6`, but there are
  UNCOMMITTED changes on top: `M api/chat/completions.js` (25s upstream timeout +
  friendly retryable 504), `M test/backend.test.js` (504 test), `?? public/`
  (changelog.json). Tests pass 25/25. TODO: commit + push + confirm Vercel deploy.
  Untracked junk `desktop/smoke*.log` must stay (user: delete nothing).
- Temp scripts: `C:\Users\amera\AppData\Local\Temp\opencode\` = `shot.ps1` (PrintWindow screenshot),
  `cdp.mjs` (CDP DOM interrogation), `models.mjs`, `variants.mjs`.

## Shell rules (learned the hard way)
- PowerShell only: no `head/sed/grep/wc`, no heredocs, use `npm.cmd`/`npx.cmd` (ps1 blocked).
- `bun -e` quoting breaks: write temp `.mjs` files and run them.
- Harness kills lingering GUI children: test processes must self-exit. Use
  `Corro Code.exe --remote-debugging-port=9333` + CDP over bun WebSocket (see `cdp.mjs`).
- 7.8GB RAM: builds need `$env:NODE_OPTIONS="--max-old-space-size=6144"`.
- `bun install` node-gyp failure on tree-sitter-powershell is HARMLESS (wasm present).
  Electron binary once needed manual `Expand-Archive` from `%LOCALAPPDATA%\electron\Cache`.
- Kill `Corro` processes before rebuild (file locks).
- SolidJS contexts are LEXICAL: renderer children of AppInterface canNOT use server hooks
  (caused the ServerSDK crash). Provisioning lives in main process; gate uses only `window.api`.
- Typecheck baseline: 131 pre-existing errors repo-wide; our files must add ZERO
  (`bun run typecheck` in `packages/desktop`, grep output for `corro`).
- Desktop unit tests: `bun test src/main/corro-config.test.ts` (8 tests, merge/parse logic).
- Plugin tests must run from `packages/opencode` with `--timeout 10000`.
- Backend tests: `node --test "test/**/*.test.js"` in corro-code-backend (25 tests).

## Engine architecture (CORRECTED — read this)
- The desktop runs the engine via the **v1 in-process sidecar**: main `index.ts`
  (`SIDECAR_VERSION`, default `"v1"`) → `utilityProcess.fork(out/main/sidecar.js)` →
  imports `./chunks/node-*.js` (31MB, built from workspace `core`+`opencode` source by
  electron-vite). So core/opencode edits (Zen rename, billing header, CorroPlugin,
  splash, OAuth page, retry upsell) DO go live on `bun run build`. Verified:
  `provider11.name = "Zen"` present in the built chunk.
- The **v2 `opencode-cli.exe` path is dormant** (only if `OPENCODE_SIDECAR_V2=1`).
  `resources/opencode-cli.exe` does NOT exist and is NOT needed for prod packaging.
  Never run a dev-channel prebuild that downloads the upstream CLI into resources.
- Updater 404s on `releases.atom` until the `v2.0.0` GitHub release exists (blocked on PAT).

## Backend deploy BLOCKAGE (owner action needed)
- Vercel GitHub-integration state per commit: `e88e63f` success (Sep 2, CURRENT
  production) → `e6900e6`, `846a05d`, `67987a5`, `acb092a` ALL
  `failure` / "Deployment was blocked". So production still runs Sep-2 code:
  streaming SSE, x-own-key, 25s timeout, changelog, icon are NOT live (trial chat
  itself works — owner verified live in app).
- "Blocked" = Vercel deployment protection/authorization, not a build error
  (all api files pass `node --check`, backend tests 27/27). Owner must open the
  Vercel dashboard → Deployments → unblock/redeploy (likely re-authorize GitHub
  App or lift Deployment Protection), then confirm:
  `/changelog.json` serves the feed and `/icon.png` serves the copper PNG
  (served via `api/changelog.js` + `api/icon.js` rewrites; root copies are backup).
  Diagnose anytime with TEMP `ghdeps.ps1`/`ghfail.ps1` (uses the machine's stored
  GitHub credential; prints statuses only, never the token).

## Key architecture facts (do not re-research)
- Corro provider = plain `opencode.json` custom provider (`npm @ai-sdk/openai-compatible`,
  `baseURL https://corro-code-backend.vercel.app/api/chat`, key = Supabase JWT in `auth.json`).
  No engine fork needed for the provider path.
- `opencode.json` v1 shape auto-migrates. `limit:{context,output}` REQUIRED (0 = "Context 0" bug).
  `tool_call:true` + modalities text. Variants v1 = RECORD `{think:{},"think-deep":{}}`.
  Capabilities default `reasoning:false` → engine does NOT attach killer `reasoningEffort`
  variants (backend 400s on those). Do NOT set reasoning capability.
- Thinking levels = `CorroPlugin` (`packages/opencode/src/plugin/corro.ts`,
  registered in `plugin/index.ts` internalPlugins) `chat.message` hook: prepends
  "Think briefly.\n" / "Think step by step.\n" once at admission for corro models only.
- Provision merge (`desktop/src/main/corro-config.ts`) only ADDS/heals, never removes user data.
- Trial models + safe budgets: kimi-k3 262144/32768, deepseek-v4-flash 131072/32768,
  minimax-m3 196608/32768, nemotron-3-super 262144/16384. Default model = flash-first.
- Backend: `/api/chat/completions` proxies NVIDIA; `stream:true` supported (SSE pipe);
  `x-own-key` header OR `body.apiKey` bypasses trial; 25s upstream abort → friendly retryable 504.
- App ids: `ai.corrocode.desktop[.dev|.beta]`; protocols `corro://` (+legacy `opencode://`);
  userData `%APPDATA%\ai.corrocode.desktop`; exe `Corro Code.exe` (Task Manager clean).
- Leak-grep rule: 0× `OpenCode` brand-case, `nvidia|nvapi`, `opencode.ai`, `vercel.app` in
  renderer bundle (1 code-only backend URL in main bundle is required, never displayed).
- Branding kept internal (must NOT rename): `@opencode-ai/*` imports, `__OPENCODE__`,
  `OPENCODE_*` flags, `opencode.json` filename, storage keys, `x-opencode-directory`,
  `opencode-cli` resource, migrate.ts legacy ids, LICENSE (MIT attribution stays).

## Done, verified
Backend tests 27/27; backend pushed to `acb092a` but production pinned at `e88e63f`
by the Vercel block (see above). Prompts rebranded, 125+ locale files rebranded
(values only), desktop identity/icons/title (window title "Corro Code" verified on
pixels), gate renders (screenshot-verified), no-crash launch + sidecar ready in logs,
installer `dist/Corro-Code-Setup-2.0.0.exe` 125MB + latest.yml, leak grep passes,
plugin hook + provision merge unit-tested, CDP DOM probe shows 0 "opencode" text nodes.
Redesign live in running build (CDP: copper hero `corro code`, title `Corro Code`;
screenshot: context bar above composer, copper top border, trial pill).
Zen rename compiled into server chunk + body-wide `hasOCZen:false` via CDP.
Owner live-tested: trial chat works, agent correctly identifies as Corro Code.
ARCTIC LIGHT (`53c232a`): Corro theme restyled (arctic paper/slate/copper light,
warm charcoal/copper dark), v2 accent transplant blue→orange ramp (21 tokens),
Corro signature CSS (`html[data-theme=opencode]`: Segoe UI voice, hero copper wash,
composer glow, 16-18px dialog/menu radii), default theme `oc-2`→`opencode`,
default scheme `system`→`light`, preload migrates stored oc-1/oc-2→opencode once,
preload test updated (2 pass). Fresh installs AND the owner profile open Arctic.
Screenshot-verified: light home, light session timeline, light new-session hero.
Quirk: explicitly picking OC-2 in the theme picker is re-migrated to Corro on
restart (one-way retirement). Installer rebuilt 13:02 with everything.

## In progress / TODO (in order)
1. **Backend unblock (OWNER)**: Vercel dashboard → redeploy `acb092a`; confirm
   `/changelog.json` + `/icon.png` live. Until then production lacks streaming,
   x-own-key, 25s timeout, feed, icon.
2. **Commit opencode-dev batch** (~107 files: redesign + sweep + Zen + HANDOFF).
3. **User test checklist**: think/think-deep variants, context counts per trial model,
   heartbeat refresh, queue/expired cards (login still parked per user order).
4. **Publish**: BLOCKED — PAT from brief is dead. Fresh PAT → `v2.0.0` release +
   upload exe/latest.yml/blockmap, report URL+sha256.
5. **Later (parked by user)**: Google login gate re-enable, SPA browser-chat removal,
   `install-cli` handler (missing upstream — menu item errors).
6. **Agents/skills defs**: DONE for user-visible strings except — remaining known
   residuals, all code-only/invisible (do NOT churn): `OpenCodeEvent` type names,
   `opencode-theme-id` storage key, `opencode` theme id, `oc-2`/`OC-2` theme id/label,
   `opencode-icon-*` SVG sprite ids, JSDoc in generated SDK (`sdk.gen.ts`,
   regenerate via `packages/client` `bun run generate` — would re-emit upstream text),
   `$schema: .../desktop-theme.json` strings, `nvidia` provider-id list entry,
   `opencode.ai/install` WSL bootstrap curl (functional — installs upstream CLI;
   replacing breaks WSL install), Zen `opencode.ai/zen` links (functional),
   e2e/storybook/test mocks, `console`/`stats`/`web` packages (not shipped).

## Mystery note (resolved)
Old "opencode" watermark on screen despite clean bundle → it was `WordmarkV2`
(720×129 v2 wordmark in new-session home), NOT `Logo`. Both replaced and verified
live via CDP + screenshot.
