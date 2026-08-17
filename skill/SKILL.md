---
name: teal-eval-bulk-cli
description: Manage and verify staged files on Tacit Teal eval issue pages through the local Teal Eval Bulk Files CLI. Use when a user asks Codex to inspect, verify, bulk upload, bulk download, bulk delete, or stop staged-file work through an open Microsoft Edge, Google Chrome, Brave, or Chromium browser session; names a browser, profile, logged-in session, issue ID, or current Teal tab; or asks an LLM to use the Teal bulk-file extension without visual page navigation.
---

# Teal Eval Bulk CLI

Use the version 0.9.7 CLI in the repository's `extension` directory. Persistent mode requires Chrome DevTools MCP persistent bridge 0.1.2. The wrapper resolves the CLI from, in order:

1. the explicit `-ExtensionRoot` value;
2. `TEAL_EVAL_BULK_EXTENSION_ROOT`;
3. the repository's sibling `extension` directory.

Read [references/cli-contract.md](references/cli-contract.md) before the first non-read-only operation in a conversation or when browser selection, CDP setup, or result handling is unclear.

## Start with a batch

Use one plan for all files in the requested batch. The wrapper accepts `-Files`, `-Paths`, and `-Names` as clear aliases for `-Operands`. It accepts `-PlanToken` for an apply token.

```powershell
$plan = & "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue "DEMO-204" -Command plan-upload `
  -Files "C:\work\evidence.csv","C:\work\notes.txt" | ConvertFrom-Json

$plan.actionableFiles

& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue "DEMO-204" -Command apply-upload `
  -PlanToken $plan.token

$after = & "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue "DEMO-204" -Command list | ConvertFrom-Json
```

Treat `actionableFiles` as the approved manifest. After apply, run `list`. For each manifest item, require one and only one staged row with the same complete filename and SHA-256 value. Report a missing, changed, or repeated row as a failure. Use `verify` only when the local paths are the complete intended replacement set for all staged files. Do not use exact-set `verify` for a partial upload batch.

## Select the browser session

1. Extract any explicit browser, browser-session, profile, CDP endpoint, tab, URL, or issue-ID directive from the user's request.
2. Respect an explicit directive. Do not silently substitute another browser, profile, session, or issue.
3. If the user did not select a session, run:

   ```powershell
   & "<skill-root>\scripts\inspect-browser-sessions.ps1"
   ```

4. Show the open sessions with browser name, attach mode, profile root when known, remote-debugging setup URL, and Teal issue targets when the endpoint can list them. Ask the user which browser/session to use. Do not choose for the user.
5. If the user selects a Chrome session that has a configured persistent bridge, prefer that bridge and pass its absolute stdio-proxy path with `-PersistentBridgePath`. Use persistent mode for work with several commands. Its cooperative lease wait defaults to 120 seconds. Pass `-BridgeWaitSeconds` only when the task needs a different integer from 1 through 300. The portable wrapper has no machine-specific path default. Bridge availability does not select the session. Direct mode can show a local browser permission prompt.
6. `BrowserSession` means the open Chrome or Edge session has a protected `DevToolsActivePort` record. Use `-Browser chrome` or `-Browser edge`. The browser can show one local debugging permission prompt. The user must approve that prompt; it is separate from CLI plan authority and the download Save As dialog.
7. `RemoteDebuggingDisabled` means the browser is open but has not enabled its protected local debugging bridge. Ask the user to open the returned `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging` URL, enable remote debugging, and tell you when it is ready. Do not navigate to or change that browser setting for the user.
8. If discovery returns no open supported session, ask: "Which browser and browser profile should I use?" Offer to use an open browser after the user enables its protected local bridge, an already CDP-enabled session, or a separate debug profile. Start or restart a browser only after explicit authority.
9. If the user supplied a CDP endpoint, inspect only that endpoint:

   ```powershell
   & "<skill-root>\scripts\inspect-browser-sessions.ps1" -CdpEndpoint "http://127.0.0.1:9222"
   ```

10. Do not restart, close, relaunch, or copy a logged-in profile without explicit user authority.
11. Treat "this browser," "current browser," or "current tab" as an explicit session directive. Match the current issue URL and browser family to one discovered session. If an exact match cannot be proved, ask rather than guess.
12. If more than one allowed tab matches the issue, do not choose one. Show only the listed safe target IDs and titles. Ask for one ID. Pass it as `-TargetId`. Never show unrelated tab URLs.

## Verify before action

1. Require an exact issue ID such as `DEMO-204` from the user, current-tab context, or one selected discovered target.
2. Run `status`, then `list`, against the selected session and issue. Stop if the returned issue ID, target, extension bridge, or inventory does not match.
3. Treat a missing or loading staged-files panel as an observation failure. `list`, all plans, and `verify` require a present ready panel. A present ready panel with no rows is a valid empty inventory. Each plan uses one strict refreshed observation for row selection and inventory.
4. Report that uploads cause Teal to post one Linear comment for each finalized file.
5. Confirm that upload source paths exist and are loose files. Do not accept directories.
6. For download or deletion, show the exact requested names from the current inventory.
7. If the persistent daemon is not ready, use the `runtime` folder that contains the selected `stdio-proxy.mjs`. Run `status.ps1`. `backend_connected: true` does not prove that the browser lease is free. Run `start-daemon.ps1` only when status confirms `daemon_absent` and local authority permits the start. Do not kill a process by count or age. Check its exact owner and liveness first.

Use the wrapper for every command. Pass exactly one transport parameter: `-PersistentBridgePath`, `-CdpEndpoint`, or `-Browser`.

For a user-selected session through an explicit persistent bridge:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -PersistentBridgePath "<absolute-path-to-stdio-proxy.mjs>" `
  -BridgeWaitSeconds 120 `
  -Issue "DEMO-204" `
  -Command list
```

For an explicit endpoint:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -CdpEndpoint "http://127.0.0.1:9222" `
  -Issue "DEMO-204" `
  -Command list
```

For a selected current browser session:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser chrome `
  -Issue "DEMO-204" `
  -Command list
```

## Use two-phase operations

For upload:

1. Run `plan-upload` with exact absolute safe regular file paths.
2. The plan is read-only. It streams local name, size, and SHA-256 values, lists staged inventory, classifies repeated and already staged names, and writes a local version-2 one-use token. It transfers no file handle and sends no extension upload plan.
3. Show `actionableNames`, `actionableFiles`, and `skipped` to the user. Keep `actionableFiles` as the filename and SHA-256 manifest for the post-apply `list` check.
4. Run `apply-upload` with the returned token only when the user already requested that upload.
5. Apply rechecks the exact issue, target, page, inventory, and local name, size, and SHA-256 values. It copies and verifies the approved bytes in a private snapshot, then claims and consumes the token atomically before one transfer. Chrome receives only the verified snapshot. A concurrent process cannot use the same token. After each ready-panel wait, the extension checks the exact filename again. If that filename became staged, it records a proved skip and sends no upload for that file.
6. Do not open browser control and do not wait for an extension dialog. The human interface keeps its Confirm/Cancel controls. A valid CLI token starts the approved actionable plan without a visual confirmation.
7. Run `list` after apply. Require one exact filename and SHA-256 match for each `actionableFiles` item. A proved stop with non-empty `remaining` exits `4`. An apply error after direct dispatch without a proved terminal result is `indeterminate` and must not be replayed.

For download:

1. Run `plan-download` with exact staged filenames. Do not pass an output path.
2. Show `actionableNames` and `skipped` to the user.
3. Run `apply-download` with the returned token only when the user already requested that exact download.
4. Let apply recheck the exact issue, tab, URL, title, page generation, connection mode, and inventory. It creates one verified ZIP and opens exactly one native Save As dialog. It does not open the extension Confirm/Cancel dialog.
5. Let the user choose the destination in Save As. The CLI does not accept an arbitrary absolute output path.

For deletion:

1. Before a fresh delete plan, offer and recommend a separate exact-name `plan-download` and `apply-download` backup.
2. If the backup is cancelled or uncertain, do not delete unless the user explicitly declines that backup.
3. Run `plan-delete` with exact staged filenames.
4. Show `actionableNames`, `actionableFiles`, and `skipped` to the user. Each `actionableFiles` item has filename, SHA-256, and size.
5. Run `apply-delete` with the returned token only when the user already requested that deletion.
6. Do not open browser control and do not wait for an extension dialog. A valid `apply-delete` token starts the approved actionable plan without a visual confirmation. The five-second stop window starts when apply begins.
7. Never click the page's native **remove** control. For an ambiguous duplicate row, ask the human operator to use the native control.

For read-only exact-set verification:

1. Run `verify` with absolute local file paths only when those files are the complete intended replacement set for the staged inventory.
2. Report `matched`, `mismatched`, `missingRemotely`, and `missingLocally`.
3. Exit `4` means that the exact local and staged sets do not match.

Use `stop` immediately when the user asks to stop an active batch. Do not wait for a new confirmation.

## Handle results safely

- Parse the single stdout JSON object. Treat stderr as diagnostics and preserve the exit code.
- Read `exitCode` and `exitMeaning` from every JSON object. They match the process exit code.
- Report `succeeded`, `skipped`, `failed`, and `remaining` separately.
- For download, also report `archiveFilename` and `downloadId`.
- Treat exit code 2 as usage failure, 3 as persistent-bridge, session, or CDP failure, and 4 as operation failure.
- Read `errorKind`. Only `daemon_absent` permits daemon start advice. A cooperative queue timeout is `lease_busy` with `dispatched: false`, exits `3`, and does not permit confirmation or resend. For `lease_busy`, preserve an authenticated owner PID. Keep `held_unknown` unknown. Do not expose owner command lines, tokens, or page data. For `lease_busy`, `daemon_timeout`, `proxy_lifecycle`, `rpc_error`, or `generic_bridge_error`, run read-only status checks and inspect the exact owner and process state. Do not kill or restart a process by count or age.
- Never retry `apply-upload`, `apply-download`, or `apply-delete` after an uncertain result. For upload, an error after transfer without a proved terminal result is `indeterminate`. A direct apply error after dispatch without a proved terminal result is also `indeterminate`. Run `status` and `list`, review `uploadedBeforeFailure` with the operator, explain only observed state, then create a new plan only with user authority.
- The private upload snapshot uses an owner-only per-user root and strict non-reparse containment. Construction, transfer, and browser activity have separate bounded deadlines. The extension upload batch ends after two hours. Browser-active bytes remain for 150 minutes. A proved terminal result removes them. On uncertainty, cleanup removes only an exact expired snapshot. An active or ambiguous directory stays unchanged. A cleanup warning does not permit a retry.
- For delete, require a present non-loading staged-files panel for both observations. A present empty panel is valid. A missing or loading panel before mutation causes zero delete dispatch. Report `inventoryBefore`, `inventoryAfter`, and the `inventory` alias. If `inventoryObservationError` is present after mutation, the token is consumed and the result is indeterminate. Run read-only `list`, report the terminal arrays, and do not replay the apply.
- Do not navigate, open, close, restart, or log into a browser unless the user explicitly requests that separate action.
- The user's exact upload, download, or deletion request and the matching one-use plan are the authority for `apply-*`. Do not ask for another approval. A CLI download still opens one native Save As dialog; it does not use the extension confirmation dialog.
- Do not expose cookies, tokens, authorization headers, profile secrets, private browser WebSocket paths, or unrelated tab URLs.
- Do not use a real Teal issue for testing. Use only the repository's fictional local demo issue in a dedicated temporary profile when a test is explicitly requested.

The current human interface already shows SHA-256 prefixes in delete review and per-file progress during batch work. Version 0.9.7 does not change the visual interface.
