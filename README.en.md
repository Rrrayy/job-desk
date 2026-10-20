# Job Desk

### Local-first recruitment workbench: internships, autumn / spring campus hiring, early batch, and experienced hires

**One HTML file. No account, zero network requests, your data never leaves your browser.**

One company = one pipeline line; the first screen always answers "what should I do today?".
It is not a job aggregator and not a resume builder — it solves exactly one problem:
after 50 applications, do you still remember which one to nudge, which interview is today,
and which one has been silent for two weeks?

```
download dist/index.html → double-click → record your first company
```

![Today view](docs/screenshots-v0.2/05-view-今日-1440.png)

---

## Contents

- [What it does](#what-it-does)
- [Scenarios & compatibility matrix](#scenarios--compatibility-matrix)
- [Getting started](#getting-started)
- [Where the data lives](#where-the-data-lives)
- [Privacy and non-goals](#privacy-and-non-goals)
- [Platform sync](#platform-sync)
- [Interview notes and review](#interview-notes-and-review)
- [Silence rule](#silence-rule)
- [Architecture & design constraints](#architecture--design-constraints)
- [Engineering quality](#engineering-quality)
- [Development](#development)
- [Layout](#layout)
- [Roadmap](#roadmap)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## What it does

Five views, all answering "what now?":

| View | Question it answers |
| --- | --- |
| **Today** | Which interviews are today? Who should I nudge? Who's gone quiet? |
| **Board** | Where are my 50 applications stuck (wishlist → applied → chatting → interviewing → result) |
| **List** | Sorted by silence days — the coldest ones on top |
| **Calendar** | Do this week's interviews clash with my classes? |
| **Review** | Funnel conversion, resume-version hit rate, weekly volume; sub-tab for **interview notes** |

- Record a company in 3 seconds, drag between stages, `⌘Z` undoes one step at a time
- Silence detection with channel multipliers (referral ×3, careers page ×2); red means it's really time
- Follow-up message templates generated from context
- Multi-round interviews modeled explicitly, with prep checklists, format, and per-round results
- **Platform sync**: paste your BOSS / Shixiseng / Nowcoder list, get a five-way diff, confirm row by row, undoable
- **Interview notes**: one line per question → spaced review → "which topics do I keep failing" → Markdown export
- JSON import/export, automatic schema migration with a rollback point (failure never locks or overwrites)

## Scenarios & compatibility matrix

Job Desk is not bound to "daily internships". The data model's `jobType` covers three
categories today; the state machine and silence algorithm are scenario-agnostic.
An honest support table — anything not marked ✅ is not done yet:

| Scenario | Support | Notes |
| --- | --- | --- |
| Daily internship | ✅ Full | Design origin |
| Summer internship | ✅ Full | `jobType = summer` |
| Autumn hiring / early batch | ⚠️ Usable, v0.3 focus | `jobType = fulltime`; multi-round interviews are modeled, but batch workflows for 100+ applications, performance headroom, and offer comparison are on the roadmap |
| Spring hiring | ✅ Usable | Same flow as autumn; shorten silence thresholds for the tighter window |
| Experienced hires | ⚠️ Partial | Flow works; compensation structure / level / headhunter channel fields come with the v0.3 model |

**Real differences between scenarios, and how we treat them:**

- **Volume**: 10–30 applications for daily internships vs 150–300 in autumn hiring.
  Lists and boards are virtualized, but *bulk operations* (batch silence / tagging) don't exist yet —
  the biggest current gap.
- **Rounds**: internships run 1–2, autumn runs 3–5 plus cross panels. Rounds are modeled;
  round-progress visualization isn't (yet).
- **Windows**: autumn concentrates into Sep–Nov, so many statuses flip in the same week.
  Today's priority sort (urgency × silence) holds up; deadline-driven sorting is the v0.3 upgrade.
- **Decision factors**: experienced hires weigh compensation packages; students weigh platform and growth.
  Offer comparison tooling is on the roadmap.

## Getting started

```bash
git clone https://github.com/Rrrayy/job-desk
cd job-desk/app
npm install && npm run build
# double-click app/dist/index.html — one self-contained file, works anywhere
```

`dist/index.html` inlines all JS/CSS and opens directly from `file://`, no server needed.

> Repo home: `https://github.com/Rrrayy/job-desk`. If you fork and release your own build,
> run through [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md) first and swap the badge
> and the `repository` / `homepage` fields in `app/package.json` to your own address.

Development mode:

```bash
cd app && npm install && npm run dev   # http://localhost:5173
```

## Where the data lives

| localStorage key | Content |
| --- | --- |
| `jobdesk.v1` | everything: settings, companies, applications, interviews, timeline, notes, questions, staging |
| `jobdesk.v1.ui` | last view (restored on reload) |
| `jobdesk.v1.listFilters` | list-view filters (restored on reload) |
| `jobdesk.v1.preMigrate.<ts>` | pre-migration snapshot (rollback point, kept 30 days) |
| `jobdesk.v1.failedAt.<ts>` | raw data copy on read failure (max 3, never auto-modified) |

- Data stays in this browser only — no cross-device, no upload.
- Clearing site data clears it too — **export before switching machines**.
- On corruption / failed migration the app enters a read-only locked state with three exits
  (download raw data, retry, continue empty); the raw data is **never auto-modified or deleted**.

## Privacy and non-goals

The hardest promise in this project: **opening the page sends zero network requests.**

- no analytics, no telemetry, no CDN, no third-party fonts, no update checks
- `npm run check:no-network` statically scans `app/src` and `extension/`; any `fetch` /
  `XMLHttpRequest` / `sendBeacon` / `WebSocket` fails CI
- the allowlist file is **empty by default** — empty means there are genuinely none

Explicit non-goals (product positioning, not backlog):

- ❌ accounts / cloud sync / multi-device sync
- ❌ automating logins, applications, or messages on job platforms
- ❌ background processes or scheduled scraping
- ❌ splitting the single-file build into a multi-file app that needs a server

## Platform sync

Platforms have no public API, so this is not a crawler — it reads **what you can already see on screen**:

```
① capture: select-all copy/paste, or one click via the MV3 extension
② preview: five-way count (new / update / unchanged / conflict / needs-triage) + diff table
③ confirm: row by row, conflicts unchecked by default
④ write: applied changes + triage-queue count
```

Hard rules the engine enforces (documented in `docs/ARCHITECTURE-v0.2.md`):

- **Only step ④ writes.** Backing out of earlier steps has zero side effects.
- Sync-written timeline entries use the platform's **last-contact time**, never "the moment I scraped" —
  otherwise every sync silently resets your silence timer.
- `lastActivityAt` is always recomputed via `max()`; never hand-overwritten.
- "Invite to interview" maps to "chatting" plus a to-do; it never schedules or fabricates interviews.
- Unchanged records write no timeline (no sync-noise spam).
- Unmatched records go to a triage queue; nothing is dropped.
- The whole merge is undoable, field by field.

Supported platforms: BOSS Zhipin, Shixiseng, Nowcoder, plus a generic table fallback. Platform redesigns:
see [`docs/adapters/README.md`](docs/adapters/README.md) — every adapter ships fixtures and unit tests.

## Interview notes and review

Entry point: **Review → [Notes]**.

- quick capture: one line per question, `Enter` to keep going
- question bank: filter by company / category / mastery / due / keyword, sorted "can't answer first"
- review cards: `←` `→` navigate, space to flip; marking mastery reschedules (+1/+3/+7 days, then +3/+7/+14)
- stats: which categories you keep failing (denominator is **failed interviews**, not question count)
- export Markdown with optional desensitization
- community notes in `community/` (CC BY-SA 4.0) are imported **offline**

## Silence rule

```
lastActivityAt = max(statusChangedAt, max(note.touchedAt))
silenceDays    = today(00:00 local) − lastActivityAt, in calendar days
```

Thresholds scale by channel (referral ×3, careers page ×2); a per-company override becomes an
**absolute** threshold. Silence is only derived for applied / chatting / interviewing.
Any new timeline entry or status change refreshes `lastActivityAt` immediately — red disappears on its own.
Undo rolls back only that one status change — your later notes, interviews, and settings are untouched.

## Architecture & design constraints

Single-file, local-first is not laziness — it's a set of **verifiable constraints**, each guarded in CI:

| Constraint | Implementation | Regression guard |
| --- | --- | --- |
| Zero network requests | no fetch/XHR/beacon/WebSocket, no CDN | CI static scan, empty allowlist |
| One file, double-click | `vite-plugin-singlefile` + `base:'./'` | build check + bundle size red line |
| Data stays local | single-key localStorage, export via download | CI scan + review red line |
| Corruption never loses data | read failure locks persistence, raw copy saved to `failedAt.*` | 3 corruption scenarios × reload hard verification |
| Undo never swallows data | per-operation snapshots, pure-function revert | unit tests |
| Sync never cheats the timer | `touchedAt` = platform `lastContactAt` only | 31 sync-engine unit tests |
| Migrations idempotent & reversible | pure functions, additive-only, pre-snapshot | 11 migration tests + failure page |

Stack: **Vite 5 + React 18 + TypeScript 5.6 strict**. No router, no state library, no UI kit —
the state core lives in `App.tsx` (all writes via `mutate()` with undo snapshots), 26 view components,
one hand-written `styles.css` with CSS-variable design tokens.

Full architecture & merge-algorithm design: [`docs/ARCHITECTURE-v0.2.md`](docs/ARCHITECTURE-v0.2.md).

## Engineering quality

Current baseline (reproducible in CI):

| Metric | Value | Notes |
| --- | --- | --- |
| Unit tests | 201 (14 files), all green | pure-function layer: sync engine, migration, storage, redaction, review algorithm, silence & deadline rules, CSV/ICS export |
| Bundle size | 442,872 B (single HTML) | red line: 470KB warn / 540KB fail |
| Zero-network scan | pass, empty allowlist | every commit |
| Independent QA | 478 assertions, 0 failures | browser probes + interaction replay, see [`docs/QA-REPORT-v0.2.md`](docs/QA-REPORT-v0.2.md) |
| Reproducible build | clean `npm ci && npm run build` → identical sha256 | required before release |

CI runs six steps, all green or nothing ships: **typecheck → tests → zero-network scan → build →
bundle red line → community data validation**. Each step guards one product promise.

Honest tech-debt list (also tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md)):
no component/E2E tests; `App.tsx` is a 1,282-line state core with unstable context props (full-tree re-renders);
every write still serializes the whole DB (now stringified once instead of twice, but still O(DB) —
fine at 10 applications, white-screen territory at 300 + 1,000 questions);
the adapter strategy interface still takes `any`. All four are scheduled, not hidden.

## Shortcuts

`N` new · `1`–`5` views · `⌘K`/`Ctrl+K` search · `⌘Z`/`Ctrl+Z` undo · `Esc` close

## Development

```bash
cd app
npm install

npm run dev                # dev server
npm run typecheck          # tsc --noEmit
npm test                   # vitest
npm run build              # typecheck + single-file dist/index.html
npm run check:bundle       # >470KB warn / >540KB fail
npm run check:no-network   # static scan for network calls
npm run validate:community # community notes: schema, uniqueness, length, redaction

npm run verify             # all of the above
```

Release: walk through [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md)
(step 1 is replacing the `OWNER` placeholder — already done for this repo at `Rrrayy/job-desk`; swap in your own username if you fork).

## Layout

```
job-desk/
├── app/                      # the app
│   ├── dist/index.html       # build output: single file, double-click to run
│   ├── src/
│   │   ├── App.tsx           # state core (all writes via mutate(), undo snapshots)
│   │   ├── types.ts          # data model (schema v2)
│   │   ├── adapters/         # boss / shixiseng / nowcoder / custom (fixtures + tests)
│   │   ├── lib/
│   │   │   ├── rules.ts      # silence derivation, todos, funnel, scripts
│   │   │   ├── storage.ts    # localStorage I/O, import/export, validation, lock-on-failure
│   │   │   ├── migrate.ts    # v1 → v2 (pure, idempotent, additive)
│   │   │   ├── rollback.ts   # rollback points, 30-day cleanup
│   │   │   ├── interview.ts  # notes stats & spaced review
│   │   │   ├── sync/         # sync engine: normalize / statusMap / engine / capture
│   │   │   └── budget.ts     # size watermark & truncation
│   │   └── components/       # views + drawers + notes + sync panels
│   └── scripts/              # test runner & three check scripts
├── extension/                # optional MV3 extension (activeTab + scripting only)
├── community/                # community interview notes (CC BY-SA 4.0, offline import)
├── docs/
│   ├── PRD-v0.2.md  ARCHITECTURE-v0.2.md  QA-REPORT-v0.2.md  ROADMAP.md
│   └── adapters/README.md    # adapter protocol + 7-step guide + known limits
├── .github/                  # CI + Issue/PR templates + network allowlist
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
└── CHANGELOG.md  LICENSE  README.md
```

## Roadmap

> Full review, data-model draft, and acceptance criteria: [`docs/ROADMAP.md`](docs/ROADMAP.md)
> (joint product × architecture review).

**v0.3 — Foundation**

- [ ] **Season + two-level deadlines** (season-level + per-company override); Today sorted by deadline
- [ ] **Stage × outcome axes**: `stage(7) × outcome(5)` replaces the single `status` enum
- [ ] **Semantic rounds**: one/two/cross/HR panels modeled; "failed at round N" becomes a foreign key
- [ ] **Today battle plan**: daily application budget + mute switch
- [ ] **Time correctness**: all write paths refresh activity uniformly; full recompute on import
- [ ] **Performance floor**: write throttling + question-bank key split + perf baselines in CI + undo stack
- [ ] **Staging pre-check batching** (fixes the silent drop of oldest items past 200)

**v0.4 — Loops & attribution**

- [ ] **5 behavior-equivalence DoD checks** (todos / funnel / silence compared pre/post migration; holds veto power)
- [ ] Round → interview-notes closure (one click from a round to its notes, with context)
- [ ] Resume entities + two-level stats (aggregate by name, drill by version; no rates below n=5)
- [ ] Bulk operations + transactional undo; per-company view; JD snapshots; referral contacts
- [ ] Component tests (jsdom + Testing Library) + Playwright E2E against the `file://` artifact + migration fixture suite

**v1.0 — Decision support & long-term use**

- [ ] Weighted offer comparison (pay / location / growth / certainty)
- [ ] Archiving & season switching (archived records stay searchable)
- [ ] Attribution stats (which round kills most candidates) with three-tier coverage labeling
- [ ] Human-readable exports (CSV / Markdown report) + i18n + docs site
- [ ] Experienced-hire pack (negotiation / background check / stealth mode)

Non-goals in [Privacy and non-goals](#privacy-and-non-goals) — the roadmap never crosses that line.

## Known limitations

- **No trash bin** — deleting an application is immediate (confirmation dialog, but it's gone). Export backups.
- Clipboard may be blocked on `file://`; follow-up templates then expand in a text box instead.
- Sync is text parsing, not an API. Platform redesigns break it — it will say "nothing parsed", never silently drop.
- Virtual scrolling means `Ctrl+A` only captures rendered rows; "parsed N" < total is normal.
- Mobile is usable but desktop-first (drag & drop, keyboard shortcuts).
- The single-file build has a size cap: over 540KB fails CI — a deliberate constraint, not a bug.
- **Undo is one level deep**: `⌘Z` steps back once, not repeatedly (10-deep stack lands in v0.4).
- **Deadlines are application-level only**: there is no "whole hiring-season deadline" yet, so each
  application carries its own (v0.4 adds Season).
- **Autumn-hiring volume is optimized but unmeasured**: the algorithmic work is in (note index, single
  serialization per write), but there is no end-to-end timing baseline at 150+ applications yet.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). New platform adapter: start at
[`docs/adapters/README.md`](docs/adapters/README.md). Community notes: [`community/SCHEMA.md`](community/SCHEMA.md) —
**redaction is a hard line**. Changelog: [`CHANGELOG.md`](CHANGELOG.md). Security issues: **do not open a
public issue** — use the private channel in [`SECURITY.md`](SECURITY.md).

## License

- Code: MIT — see [`LICENSE`](LICENSE)
- Community notes (`community/`): CC BY-SA 4.0 — see [`community/LICENSE`](community/LICENSE)
