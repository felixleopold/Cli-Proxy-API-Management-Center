# Felix fork

Felix's maintained fork of the CLIProxyAPI management console (CPAMC), served by the CLIProxyAPI
gateway on luitpoldserver. Upstream: <https://github.com/router-for-me/Cli-Proxy-API-Management-Center>.
`felix/main` is the default branch: an upstream release tag plus the patches below.

## Patches

Current base: upstream `v1.25.6`.

- **Claude timeline lanes anchor on the account window** (`src/features/quota/quotaTimelineModel.ts`).
  The Codex standard-window preference now covers Claude: Weekly mode anchors on `seven-day` and
  5-hour mode on `five-hour`, rather than a model-scoped window such as "7-day Fable 5" that
  resets sooner. Falls back to `pickLaneWindow` when the general window is missing. Model-scoped
  windows stay in the lane chips. Tests: `tests/quotaTimeline.test.ts`.
- **Percentages read as remaining.** The new `quota_management.percent_left` key ("75% left",
  in all locales) is used by credential-card percentages (Claude, Codex, Kimi, Devin, xAI monthly
  and pay-as-you-go), timeline window labels and tooltips, and lane chips. xAI's weekly row keeps
  upstream's "Used N%" because its per-product breakdown sums to that total.
- **Timeline legend explains the fill.** The current window's fill deliberately shows *used*
  quota, so its edge can be compared with the now line (past it means usage is ahead of pace),
  while the label shows remaining. A legend entry (`quota_management.windows_legend_used`) says so.
- **Usage & quota page** (`/usage-quota`, OBSERVE; `/usage` and `/quota` redirect there). Near-black,
  one provider filter, in order: header (counts, the Claude credit switch as an inline toggle, Refresh
  all), the *pool cards* (see Quota forecast), the gateway's reserve pool as a collapsed disclosure
  (`components/UsagePool.tsx`), *Accounts*, the *Quota windows* timeline, *Spend history*, then the
  device label editor collapsed. *Accounts* is a compact list, one row per credential: icon, email
  (file name on hover), plan and multiplier chip, 5-hour and weekly bars as % left (readings from the
  forecast pools, else the loaded quota; "—" when nothing reports), the reset as "Fri 16:00 · 1d 3h",
  "$X ≈ $Y at 100%" (clicking it swaps that window into the spend history, with ‹ › and "Back to 7d"),
  a user split bar, the enable toggle (`PATCH /credentials/status`), reset, refresh and ⚙. A row
  expands to every window (model-scoped ones too), manual resets and expiries, renewal and credits, the
  plan share, the lender with its reserve release, and spend by user. ⚙ opens usage settings only
  (priority, weight, Claude plan, plan multiplier, usage cap, lender, 5-hour and weekly reserve),
  saved diff-only through `PATCH /credentials/fields`; file management stays on Auth Files. A row pairs
  with its spend by auth id (`file.id`, else the file name), the ledger's `auth_id`; credentials
  without quota support get a spend-only row after the quota rows, on the last page
  (`src/features/quota/accountCards.ts`, `accountSettings.ts`; components `AccountsList.tsx`,
  `AccountRow.tsx`, `QuotaAccountRow.tsx`, `AccountSettingsPopover.tsx`; tests:
  `tests/accountCards.test.ts`, `tests/accountRows.test.ts`). The expanded rows reuse the provider
  quota bodies with `compact`; the Auth Files cards render them unchanged. Relative times count the
  last 48 hours in hours (`src/utils/quota/relativeTime.ts`). Shell:
  `src/features/quota/UsageQuotaPage.tsx`; usage half: `src/features/usage/UsageSections.tsx`.
  API-equivalent USD per user across all providers comes from the fork-only gateway ledger
  (`/observability/usage/ledger`, `/observability/usage/clients` GET/PUT; needs
  `usage-ledger.enabled: true`, otherwise an empty state says so). Buckets carry the serving
  credential (`auth_id`): `''` is shared-pool usage from before credential tracking and
  `imported-own-account` is imported personal-account usage from before the gateway; both count in
  totals only. Each credential's window is `[reset − period, reset]` from its passive `quota.signals`
  on `/credentials` (Claude unified 7d/5h, Codex primary/secondary, Muse weekly/window), or,
  without live signals (e.g. after a gateway restart), from its newest quota-history sample; stale
  resets roll forward by whole periods. Cards without either say they show the history range. The
  ledger refetches when the selection needs an earlier start or the clock passes the hour the
  snapshot ends in. Rows show
  spend by user and ≈ spend at 100% from ≥ 5% used; the chart stacks by user or subscription
  with reset markers; the table drills user → device → model; the label editor maps key → device/user
  (fingerprint = first 12 hex of sha256 of the key). Series colors follow identity (users
  alphabetically, so Felix sky and Ferdinand violet; subscriptions by provider and name;
  `components/seriesSlots.module.scss`). Provider colours: Claude coral, Codex silver, Muse green.
  Logic: `usageModel.ts`; tests: `tests/usageModel.test.ts`.
- **Claude API credit switch** (`src/features/quota/components/ClaudeCreditCard.tsx`, an inline
  toggle in the `/usage-quota` header). Reads and flips the fork-only gateway switch
  `/claude-credit-fallback` (GET/PUT `{enabled}`; `src/services/api/claudeCreditFallback.ts`) that
  lets Claude requests fall back to the paid Anthropic API key once subscriptions are exhausted.
  Turning it on asks for confirmation and lasts the gateway's `duration_seconds` (2 h), after which
  the gateway turns it off; turning it off is immediate. The card shows the turn-off time with a
  once-a-minute countdown and refetches every minute and on tab focus
  (`hooks/useClaudeCreditFallback.ts`), so the automatic turn-off shows up. Gateways without the
  switch (404) or without an API key (`configured: false`) render nothing. Pushover alerts for an
  exhausted subscription link here. Logic: `claudeCreditModel.ts`; tests:
  `tests/claudeCreditFallback.test.ts`.
- **Client keys page** (`/client-keys`, GATEWAY; `src/features/clientKeys/`). Per-app gateway keys
  from the fork-only `/client-keys` routes (`src/services/api/clientKeys.ts`): an overview of this
  month's spend against budgets, keys near (≥ 80%) or over budget and keys with unpriced usage; the
  keys grouped by project (or flat) with search, a project filter and optional columns, both kept in
  localStorage (`viewPrefs.ts`); create/edit with a model allowlist (`*` only as a trailing prefix
  glob), monthly budget, credential pin and expiry; rotate, disable and revoke. Create and rotate
  show the secret once with an `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` snippet whose gateway URL is
  editable and remembered (`clientKeysPage.gatewayUrl`), since the panel's address may not reach the
  model port. A key's sheet charts its usage by day (`/client-keys/:id/usage`) with the Usage page's
  chart and lists it by model. Agent tokens (`/client-key-managers`) are listed, created (shown once)
  and revoked there too. A 409 means `client-keys.enabled` (or, for spend, `usage-ledger.enabled`)
  is off, and the page says so. Logic: `clientKeysModel.ts`; tests: `tests/clientKeysModel.test.ts`.
- **Quota forecast** (`src/features/quota/quotaForecastModel.ts`, `components/QuotaForecast*`).
  Per-provider pool chart of remaining quota in plan multipliers (each credential contributes what
  is left of its share, refilling to its effective multiplier at reset; the pool is ΣE; values read
  "1.4× / 3.4× ours · 41% left", tooltips add the % of our multiplier) with a projection to the next
  resets, drain history (× per hour/day for one pool, % of each pool when comparing) and a horizon
  picker (rationing counts from 85% of each credential's cap, and ledger cost calibrates in
  base-plan percent, so unequal plans pace correctly), for Claude, Codex and Muse (`meta`), each shown only once one of its
  credentials reports quota. The projection is sleep-aware: each credential's daily rate is its own
  trailing-7-day drain or its last-24h drain, whichever is higher (below 24h, the drain so far
  over its activity-weighted time; below 3h, the window pace), spread over a local hour-of-day
  profile learned from drain and blended into a configurable sleep baseline. Unused Codex manual resets show as amber expiry markers and a count,
  but the projection never assumes one is redeemed. Shown as one card per provider (Muse collapsed by
  default, remembered in `quotaForecastPrefs.ts`) under a shared bar: Remaining | Drain rate, burn
  rate over the last 1h/3h/6h, Future usage (*Usual pattern* = the model above with its likely range;
  *Same as now* = each credential's selected burn rate, waking hours only; *Busier*/*Quieter* = the
  busy/quiet pace) and the horizon. Each card reads "11.1× of 15×" with Pool empty, First account
  empty, Next reset (+restore at time) and Burn. Tests: `tests/quotaForecast.test.ts`.
- **Usage reserves** (gateway `usage-reserves`, f-squared/CLIProxyAPI#29). Three surfaces:
  *Credential sheet* (`src/features/authFiles/components/AuthFileReserveFields.tsx`), on Claude, Codex,
  Muse (`meta`) and Devin credentials (`AUTH_FILE_USAGE_CAP_PROVIDERS`): Claude plan (`plan`: pro,
  max, ultra; weights 5-hour/weekly 1/1, 5/5, 20/10), `lender`, and the lender reserves
  `reserve_five_hour_percent` / `reserve_weekly_percent` (0-100). The gateway stops routing to a
  credential once a window's usage reaches 100 − the reserve held now; over the release lead before
  the reset that reserve tapers linearly down to the floor (f-squared/CLIProxyAPI#31). The legacy "Usage cap" `usage_cap_percent` (1-99) still works and stands
  for a reserve of 100 − cap in both windows; an explicit reserve wins for its window (gateway
  `LenderReservePercent`). `plan_multiplier` stays the price-based size in base $20 plans (Max $200 =
  10) and is the pool weight only without a known Claude plan. All saved with `PATCH
  /credentials/fields` by `hooks/useAuthFilesPrefixProxyEditor.ts`; parsing in `constants.ts`; tests:
  `tests/authFileWeight.test.ts`.
  *Config › Quota › Usage reserves* (`src/features/config/visualConfigUsageReserves.ts`,
  `components/sections/SectionUsageReserves.tsx`): people with a reserve % (names suggested from the
  usage-ledger client user labels, `/observability/usage/clients`), quiet hours, time zone, and per
  window the taper length (`release-lead`) and the lender floor (`floor-percent`, 0-100); empty fields
  are removed so the gateway defaults apply (23:00-07:00, Europe/Vienna, 1h/12h, 5%/2%).
  *Pooled usage* on `/usage-quota` (`src/features/quota/components/UsagePool.tsx`, a collapsed disclosure below the pool cards):
  per provider and window from `GET /usage/pool?provider=&user=`: pool size, left, left for the chosen
  person, burn, forecast, refills and each account's reserve (kept, tapering as "reserve 20% → 8%
  now" from `reserve_now_percent`, or reached), plus the
  person's override (`POST /usage/override` for 5h, `DELETE` to end) with its expiry. Hidden on
  gateways without the endpoint. Logic: `usagePoolModel.ts`, `src/services/api/usagePool.ts`; tests:
  `tests/usageReserves.test.ts`.
  *Release reserve* (gateway lender override): a credential with a lender and a reserve shows a compact
  1h / 4h / 24h control in its expanded Usage & quota row (`components/LenderReserveRelease.tsx`), with the lender
  on the plan line. It calls `POST /usage/override {lender, duration}` and `DELETE /usage/override?lender=`;
  while `lender_reserve_override_until` on `/credentials` is in the future the card reads "Reserve released
  until HH:MM" with Clear. The release covers every credential of that lender. Not on the credential sheet.
- **Plan multipliers** (`src/features/quota/planMultipliers.ts`).
  Usage reads in base-plan units, per window. A credential's multiplier m for a window is the gateway's
  plan weight (`plan_weight_five_hour` / `plan_weight_weekly`, or the older single `plan_weight`,
  normalized in `src/services/api/authFiles.ts`), else its `plan_multiplier`, else 1 ("not set"); so a
  Claude Ultra counts 20× in the 5-hour figures and 10× in the weekly ones. Our share c of that window
  is 100 − its lender reserve (else the usage cap, else 100). Our effective multiplier is E = m·c/100,
  and with u% of a window used R = m·max(0, c − u)/100. The Usage & quota page shows
  each row's multiplier chip, the expanded row's "1× plan · 75% ours = 0.75×" share, and the pool
  cards in ×. Readings come from the same pools as the forecast (live signals, else latest
  history, else the loaded quota card, for a credential the gateway has not routed to yet). Tests:
  `tests/planMultipliers.test.ts`, `tests/quotaForecast.test.ts`.

## Sync from upstream

```sh
git fetch upstream --tags
git rebase --onto vX.Y.Z vOLD felix/main   # vOLD = current base tag above
bun install --frozen-lockfile
bun run verify                             # tests, lint, build
git push --force-with-lease origin felix/main
```

Drop any patch that upstream now covers, and update the base tag in this file.

## Build

The repo pins Bun (see `AGENTS.md`). Build as upstream's release workflow does:

```sh
bun install --frozen-lockfile
VERSION=vX.Y.Z-felix.N bun run build
mv dist/index.html dist/management.html
```

`dist/management.html` is the whole console in a single file.

## Deploy

On luitpoldserver, panels live in `/srv/nas_share/cliproxy-gateway/panels/<version>/`, and the
gateway serves `/srv/nas_share/cliproxy-gateway/static/management.html`, a symlink to the active
panel. `config.yaml` disables panel auto-update, so the gateway never overwrites it.

```sh
v=vX.Y.Z-felix.N
ssh luitpoldserver "mountpoint -q /srv/nas_share && mkdir -p /srv/nas_share/cliproxy-gateway/panels/$v"
scp dist/management.html luitpoldserver:/srv/nas_share/cliproxy-gateway/panels/$v/management.html
ssh luitpoldserver "ln -sfn ../panels/$v/management.html /srv/nas_share/cliproxy-gateway/static/management.html"
```

Check that the symlink target matches the existing link's form (relative or absolute) before you
repoint it. To roll back, repoint it to the previous panel directory, such as `panels/v1.25.6`.
