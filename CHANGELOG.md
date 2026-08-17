# Changelog

## 0.9.7 - 2026-08-17

- Add bounded cooperative lease waiting so several CLI agents can share one persistent Chrome bridge.
- Require `chrome-devtools-persistent-gateway` 0.1.2 and validate its MCP identity before browser dispatch.
- Wait only before the first `list_pages` dispatch. Keep `select_page` and the target tool in the same proxy session and lease.
- Keep queue timeout as `lease_busy` with `dispatched: false`, exit code `3`, and no automatic confirmation or tool resend.
- Preserve one-use apply tokens, exact issue, target, page, inventory, and authorization binding, and all no-replay rules.
- Keep the existing visual interface unchanged.

## 0.9.6

- Added upload token schema v2, private verified upload snapshots, strict snapshot lifetimes, and safer post-transfer failure reporting.
- Preserved exact download and delete bindings, one-use apply behavior, and indeterminate no-replay handling.
