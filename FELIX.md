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
- **Usage & quota page** (`/usage-quota`, OBSERVE; `/usage` and `/quota` redirect there). One page
  and one provider filter, in order: *Accounts* (per-provider plan multiplier totals above the cards,
  then one card per credential merging upstream's quota card with its spend: email title with the file
  name on hover, provider, plan and plan multiplier badge, "resets in …" chip, the weekly headline in
  multipliers ("0.25× of 0.75× left this week"), the limit bars as % left of that account, then "$X this window ≈ $Y at 100%" with the user split, then renewal, credit
  balance and manual reset expiries behind a "N manual resets ›" disclosure, then Reset / Refresh),
  *Current quota windows* (the pooled forecast and the window timeline), *Spend history* (the
  24h/7d/30d/90d control lives in its header and only drives the KPIs, chart and users table; clicking
  a card's spend swaps in that window, with ‹ › and "Back to 7d"), then the device label editor. A
  quota card pairs with its spend by auth id (`file.id`, else the file name), the ledger's `auth_id`;
  credentials without quota support get a spend-only card after the quota cards, on the last page
  (`src/features/quota/accountCards.ts`, tests: `tests/accountCards.test.ts`). The Codex, Claude and
  Antigravity bodies take `compact` there (plan in the header, details in the disclosure); the Auth
  Files cards render them unchanged. Shell: `src/features/quota/UsageQuotaPage.tsx`; card:
  `components/QuotaCard.tsx`; usage half: `src/features/usage/UsageSections.tsx`.
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
  snapshot ends in. Cards show
  spend by user and ≈ spend at 100% from ≥ 5% used; the chart stacks by user or subscription
  with reset markers; the table drills user → device → model; the label editor maps key → device/user
  (fingerprint = first 12 hex of sha256 of the key). Series colors follow identity (users
  alphabetically, subscriptions by provider and name; `components/seriesSlots.module.scss`).
  Logic: `usageModel.ts`; tests: `tests/usageModel.test.ts`.
- **Claude API credit switch** (`src/features/quota/components/ClaudeCreditCard.tsx`, top of
  `/usage-quota`, above the provider tabs). Reads and flips the fork-only gateway switch
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
  picker, for Claude, Codex and Muse (`meta`), each shown only once one of its
  credentials reports quota. The projection is sleep-aware: each credential's daily rate is its own
  trailing-7-day drain or its last-24h drain, whichever is higher (below 24h, the drain so far
  over its activity-weighted time; below 3h, the window pace), spread over a local hour-of-day
  profile learned from drain and blended into a configurable sleep baseline. Unused Codex manual resets show as amber expiry markers and a count,
  but the projection never assumes one is redeemed. Tests: `tests/quotaForecast.test.ts`.
- **Usage cap per credential** (`src/features/authFiles/`, the credential's details sheet).
  A "Usage cap" field (1-99 %, empty for no cap) on Claude, Codex, Muse (`meta`) and Devin credentials
  (`AUTH_FILE_USAGE_CAP_PROVIDERS`, the providers whose windows the gateway observes) edits the fork-only
  gateway field `usage_cap_percent`; the gateway stops picking the credential once any credential-wide
  window's usage (5-hour, daily or weekly) reaches the cap, until that window resets. Logic: `constants.ts` (`parseUsageCapPercentText`), saved by
  `hooks/useAuthFilesPrefixProxyEditor.ts`; tests: `tests/authFileWeight.test.ts`. The cap is also our
  share of the account in plan multiplier reporting.
- **Plan multipliers** (`src/features/quota/planMultipliers.ts`, `components/PlanMultipliers.tsx`).
  Usage reads in units of the base $20 plan. Each credential's `plan_multiplier` m (Max $200 = 10,
  Pro/Plus = 1; missing = 1, shown "not set") and `usage_cap_percent` c (missing = 100) come from
  `/credentials` (normalized in `src/services/api/authFiles.ts` to `planMultiplier`/`usageCapPercent`).
  Our effective multiplier is E = m·c/100, and with u% of a window used R = m·max(0, c − u)/100; the
  same m applies to every window. The Usage & quota page shows per-provider totals (Σm plans, ΣE ours,
  ΣR left of the weekly window with ΣR/ΣE, and the 5-hour figure when every account reports one),
  each card's "1× plan · 75% ours = 0.75×" badge and weekly headline, and the forecast pool in ×.
  Readings come from the same pools as the forecast (live signals, else latest history). The
  credential details sheet edits `plan_multiplier` (positive, up to 100, empty = null) via
  `PATCH /credentials/fields` on the usage-cap providers (`constants.ts`
  `parsePlanMultiplierText`). Tests: `tests/planMultipliers.test.ts`, `tests/quotaForecast.test.ts`.

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
