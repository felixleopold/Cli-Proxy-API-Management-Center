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
  all), the *Reserves* strip (see Usage reserves), the *pool cards* (see Quota forecast), *Accounts*,
  the *Quota windows* timeline, *Spend history*, then the device label editor collapsed. *Accounts*
  is a compact list, one row per credential: icon, the gateway's routing status as a static dot
  (`routing_status` on `/credentials`: target, available, flash, shield, reserve_hold, cooldown,
  exhausted, disabled, error; a hover card says why and until when; no field, no dot), the
  `nickname` (else the email; email and file name on hover), the multiplier chip (plan and share on
  hover), 5-hour and weekly bars as % left each with its own reset "Fri 16:00 · 1d 3h" underneath
  (readings from the forecast pools, else the loaded quota; "—" when nothing reports), "$X" in the
  window (≈ at 100% on hover; clicking it swaps that window into the spend history, with ‹ › and
  "Back to 7d"), a user split bar with per-person amounts on hover, the pace buttons, the enable
  toggle (`PATCH /credentials/status`), reset, refresh and ⚙. *Pace* (`components/PaceControl.tsx`):
  ⚡ flash routes to the account first, the shield protects it (used only when nothing else is
  eligible); each opens a menu (until the next 5-hour or weekly reset, resolved client-side from the
  row's resets and sent as `until`, 1h, 4h, a custom time) for `POST /usage/pace {name, mode:
  flash|shield, duration|until}`, `DELETE /usage/pace?name=` ends it; the listing's `pace_mode` /
  `pace_until` show it as a highlighted button with the time left (`accountControls.ts`). A row
  expands to two columns: the account (email, file, plan and share, lender, routing, spend by user)
  and every window (model-scoped ones too), manual resets and expiries, renewal and credits. ⚙ opens
  the name and usage settings (name, priority, weight, Claude plan, which sets the multiplier, the
  plan multiplier only for other providers or a Custom plan, usage cap, lender, 5-hour and weekly
  reserve, each with an ⓘ hover explanation), saved diff-only through `PATCH /credentials/fields`
  (`nickname` included); file management stays on Auth Files. A row pairs
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
  (fingerprint = first 12 hex of sha256 of the key). Series colors follow identity (each user takes
  the slot their name hashes to, so colours never move when people are added: Felix orange,
  Ferdinand violet; subscriptions by provider and name; `components/seriesSlots.module.scss`). Provider colours: Claude coral, Codex silver, Muse green.
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
  The reveal dialog also lists the config's `client-keys.gateway-urls` (read through
  `useConfigStore`, `Config.clientKeysGatewayUrls`) as "Use <url>" buttons under the gateway field,
  for example an HTTPS address, and shows the OpenAI-compatible base `<gateway url>/v1` with Copy,
  since OpenAI clients append `/models` themselves and 404 without `/v1`. Config saves are YAML
  diffs (`buildConfigPatch`), so the `client-keys` block, `gateway-urls` included, is only sent
  when edited in the YAML editor.
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
  busy/quiet pace) and the horizon, plus *For: Everyone ▾*, which switches the cards' big number to
  what `GET /usage/pool?user=` leaves that person after their reserve (with their 5-hour reserve
  override toggle); the charts stay pool-wide. Every control and stat explains itself on hover. Each
  card reads "11.1× of 15×" with Runs out ("After Nov 11" when it lasts past the chart), First
  account dry, Next reset (+restore at time) and Burn. Every reset is a dot on its step coloured by how much
  of the resetting accounts' share was used before the reset (≥ 90% green, ≥ 60% amber, else red),
  so a reset that gave back almost nothing still shows; its "+0.9×" pill takes the first free slot
  beside the dot (above, stacked higher, then below) clear of other pills and dots, and is left
  out only when none fits (`components/resetMarks.ts`); hovering one lists the accounts and their
  used % (`poolResetEvents`). Dragging across the past selects a stretch: a dotted line projects the
  pool from now at that stretch's average drain (spread evenly over the day, split over today's
  accounts as they drained then; `stretchActivity`), with its pace and run-out time under the chart;
  a click or Escape clears it. Tests:
  `tests/quotaForecast.test.ts`.
- **Capacity timeline and retirement** (gateway `GET /observability/capacity/history`,
  f-squared/CLIProxyAPI `feat/capacity-timeline`). The forecast loads the timeline over the same 14
  days as quota history (`src/services/api/capacityHistory.ts`, `hooks/useQuotaHistory.ts`). Each
  pool's history is drawn from `withCapacityTimeline`: every credential counts only while the
  timeline has it active (from its entry's time; inactive reads as zero, not a gap), including
  now-disabled or retired ones and ones without samples (capacity only), and a provider whose
  last credential was retired keeps its card (`withTimelineProviders`); each sample reads at the
  plan weight and share in effect when it was taken, so past samples never take today's weight.
  The capacity is a dashed step line (`poolCapacity`) and the y axis reaches its highest step;
  each step (`capacityChanges`, a first entry inside the range being an addition) is a hollow
  dot on that line, faint below 5% of the axis; larger ones also get a delta chip ("−10×") in
  the lane of the "Now" label, and chips that would touch merge into "2 changes"
  (`components/capacityMarks.ts`). Hovering lists every change near the pointer: who, what
  ("Ultra retired", "10× → 0×"), the gateway's reason and when. A change replaces the reset pill
  at that instant. *Past* (7d / 30d / All, beside *Next*) sets how far back the chart goes and
  how much quota and capacity history loads (`historyLookbackDays`); All starts at the earliest
  capacity entry (`historyStartMs`), so before the first quota sample only the capacity steps
  show, and views over three weeks label only resets of ≥ 8% of the pool. Projections and
  headline totals stay on today's active credentials.
  Without the endpoint (404, or 409 when history is off) everything stays as before. *Retire*
  (⚙ popover, file credentials only, confirmed) sends `PATCH /credentials/status {disabled: true,
  retired: true}`; a retired row shows "Retired · Nov 8" and its ⚙ offers *Reactivate*
  (`{disabled: false}`, as does the toggle). In *Spend history*, a retired credential with spend
  in the loaded ledger reads "Retired: <name>" and is sorted in with the active ones, so it keeps
  its colour. Tests: `tests/quotaForecast.test.ts` (capacity timeline), `tests/usageModel.test.ts`.
- **Private credentials** (gateway `private_user`, f-squared/CLIProxyAPI#40). A credential
  reserved for one usage-ledger user serves only their requests and records no usage. Auth
  Files shows a quiet "Private · Felix" badge on its card, and the credential sheet's *Private
  for* field sets or clears it (`PATCH /credentials/fields {private_user}`, empty clears).
  Usage & quota leaves private credentials out entirely: the page drops them from its credential
  list and their samples and capacity timeline entries from the history it shares
  (`src/features/quota/privateCredentials.ts`), so counts, tabs, pools, the forecast, accounts,
  spend, reserves and capacity never include them. Tests: `tests/privateCredentials.test.ts`.
- **Private usage page** (`/private-usage`, hidden: no nav entry, no link; reached only by URL;
  `src/features/quota/PrivateUsagePage.tsx`). Since Usage & quota leaves private credentials out,
  this page reads `GET /observability/quota/history/private` (`quotaHistoryApi.listPrivate`:
  samples plus the private credentials, so accounts without samples still show "No samples
  yet"; 409 says history is off) and draws each account's 5-hour session and weekly window as %
  left over time with the forecast's `RemainingChart` (readings held until the next sample,
  refilled at each passed reset, flat until the next reset), with current value, used, next reset,
  last sample and the Past / Next controls. Logic: `privateUsageModel.ts`; tests:
  `tests/privateUsage.test.ts` (also asserts nothing else in `src` links the route).
- **Taller charts** (`src/features/quota/tallCharts.ts`, `components/TallChartToggle.tsx`). The
  forecast cards (Remaining and Drain rate) and the Spend history chart each have a quiet
  fold/unfold icon that draws the chart twice as tall, with twice the y ticks, so dense steps,
  chips and resets separate. Each card toggles on its own; the last choice per kind (forecast,
  drain, spend) is remembered in localStorage (`usageQuota.tallCharts`, ignored when storage
  is unavailable). The Quota windows timeline has one bar per lane and no height to gain, so it
  has none. Tests: `tests/tallCharts.test.ts`.
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
  *Person view*: the pool cards' *For* picker reads `GET /usage/pool?provider=&user=` (left for the
  person, their reserve and override, `POST /usage/override {user, duration: 5h}` / `DELETE`); hidden
  on gateways without the endpoint. Logic: `usagePoolModel.ts`, `src/services/api/usagePool.ts`;
  tests: `tests/usageReserves.test.ts`.
  *Reserves strip* (gateway lender override, `components/ReservesStrip.tsx`): one chip per lender with
  a reserve near the top of `/usage-quota` ("commercial · 80% reserve · 2 accounts · Release…").
  Release opens a menu: optional "Keep at least X%", then until the next 5-hour or weekly reset (the
  soonest over the lender's accounts), 1h, 4h, 24h or a custom time, for `POST /usage/override
  {lender, duration|until, keep_percent?}`; while `lender_reserve_override_until` is in the future the
  chip reads "Released until 18:00 · keeps 50%" (`lender_reserve_override_keep_percent`) with End
  (`DELETE /usage/override?lender=`). The release covers every credential of that lender. Not on the
  credential sheet.
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
