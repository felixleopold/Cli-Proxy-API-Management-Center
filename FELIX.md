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
