# CLI contract and browser-session rules

## Portable paths

- Extension root: explicit `-ExtensionRoot`, `TEAL_EVAL_BULK_EXTENSION_ROOT`, or the repository's sibling `extension` directory
- CLI: `extension/teal-eval-bulk-cli.mjs`
- Persistent-bridge client module: `extension/persistent-mcp-client.mjs`
- Extension README: `README.md`
- Required extension version: `0.9.6`
- Node.js requirement: version 24

## Batch pattern

Use one plan for the complete requested batch. The wrapper aliases are `-Files`, `-Paths`, and `-Names` for operands, and `-PlanToken` for one apply token.

```powershell
$plan = & "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue DEMO-204 -Command plan-upload `
  -Paths "C:\work\evidence.csv","C:\work\notes.txt" | ConvertFrom-Json

& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue DEMO-204 -Command apply-upload `
  -PlanToken $plan.token

$after = & "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser edge -Issue DEMO-204 -Command list | ConvertFrom-Json
```

Keep the plan's `actionableFiles` as the approved manifest. After apply, require exactly one row in `list` for each complete manifest filename and SHA-256 value. Use `verify` only when the local paths are the complete intended replacement set for all staged files.

## Browser contract

The CLI attaches only to an already open issue target. It accepts exactly one transport: an explicit persistent Chrome stdio-proxy path, an explicit loopback Chrome DevTools Protocol endpoint, or a user-selected current Chrome or Edge session with a valid protected `DevToolsActivePort` record. It does not launch browsers, choose profiles, open tabs, or navigate.

Treat local persistent-bridge or CDP access as a trusted local mutation authority. The one-use local token and extension authorization ID prevent stale, mismatched, or repeated applies within the CLI workflow. They are not a defense against a hostile local process that already controls the same browser session, because that process can create and apply its own plan.

Persistent-bridge mode uses the optional [Chrome DevTools MCP persistent bridge](https://github.com/esmaesx/chrome-devtools-mcp-persistent-bridge), which is in a separate repository. Keep its checkout separate from the extension repository. This mode requires an explicit absolute path to the compatible `runtime/stdio-proxy.mjs` file and has no repository default. Use it for work with several commands. Explicit loopback endpoints support Microsoft Edge, Google Chrome, Brave, and Chromium. Current-session mode supports Google Chrome and Microsoft Edge. Direct current-session and CDP use can show a local browser permission prompt. The user must enable remote debugging at the browser's `inspect/#remote-debugging` page and approve the local connection. A signed-in tab or extension permission alone is not a CLI transport.

If more than one allowed issue tab matches, the CLI reports only a count and safe matching target IDs and titles. It never selects one by itself. Pass `--target-id <listed-id>` or wrapper `-TargetId <listed-id>` to select one exact allowed target. Tokens remain bound to that target.

The selected `stdio-proxy.mjs` file is in the `runtime` folder. Run `status.ps1` first. `backend_connected: true` does not prove that the browser lease is free. Run `start-daemon.ps1` only when status confirms `daemon_absent` and local authority permits the start. For a busy or unknown lease, check the exact owner and liveness. Do not kill or restart a process by count or age. The CLI does not start a daemon and does not retry a failed command automatically.

When the user names a logged-in profile or session:

1. Inspect running processes without reading browser credential stores.
2. Match the browser executable, user-data directory, profile directory, CDP endpoint, and exact Teal issue target when available.
3. Use the session only after the match is exact.
4. If the selected Chrome session has a configured persistent bridge, prefer explicit `-PersistentBridgePath`. Otherwise, prefer current-session `-Browser chrome` or `-Browser edge` mode when its `DevToolsActivePort` record is valid.
5. If remote debugging is disabled, ask the user to enable it in the named browser. Do not change that security setting for the user.
6. If the session still has no supported transport, do not close or restart it without explicit authority.

When no session is named, always ask after read-only discovery. Do not select the only result automatically.

## Commands

All commands require `--issue` plus exactly one connection choice: `--persistent-bridge <absolute-stdio-proxy-path>`, `--cdp`, or `--browser chrome|edge`. `--user-data-dir` is optional only with `--browser`. `--target-id` is optional and is a safe bounded target ID. The portable PowerShell wrapper maps these to mandatory `-PersistentBridgePath`, `-CdpEndpoint`, and `-Browser` parameter sets, plus optional `-TargetId`. Its operand aliases are `-Names`, `-Files`, `-Paths`, and `-PlanToken`. It has no persistent-bridge default.

- `status`: Return extension readiness and active operation.
- `list`: Require a present staged-files panel that is not loading, then return the sorted inventory. A present ready empty panel is valid. A missing or loading panel is an observation failure.
- `plan-upload <absolute paths...>`: Read-only. Validate absolute safe regular paths, stream each local size and SHA-256 value, list staged inventory, classify repeated and already staged names, and write a version-2 one-use local token. It transfers no file handle and does not ask the extension for upload authorization.
- `apply-upload <token>`: Recheck the exact issue, target, page, inventory, and local name, size, and SHA-256 values. Copy and verify the authorized bytes in a private per-apply snapshot. Claim and consume the token atomically before one transfer. Transfer only the snapshot, then get extension authorization and apply the upload without a visual confirmation. After each ready-panel wait, check the exact filename again. If it became staged, return a proved skip and send no native upload. Remove the snapshot on a proved terminal result. Retain it for bounded cleanup when browser work is uncertain.
- `plan-download <filenames...>`: Classify exact staged names, missing names, and ambiguous rows; return a one-use token. It does not accept an output path.
- `apply-download <token>`: Recheck the plan context and inventory, create one verified ZIP, and open exactly one native Save As dialog. It does not accept an output path or open the extension confirmation dialog.
- `plan-delete <filenames...>`: Classify exact staged names, missing names, and ambiguous rows; return a one-use token.
- `apply-delete <token>`: Require a present staged-files panel that is not loading. A present empty panel is a valid empty inventory. Recheck inventory, consume the one-use plan token, and start the approved deletion without a visual confirmation. A missing or loading panel before delete causes zero delete dispatch. Return `inventoryBefore`, `inventoryAfter`, and an `inventory` alias for `inventoryAfter`. If the post-operation observation fails, both after fields are null, the terminal arrays remain, the result is indeterminate, and `inventoryObservationError` requires a read-only `list`. Do not replay the apply.
- `verify <absolute paths...>`: Read-only. Use only for a complete intended replacement set. Compare exact local filenames and SHA-256 values with all staged inventory. Return `matched`, `mismatched`, `missingRemotely`, and `missingLocally`. A difference exits `4`.
- `stop`: Request stop after the current upload or during/between deletions.

The plan token expires after five minutes by default. It is bound to the exact issue, target tab, URL, page title, page-document generation, connection mode, operation, requested names, and staged inventory. Upload tokens use schema version 2 and also store actionable local absolute path, filename, size, and SHA-256 evidence. Upload authorization is created after the transfer check. Every state-file read-modify-write uses an exclusive local lock and atomic same-volume replacement. Every apply claims its token under that lock before transfer or dispatch. Parallel plan creation saves every successful token or fails closed. Do not remove an invalid or stale lock without strict owner, liveness, and time proof. Do not reuse tokens or authorization IDs.

All plan inventories use one strict refreshed staged-panel observation for both selected rows and inventory. `list`, all plans, and `verify` fail when the panel is missing or loading. The snapshot store uses a private per-user root with an owner-only Windows DACL or POSIX mode. It rejects reparse points and checks exact containment, metadata, nonce, and deadlines. Its bounded states are `building`, `transferring`, and `browser_active`. Transfer leases renew around every file-selection call. The store enters browser-active state before authorization. The content batch deadline is two hours, and browser-active retention is 150 minutes. A proved terminal result removes the snapshot. A bounded cleaner and startup scavenger remove only an exact expired snapshot. Active or ambiguous directories stay unchanged. A cleanup warning does not make an uncertain apply retryable.

Download output is always the generated ZIP selected through the native Save As dialog. There is no command, option, or operand for an arbitrary absolute output path.

## Output

Each invocation writes one JSON object to stdout. Diagnostics use stderr. Every JSON object includes `exitCode` and `exitMeaning`. They match the process exit code.

- Exit 0: command completed without reported failure or cancellation.
- Exit 2: invalid command or arguments.
- Exit 3: persistent-bridge, CDP, or browser-session connection failure.
- Exit 4: operation, token, inventory, cancellation, or extension failure.

Operation results can be partial. Always inspect:

- `succeeded`
- `skipped`
- `failed`
- `remaining`

Duplicate upload names and already staged names are skipped. Missing download or delete names are skipped. Inventory drift invalidates the plan before the operation.

Download results also return `archiveFilename` and `downloadId`. Report both with the four result arrays. Delete and download plan results return `actionableFiles`. Each record has filename, SHA-256, and size.

Bridge failures have one stable `errorKind`: `daemon_absent`, `lease_busy`, `daemon_timeout`, `proxy_lifecycle`, `rpc_error`, `no_matching_tab`, or `generic_bridge_error`. An unknown JSON-RPC `-32603` is `rpc_error`. The CLI recognizes an absent daemon from the real proxy's exact bounded startup-failure record. Malformed or ambiguous startup output is `proxy_lifecycle`. Only `daemon_absent` permits daemon start advice. For `lease_busy`, preserve an authenticated `owner_pid` in the safe JSON and message. Keep `held_unknown` unknown. Never expose owner command lines, tokens, or page data. A no-tab failure means that the browser transport responded, the required allowed issue tab is not open, and no mutation started. It exits `3`.

Any upload error after file transfer without a proved terminal result is `indeterminate`. It includes `uploadedBeforeFailure` from exact observed filename and SHA-256 matches. A proved stopped upload with non-empty `remaining` is an operation failure and exits `4`; it is indeterminate only when the result says its state is uncertain. In direct CDP mode, any apply error after `Runtime.callFunctionOn` dispatch without a proved terminal result is indeterminate. Do not retry an apply after a timeout, closed transport, `indeterminate: true`, or any other uncertain result. Run `status` and `list`, review `uploadedBeforeFailure` with the operator, report only observed state, and create a new plan only with fresh user authority.

## Approval boundary

The human extension interface keeps its own closed-shadow confirmation controls. The CLI path does not open or click them. For the CLI, the user's exact request plus the matching one-use local token and extension authorization ID is the approval boundary. Each `apply-*` command rechecks the exact issue, target tab, URL, page title, page-document generation, connection mode, requested names, and staged inventory before it starts. `apply-upload` consumes its local token before transfer. `apply-download` then creates one verified ZIP and opens exactly one native Save As dialog for the destination. Do not ask for a second approval or add an absolute output-path option.

Before a fresh delete plan, the default skill workflow offers and recommends a separate exact-name `plan-download` and `apply-download` backup. A cancelled or uncertain backup blocks delete unless the user explicitly declines that backup. This does not remove the human Confirm/Cancel controls for human-interface batches.

Never click the page's native **remove** control. If duplicate rows are ambiguous, ask the human operator to use that native control. The current interface already shows SHA-256 prefixes in delete review and per-file progress. Version 0.9.6 has no visual interface change.

## Connection examples

For a user-selected Chrome session with a configured persistent bridge:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -PersistentBridgePath "<absolute-path-to-stdio-proxy.mjs>" `
  -Issue DEMO-204 `
  -Command status
```

The path must name the compatible stdio proxy. `extension/persistent-mcp-client.mjs` is the CLI's internal client module, not the proxy path. Do not select persistent mode only because a proxy exists.

For an already open Chrome session:

```text
node teal-eval-bulk-cli.mjs --browser chrome --issue DEMO-204 status
```

For Edge, use `--browser edge`. The CLI reads only the small `DevToolsActivePort` record from the selected browser data root. It does not read cookies, credentials, history, or profile databases. It lists browser targets internally only to select the exact allowed issue URL. It does not print unrelated target URLs or the private browser WebSocket path.

The browser can show one local debugging access prompt. The user must approve it. A timeout is a connection failure and never authorizes a retry or browser restart.

## Safe browser launch pattern

Only use a launch command after the user selects the browser/profile and authorizes launch. Prefer a separate user-data directory so the session is clear and reversible.

Microsoft Edge example:

```powershell
Start-Process -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList @("--remote-debugging-port=9222", "--user-data-dir=C:\path\selected-debug-profile") `
  -WindowStyle Hidden
```

Do not add a target URL, load a profile, install the extension, or log in unless the user authorized that action. The user can load the unpacked extension in the chosen profile through `edge://extensions` or `chrome://extensions`.
