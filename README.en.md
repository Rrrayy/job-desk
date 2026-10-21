<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
  <img src="assets/banner-light.svg" alt="Job Desk" width="100%">
</picture>

**A local-first workbench for your job search.**

Run your application pipeline from a single HTML file: today's tasks, a board, silence detection, deadline countdowns, schedule conflicts, and interview notes.

[Download](#install) ｜ [Design](#design-trade-offs) ｜ [Architecture](#architecture) ｜ [Engineering](#engineering) ｜ [中文](README.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Rrrayy/job-desk/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Rrrayy/job-desk/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Rrrayy/job-desk?style=flat-square)](https://github.com/Rrrayy/job-desk/releases/latest)
![tests](https://img.shields.io/badge/tests-320%20passed-2ea44f?style=flat-square)
![bundle](https://img.shields.io/badge/bundle-480%20KB-4c6ef5?style=flat-square)
![requests](https://img.shields.io/badge/runtime%20requests-0-2ea44f?style=flat-square)
![schema](https://img.shields.io/badge/schema-v2-845ef7?style=flat-square)
[![license](https://img.shields.io/github/license/Rrrayy/job-desk?style=flat-square)](LICENSE)

</div>

> **After 50 applications, do you still remember which one to nudge, whose interview is today, and which one has been silent for two weeks?**
>
> That is the only problem this tool solves. One company, one pipeline line; one screen answers "what do I do now". It is not a job aggregator, it does not write résumés, and it never applies on your behalf.

<br>

<img src="assets/demo.gif" alt="Demo: sample data → Today → detail drawer and one-click follow-up → Board → calendar conflict → search to detail" width="100%">

<sub>Real recording, 21 seconds: load sample data → open the red to-do → one-click follow-up (the header's silence badge resets on the spot) → Board → the calendar catching an "interview × seminar" collision both ways → search jumps straight to the detail.</sub>

---

## Overview

An application has two lines that are easy to lose track of: **how long since they replied**, and **what deadline the outside world gave you**. Mixed onto one axis, they mask each other — the first gets diluted by "I just logged something yesterday", the second by "it's probably fine".

Job Desk models them separately: silence is derived from activity timestamps, deadlines are an independent three-state field, and the to-do list merges both in a fixed order (deadlines first, muting second). That is the skeleton; everything else extends it.

| Constraint | How |
| :--- | :--- |
| Zero runtime network requests | No fetch / XHR / beacon / WebSocket, no CDN, no third-party fonts; CI scans and fails on a hit |
| Single file, double-click | The build is one `index.html` that runs over `file://` — no Node, no local server |
| Data never leaves the machine | One primary key in browser storage; import/export through local file downloads |
| Crashes never lose data | A render error shows a recovery page; a read failure backs up the raw bytes before locking writes |
| Minimal dependencies | Runtime is `react` + `react-dom` only; no router, state, UI, date, or IDB library |

Applies to internships, summer internships, campus and experienced hiring — if you are applying, the model holds.

## Install

### Download (recommended)

Grab `index.html` from [Releases](https://github.com/Rrrayy/job-desk/releases/latest) and double-click it. No Node, no server.

```
index.html      one file, about 480 KiB
  ├─ open it    runs straight over file://
  └─ move it    copy to a USB stick, mail it to yourself — still opens
```

### Build from source

```bash
git clone https://github.com/Rrrayy/job-desk
cd job-desk/app
npm install && npm run build
open dist/index.html        # macOS; on Windows, double-click or `start dist\index.html`
```

### Dev mode

```bash
cd app && npm install && npm run dev   # http://localhost:5173
```

> First launch asks whether to load sample data (8 companies, 7 statuses) or start empty.
> To wipe everything later: Settings → Data → Reset to initial state.

### Optional browser extension

`extension/` is a zero-build MV3 extension that captures the text of the recruiting page you are already looking at, saving you the `Ctrl+A / Ctrl+V`. It is not on any store — load it unpacked.

The extension **does not parse**; it only emits an envelope:

```json5
{ "format": "boss", "url": "…", "title": "…", "capturedAt": "…", "text": "…" }
```

That envelope goes through **exactly the same** parser as the paste channel, so there is only one parser to maintain.

## Features

### Five views

| View | Question it answers |
| :--- | :--- |
| Today | Any interviews today? Who needs a nudge? What closes tomorrow? |
| Board | Where all 50 are stuck (wishlist → applied → chatting → interviewing → result) |
| List | Sorted by days of silence, coldest first |
| Calendar | Interviews, classes, and personal commitments on one grid, with minute-level collisions |
| Insights | Funnel, résumé-version hit rate, weekly volume; a second tab holds interview notes |

Cards surface the latest note you wrote (memo / chat / nudge) — no need to open the detail to recall where you left off.

### Judgement and reminders

The four kinds of reminder are not the same thing. They occupy four different cells of one grid:

```
               deadline far ──────────────────── deadline near
               ┌────────────────────┬────────────────────┐
silence short  │ nothing to do        │ normal pipeline      │
               │ deadline far         │ not yet time         │
               ├────────────────────┼────────────────────┤
silence long   │ time to nudge        │ one-click msg        │
               │ closes today         │ beats muting         │
               └────────────────────┴────────────────────┘
```

- **Silence detection** — thresholds scale by channel (referral ×3, official ×2); the offer stage is monitored separately and never scaled; an application with an explicit threshold ignores the multiplier
- **Deadline countdown** — expired / today / within 3 days; deadline items cannot be checked off in one click
- **Muting** — expires at "day N, 23:59:59", silences nudges but never a hard deadline — the bottom-right cell above
- **Collision detection** — interviews × classes × errands in one pool, reported only on the same day with `HH:mm` interval overlap
- One-click follow-up messages; a company in 3 seconds with just name and role

### Interviews and notes

- **Multi-round modelling** — one card per round, with prep checklist, format, and outcome
- **Quick capture** — one question per line, `Enter` to keep going, five questions in 90 seconds
- **Question bank** — filter by company / category / mastery / due / keyword, sorted weakest-first
- **Spaced review** — grading reschedules automatically
- **Stats** — which category you fail most (denominator is failed interviews), top-5 questions per company
- `community/` holds human-written notes (CC BY-SA 4.0), imported offline — the product never fetches them for you

### Data

- **File linking** — bind the workbench to a `data.json` you choose; every change is written to it automatically (one write at a time, consecutive changes collapse to the last version). Before writing it re-reads the file and compares digests — **if the file changed underneath, it does not overwrite**, it saves `data.conflict-YYYYMMDD-HHMMSS.json` and leaves the call to you
- **Recycle bin** — deleted applications stay 30 days with a reminder on day 27; interviews and notes come back with them
- **Incremental import** — fills gaps only, never overwrites what you recorded this week; differing values are listed row by row for you to decide, and résumé version / priority always keep the local value
- **CSV / JSON auto-mapping** — recognizable headers map to fields automatically; unrecognized columns are listed in the preview one by one (never silently dropped); nothing is written until you confirm
- **Backups** — JSON (the only lossless format), a portable zip (app + data + checksums, openable by the recipient with a double-click), CSV for spreadsheets, ICS for calendars
- **Optional encryption** — AES-256-GCM + PBKDF2-SHA256 at 600k rounds; off by default, you turn it on and set a passphrase in settings
- **Platform sync** — BOSS Zhipin / Shixiseng / Nowcoder / Liepin / generic tables: paste a listing or a job-detail page, review a diff, confirm row by row, undo the whole merge
- **Timetable import** — one class per line, bad lines reported with a reason; only course rows are replaced, manual entries never are
- **Storage upgrade** — `file://` uses localStorage; over `http(s)` IndexedDB is detected and preferred, lifting the 5 MB ceiling
- **Configurable backup reminder** — 3 / 7 / 14 days, or off (with file linking on, it softens to "export a snapshot now and then")

## Design trade-offs

Feature lists are everywhere; the trade-offs are what this project is. Each choice comes with its cost.

### Deadlines and silence are orthogonal axes

"How long since they replied" and "what the outside world demands of me" are different things. Merged, they mask each other.

> **How**　`deadlineAt` uses three-state semantics — unset (inherit) / `null` (explicitly off) / date (override); deadline items are not one-click checkable
>
> **Cost**　one more field and one more validator. `??` is a trap here (it collapses `null` and `undefined`, which mean opposite things), so validation must go through `asTriStateDate()`

### Muting silences nudges, never hard deadlines

"Not today" is a legitimate request; "the application closes tomorrow" should never be hidden by an algorithm.

> **How**　a mute expires at "day N, 23:59:59", not `now + N×24h`; in todo generation, **deadlines are computed before the mute check**
>
> **Cost**　a muted application can still appear in Today if it is about to expire. That is deliberate

### The calendar is a general schedule, not an interview calendar

In reality collisions involve more than interviews — lab meetings, appointments, errands.

> **How**　a single `db.events` table holds everything (`kind` separates classes from personal items; `weekly` by weekday, or a single date); a collision is "same day + `HH:mm` interval overlap" (`a.start < b.end && b.start < a.end`), touching endpoints do not collide
>
> **Cost**　timetable import is replace-semantics for `course && weekly` rows only; "manual entries are never overwritten" is asserted in tests, not in comments

### Three ways out when something goes wrong

"I slipped", "I regret it", and "it crashed" are three different accidents. Each needs its own mechanism; collapsing any two leaves one of them unhandled.

| Accident | Mechanism | Boundary |
| :--- | :--- | :--- |
| Slipped (deleted, changed status) | Undo stack, 10 steps + redo | Memory-only, cleared on reload; a sync merge is undoable but not redoable |
| Regret (want it back days later) | Recycle bin, soft delete for 30 days | Applications only |
| Crashed (render error, unreadable, write failed) | Recovery page + read-only lock | Exits only, never auto-repair |

> **How**　undo snapshots one operation, never the whole database; deleting an application carries the rows it took with it (interviews, timeline, note bindings); `ErrorBoundary` offers three exits (reload / download raw JSON / copy the error), and a read failure first stores the raw bytes under `failedAt.*`, then locks persistence so `saveDB` becomes a no-op
>
> **Cost**　each mechanism has its own tax: restoring must handle "this note was rebound to another application" — in that case it **does not steal it back**; the undo stack dies on reload (persisting it raises "undo to which version?"); and the recovery page **forbids any automatic repair**, because auto-repair turns "recoverable" into "unrecoverable" — it offers exits only, and never guesses, fixes, or deletes

### One HTML file is a verifiable constraint, not laziness

The price of a single file is a size ceiling; the payoff is that every promise can be machine-checked.

| Promise | Implementation | Regression guard |
| :--- | :--- | :--- |
| Zero network requests | No fetch / XHR / beacon / WebSocket, no CDN | CI scans 11 rules; allowlist is empty |
| Single-file, double-click | `vite-plugin-singlefile` + `base:'./'`, inlined JS/CSS | Artifact check + size red line |
| Data never leaves the machine | One primary key; import/export via download | CI scan + review red line |
| Corruption never loses data | Back up raw bytes on read failure, then lock writes | Three corruption scenarios × repeated reloads |
| Undo never swallows data | Per-operation snapshots, pure-function rollback | Unit tests |
| Sync never fakes silence | `touchedAt` only from platform `lastContactAt`; `lastActivityAt` only via `max()` | 31 sync-engine tests |
| Migrations are idempotent | Pure functions, additive only, snapshot first | 11 migration tests + failure page |

**Cost**: a hard 560 KB ceiling (WARN at 540 KB). Features cannot grow without bound. That is deliberate.

### File linking: write a conflict copy rather than overwrite

"Let the data land in my own file whenever the browser is open" sounds like skipping a download, but it has six failure layers to handle:

> **How**　a per-filename write queue (depth 1, consecutive changes collapse to the last version) → re-read the file and compute SHA-256 → compare with "the digest we left after our last write" → on mismatch **write the conflict copy first, then leave the main file alone** → drop a write-ahead record before writing (replayable after a power cut) → identify handles only via `isSameEntry`, re-request permission every time
>
> **Cost**　the first connection never reports a conflict (with no baseline, forcing a decision is meaningless); when the conflict copy cannot be written the main file is **not touched at all**, which means "this save did not happen"; handles live in a separate IDB, so clearing site data loses them and you re-pick the file. Browsers without the capability (Safari / Firefox / mobile) are told "unsupported" and keep manual import/export — no dead button that does nothing

When the browser revokes write permission the app enters a **read-only lock** and always offers three exits: download the raw file / retry / save as a new file. Your original data is never modified or deleted automatically.

### Encryption is optional, and does not pretend to do more than it can

> **How**　AES-256-GCM + PBKDF2-SHA256 at 600,000 rounds (the OWASP 2023 figure); a fresh 12-byte IV and 16-byte salt on every encryption; `extractable: false`; the envelope is plain JSON so the app can tell "this is an encrypted backup" without the passphrase; a GCM authentication failure raises an error and never returns half a plaintext; off by default, you turn it on
>
> **Cost**　front-end encryption **cannot** defend against XSS or a malicious extension reading process memory — decrypted plaintext is necessarily in memory. Its boundary is "a backup that lands on cloud storage, a USB stick, or someone else's machine cannot be read without the passphrase". That sentence is printed verbatim in settings. PBKDF2 also resists GPU cracking less well than Argon2id (chosen because Argon2id needs a third-party library, which conflicts with the zero-dependency promise), hence 600k rounds — and on low-end devices key derivation takes a fraction of a second **on purpose**. Forget the passphrase and that backup is gone; there is no recovery channel

### Where the "no dependencies" line sits

| Need | Usual choice | Here | Why |
| :--- | :--- | :--- | :--- |
| IndexedDB wrapper | Dexie | ~60 lines of native IDB | One kv store is all that is needed; every runtime dep adds size and supply-chain cost |
| List virtualisation | react-window | ~80 lines of pure functions + a hook | The need is "compute a range from a row height"; a third-party component's internals cannot be unit-tested |
| ZIP packaging | jszip | ~90 lines, store mode | The app HTML is already compressed; deflate saves ~5% more; fixed timestamps are what make it reproducible |
| Date arithmetic | date-fns / dayjs | Hand-written calendar-day diff | Only two semantics are needed: calendar-day difference and "day N, 23:59:59" |

The line is not "never use a library" but **write it yourself only when the dependency costs more than the code**, and whatever you write must have unit tests.

## Architecture

**Stack**: Vite 5 + React 18 + TypeScript 5.6 strict. The only runtime dependencies are `react` and `react-dom`.

```
localStorage / IndexedDB
        │  readSync / loadDBAsync
        ▼
   validateV2  ──►  migrations (pure, idempotent, with rollback points)
        │
        ▼
    App.tsx   owns the DB; every write goes through mutate() (carries the undo snapshot)
        │  api.db is the "view database" — recycle-bin rows are removed here, the single filter point
        ▼
   Derived in views (pure functions, never persisted)
        │  silence days · todo aggregation · funnel stats · collisions · window range
        ▼
    33 components, no UI kit, one styles.css with CSS-variable design tokens
```

**Structural decisions**:

- **Derived over stored** — silence days, todos, funnel stats, and collisions are pure functions of `DB`. A persisted derived value always drifts from reality eventually
- **A single filter point** — soft deletion is not checked at 40+ consumption sites but where `api.db` is built. Checking at every site guarantees a miss, and the miss is the one that shows a deleted application
- **Storage backend abstraction** — a `StorageBackend` interface plus runtime detection. `file://` uses localStorage and does not probe IDB (the primary path — an extra retry only slows the first paint); `http(s)` probes IDB
- **Parsing separated from merging** — adapters are pure functions (text → records) and the merge algorithm is maintainer-owned. Adding a platform means a new adapter + fixture + tests, never a branch in the engine
- **File handles are stored apart from app data** — the `jobdesk.fs` IDB holds handles only. A main-backend failure must trigger the read-only lock; a handle failure only means "pick the file again". Different severity, so they never share a failure path

Full data model, merge algorithm, and field-ownership rules: [`docs/ARCHITECTURE-v0.2.md`](docs/ARCHITECTURE-v0.2.md).

<details>
<summary><b>📁 Repository layout</b></summary>

```
job-desk/
├── app/
│   ├── src/
│   │   ├── App.tsx            # state hub; every write goes through mutate()
│   │   ├── types.ts           # data model (schema v3)
│   │   ├── adapters/          # boss / shixiseng / nowcoder / custom (each with fixtures + tests)
│   │   ├── lib/
│   │   │   ├── rules.ts       # silence, deadlines, todo aggregation, funnel, templates, collisions
│   │   │   ├── storage/       # backend abstraction: backend / idb / detect
│   │   │   ├── storage.ts     # read/write, validation, migration entry, corruption lock, quota
│   │   │   ├── sync/          # sync engine: normalize / statusMap / engine / capture
│   │   │   ├── fileLink/      # file linking: hash / handle / pending / engine
│   │   │   ├── crypto.ts      # optional encryption: AES-256-GCM + PBKDF2
│   │   │   ├── csvImport.ts   # CSV / JSON field auto-mapping with preview
│   │   │   ├── trash.ts       # recycle bin: soft delete, expiry sweep, single filter point
│   │   │   ├── merge.ts       # incremental import, field ownership, conflict computation
│   │   │   ├── portable.ts    # portable ZIP (store mode, reproducible)
│   │   │   ├── virtual.ts     # list virtualisation: range math + hook
│   │   │   ├── migrate.ts     # v1 → v2 → v3 (pure, idempotent, additive)
│   │   │   ├── rollback.ts    # rollback points and 30-day cleanup
│   │   │   ├── courseImport.ts# timetable text parser (bad lines get a reason)
│   │   │   ├── tableExport.ts # CSV / ICS export (formula-injection safe, RFC 5545 folding)
│   │   │   └── interview.ts   # note stats and spaced review
│   │   └── components/        # views + drawers + notes + sync + file-link + CSV preview + ErrorBoundary
│   ├── scripts/               # typecheck / test / bundle / no-network / versions / pack / bench
│   └── smoke-v05.mjs          # CDP end-to-end smoke
├── extension/                 # optional MV3 extension (activeTab + scripting only)
├── community/                 # community interview notes (CC BY-SA 4.0, offline import)
├── docs/                      # PRD / architecture / QA report / adapter guide / release notes
├── assets/                    # banners and the demo GIF
└── CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  LICENSE
```

</details>

<details>
<summary><b>📐 Core algorithm: silence</b></summary>

```
lastActivityAt = max(statusChangedAt, all note.touchedAt under this application)
silenceDays    = calendar-day difference between today(00:00) and lastActivityAt
```

- Thresholds scale by channel: referral ×3, official ×2, others ×1. **An application with an explicit threshold ignores the multiplier**
- Silence covers applied / chatting / interviewing / offer. Interviewing uses "waiting for result"; offer uses `offerSilenceDays`
- **Any timeline entry or status change refreshes `lastActivityAt` immediately** and clears the red flag — no manual "un-silence"
- Undo rolls back that one status change only; notes, interviews, and settings written afterwards survive

</details>

<details>
<summary><b>🗄️ Where the data lives, and how to back it up</b></summary>

| Key | Contents |
| :--- | :--- |
| `jobdesk.v1` | Everything: settings, companies, applications, interviews, timeline, notes, questions, staging, schedule |
| `jobdesk.v1.ui` | Last view position |
| `jobdesk.v1.listFilters` | Last list filters |
| `jobdesk.v1.preMigrate.<ts>` | Pre-migration snapshot (rollback point, kept 30 days) |
| `jobdesk.v1.failedAt.<ts>` | Raw copy after a read failure (max 3, never modified) |
| `jobdesk.v1.fsBaseline` | Digest of the file as of our last write (the conflict baseline) |
| `jobdesk.v1.fsPending` | One interrupted write (sent but unconfirmed; replayable on next launch) |

When served over HTTP, the same data lives in the `jobdesk` / `kv` IndexedDB store under the same keys. File handles live in a separate `jobdesk.fs` / `handles` store — a main-backend failure must trigger the read-only lock, while a handle failure only means "pick the file again". Different severity, so they never share a failure path.

- Data lives in this browser only: closing, refreshing, rebooting are fine; clearing site data, private windows, or another browser/device lose it
- **Export before switching machines**: Settings → Data → Export JSON (the only lossless format)
- **Want the data to land in a file by itself**: Settings → File linking → Connect, pick a `data.json`. Every change is written to it; conflicts never overwrite
- **Want the app to travel too**: export the portable zip — `index.html` + `data.json` + readme + checksums
- Settings shows "last backup: N days ago" and turns red past the threshold. The threshold is configurable (3 / 7 / 14 days, or off). It reminds, it never blocks

</details>

<details>
<summary><b>🔄 Platform sync boundaries</b></summary>

Recruiting platforms expose no public API (and would not give one to an individual developer). So this is not scraping — it reads **what is already on your screen**:

```
① Capture: select-all + copy, or the extension
② Preview: five counts (new / updated / unchanged / conflict / staging) + a diff table
③ Confirm: tick row by row; conflicts are unticked by default
④ Commit: how many were written, how many went to staging
```

- **Only step ④ writes.** Going back from steps ①–③ has zero side effects
- Timelines use the platform's **last-contact time**, never the capture time — otherwise every sync silently resets your silence clock
- A platform "interview invitation" maps to "chatting" plus a todo; it never schedules an interview or creates an interview record
- Unchanged rows write no timeline entry; unrecognised rows go to staging with a reason and are never dropped
- Counts must balance: new + updated + unchanged + conflict + staged === detected

See [`docs/adapters/README.md`](docs/adapters/README.md) to add a platform; every adapter ships with fixtures and tests.

</details>

<details>
<summary><b>🔒 Privacy and non-goals</b></summary>

The hardest promise: **when you open the page, the browser makes no request on its behalf.**

- No analytics, no telemetry, no third-party fonts, no CDN, no update check
- `npm run check:no-network` statically scans `app/src` and `extension/` (11 rules, including CSS `url()` / `@import` / `<link href>`). A hit fails CI. The allowlist is **empty** — empty means zero, not "not filled in yet"

Out of scope by design, not by schedule:

- Accounts and cloud sync — the moment there is a server, "zero requests" becomes a lie
- Auto-login, auto-apply, background daemons, scheduled scraping
- Splitting the single file into a server-backed app
- Résumé generation and job aggregation

</details>

## Engineering

`npm run verify` runs eight gates; any red blocks the merge.

| # | Gate | Command | Guards |
| :--- | :--- | :--- | :--- |
| 1 | Typecheck | `typecheck` | TS strict + `noUncheckedIndexedAccess`; exhaustive `Ownership` checks on new fields |
| 2 | Unit tests | `test` | Full coverage of pure functions |
| 3 | Lint | `lint` | Correctness + React hooks + architectural boundaries (adapters may not import React/storage/sync, read the DOM, or fetch) |
| 4 | Network scan | `check:no-network` | 11 rules, empty allowlist |
| 5 | Build | `build` | Single-file artifact still builds |
| 6 | Bundle red line | `check:bundle` | >540 KB warn / >560 KB fail; single-commit growth >20 KB also blocked |
| 7 | Version agreement | `check:versions` | `package.json` / extension `manifest.json` / artifact must agree |
| 8 | Community content | `validate:community` | Format, uniqueness, length, anonymisation |

**Current baseline** (reproducible in CI):

| Metric | Value |
| :--- | :--- |
| Unit tests | 391 across 27 files, all green (incl. 9 disaster-recovery cases) |
| End-to-end smoke | 21 checks via CDP against real Edge, including ZIP central-directory parsing |
| Performance bench | `npm run bench`: 50 / 200 / 500 / 1000 rows; 1000 rows renders 15, sort 21 ms, first paint 60–88 ms |
| Bundle | 543,377 B (531 KiB); red line 540 KB warn / 560 KB fail ([why 560](docs/RELEASE-NOTES-v0.6.0.md)) |
| Network scan | Passing, empty allowlist |
| Independent QA | 478 assertions, 0 failures ([`docs/QA-REPORT-v0.2.md`](docs/QA-REPORT-v0.2.md)) |
| Reproducible build | Clean `npm ci && npm run build` yields identical sha256 |

Neither the bench nor the smoke runs on jsdom: it has no layout and no compositor, so the most expensive operations (table reflow, scrolling) cannot be measured realistically. The smoke script self-checks — if data never reached the UI (for example it landed on the failure page) it fails outright instead of printing a row of pretty fake numbers.

<details>
<summary><b>🛠️ Development and release commands</b></summary>

```bash
cd app
npm install

npm run dev              # dev server
npm run typecheck        # tsc --noEmit
npm test                 # vitest
npm run build            # typecheck + single-file dist/index.html
npm run check:bundle     # bundle red line
npm run check:no-network # static scan: no network calls
npm run check:versions   # three-way version agreement
npm run validate:community
npm run bench            # CDP performance bench
node smoke-v05.mjs       # CDP end-to-end smoke

npm run verify           # all eight gates
npm run release:pack     # reproducible release assets
```

Before releasing, walk through [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md).

</details>

## Shortcuts

| Key | Action |
| :--- | :--- |
| `N` | New application |
| `1` – `5` | Today / Board / List / Calendar / Insights |
| `⌘K` / `Ctrl+K` | Global search (Enter opens the first hit) |
| `⌘Z` / `Ctrl+Z` | Undo (up to 10 steps) |
| `⇧⌘Z` / `Ctrl+Y` | Redo |
| `Esc` | Close overlay / drawer |

## Known limitations

Nothing hidden. Each item is a real boundary of the current release, not a "coming soon".

- **Each of the three exits has a gap**: the undo stack is memory-only (cleared on reload — by design, since persisting it raises "undo to which version?"); the recycle bin covers applications only, so deleting a company / interview / event can only be rescued by the undo stack
- **IndexedDB is preferred, not required** — when disabled or in private mode it quietly falls back to localStorage with its 5 MB ceiling
- **File linking is Chromium-desktop only** — Safari / Firefox / mobile have no File System Access, so they show "unsupported" and keep manual import/export. Pages served over plain `http://` also lack the capability (not a secure context); use https or open the file directly
- **File handles get lost** — clearing site data, private windows, or switching browsers drops the handle and you re-pick the file. That is the browser's design, not a defect
- **Encryption does not stop a local attacker** — it protects a backup file *after it leaves this machine*; XSS and malicious extensions can read the decrypted plaintext in memory. A forgotten passphrase has no recovery channel
- **When the conflict copy cannot be written, the save does not happen** — without access to the containing directory the app cannot create `data.conflict-*.json`, so the main file is left untouched and the conflict is only reported in the UI
- **CSV mapping reads headers, never guesses content** — unrecognized columns are listed in the preview and ignored; a file with no header row falls back to "column 1 = company, column 2 = role" and says so explicitly
- **Sync is text parsing, not an API** — platform redesigns break it; it says "could not parse" and never silently drops data. BOSS's record page, all four platforms' job-detail pages and Liepin's delivery list are calibrated against real device text; Shixiseng / Nowcoder lists currently hold no data on the maintainer's account and await their first real sample
- **Bare personal names are not anonymised** — title anchors (interviewer / teacher / manager) are handled; pure names need NER, which regex cannot do
- **Large libraries have a ceiling** — 1000 applications works (virtualised list), but derived views such as insights and the calendar still scale linearly with row count and are not yet sharded
- **Mobile is usable, not designed** — narrow screens are responsive, but drag-and-drop and keyboard shortcuts are desktop-first
- **Clipboard may be unavailable** over `file://` in some browsers; message templates then expand into a textarea
- **Deadlines are per-application** — there is no season-wide deadline
- **Single-file size has a hard ceiling** — over 560 KB fails CI. Deliberate, not a bug

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). For a platform adapter, start at [`docs/adapters/README.md`](docs/adapters/README.md); for interview notes, see [`community/SCHEMA.md`](community/SCHEMA.md) — **anonymisation is a hard red line**. What changed in each release is in [`CHANGELOG.md`](CHANGELOG.md).

Run `npm run verify` before opening a PR; eight green gates are the price of admission. For security issues, **do not open a public issue** — use the private channel in [`SECURITY.md`](SECURITY.md).

## License

- Code: MIT — see [`LICENSE`](LICENSE)
- Community notes (`community/`): CC BY-SA 4.0 — see [`community/LICENSE`](community/LICENSE)

---

<div align="center">

If it helped you land an offer, a star helps the next person find it.

<sub>Job Desk · MIT License</sub>

</div>
