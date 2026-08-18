# Changelog

## 0.9.8 - 2026-08-17

- Require `chrome-devtools-persistent-gateway` 0.1.3 and keep exact MCP identity checks before browser dispatch.
- Keep the default cooperative lease wait at 120 seconds while bridge 0.1.3 releases authenticated idle owners without an idle-owner delay.
- Verify that `plan-upload`, `apply-upload`, and `list` send the 120000 ms default to every persistent proxy session.
- Keep proved pre-dispatch lease failures at exit code `3`, with no fill, confirmation, replay, or indeterminate result.
- Report `tokenConsumed: true` when a proved lease failure occurs after an apply claims its one-use token. The token stays consumed and the CLI does not replay the apply.
- Tell agents to use the persistent PowerShell wrapper and not start direct `chrome-devtools-mcp` or Claude `--chrome` sessions for Teal file work.
- Keep the existing visual interface unchanged.

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
