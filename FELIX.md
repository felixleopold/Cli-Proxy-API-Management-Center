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
  and one provider filter, in span order: *Current quota windows* (the pooled forecast plus one card
  per subscription showing spend in that credential's current window, labelled "This window · start –
  end" with its reset), *Spend history* (the 24h/7d/30d/90d control lives in its header and only drives
  the KPIs, chart and users table; clicking a card swaps in that window, with ‹ › and "Back to 7d"),
  then the upstream per-credential quota cards and the device label editor. Shell:
  `src/features/quota/UsageQuotaPage.tsx`; usage half: `src/features/usage/UsageSections.tsx`.
  API-equivalent USD per user across all providers comes from the fork-only gateway ledger
  (`/observability/usage/ledger`, `/observability/usage/clients` GET/PUT; needs
  `usage-ledger.enabled: true`, otherwise an empty state says so). Buckets carry the serving
  credential (`auth_id`): `''` is shared-pool usage from before credential tracking and
  `imported-own-account` is imported personal-account usage from before the gateway; both count in
  totals only. Each credential's window is `[reset − period, reset]` from its passive `quota.signals`
  on `/credentials` (Claude unified 7d/5h, Codex primary/secondary), or, without live signals (e.g.
  after a gateway restart), from its newest quota-history sample; stale resets roll forward by whole
  periods. Cards without either say they show the history range. The ledger refetches when the
  selection needs an earlier start or the clock passes the hour the snapshot ends in. Cards also show
  used %, spend by user and ≈ spend at 100% from ≥ 5% used; the chart stacks by user or subscription
  with reset markers; the table drills user → device → model; the label editor maps key → device/user
  (fingerprint = first 12 hex of sha256 of the key). Series colors follow identity (users
  alphabetically, subscriptions by provider and name; `components/seriesSlots.module.scss`).
  Logic: `usageModel.ts`; tests: `tests/usageModel.test.ts`.
- **Quota forecast** (`src/features/quota/quotaForecastModel.ts`, `components/QuotaForecast*`).
  Per-provider pool chart of remaining quota with a projection to the next resets, drain history
  and a horizon picker. The projection is sleep-aware: each credential's daily rate is its own
  trailing-7-day drain or its last-24h drain, whichever is higher (below 24h, the drain so far
  over its activity-weighted time; below 3h, the window pace), spread over a local hour-of-day
  profile learned from drain and blended into a configurable sleep baseline. Unused Codex manual resets show as amber expiry markers and a count,
  but the projection never assumes one is redeemed. Tests: `tests/quotaForecast.test.ts`.

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
