# CLI contract and browser-session rules

## Portable paths

- Extension root: explicit `-ExtensionRoot`, `TEAL_EVAL_BULK_EXTENSION_ROOT`, or the repository's sibling `extension` directory
- CLI: `extension/teal-eval-bulk-cli.mjs`
- Extension README: `README.md`
- Node.js requirement: version 24

## Browser contract

The CLI attaches only to an already open issue target. It accepts either an explicit loopback Chrome DevTools Protocol endpoint or a user-selected current Chrome or Edge session with a valid protected `DevToolsActivePort` record. It does not launch browsers, choose profiles, open tabs, or navigate.

Treat local CDP access as a trusted local mutation authority. The one-use local token and extension authorization ID prevent stale, mismatched, or repeated applies within the CLI workflow. They are not a defense against a hostile local process that already controls the same CDP session, because that process can create and apply its own plan.

Explicit loopback endpoints support Microsoft Edge, Google Chrome, Brave, and Chromium. Current-session mode supports Google Chrome and Microsoft Edge. The user must enable remote debugging at the browser's `inspect/#remote-debugging` page and approve the local connection. A signed-in tab or extension permission alone is not a CLI transport.

When the user names a logged-in profile or session:

1. Inspect running processes without reading browser credential stores.
2. Match the browser executable, user-data directory, profile directory, CDP endpoint, and exact Teal issue target when available.
3. Use the session only after the match is exact.
4. Prefer current-session `-Browser chrome` or `-Browser edge` mode when its `DevToolsActivePort` record is valid.
5. If remote debugging is disabled, ask the user to enable it in the named browser. Do not change that security setting for the user.
6. If the session still has no supported transport, do not close or restart it without explicit authority.

When no session is named, always ask after read-only discovery. Do not select the only result automatically.

## Commands

All commands require `--issue` plus exactly one connection choice: `--cdp` or `--browser chrome|edge`. `--user-data-dir` is optional only with `--browser`.

- `status`: Return extension readiness and active operation.
- `list`: Return the sorted staged-file inventory.
- `plan-upload <absolute paths...>`: Put file handles in the extension input, classify duplicates, and return a one-use token.
- `apply-upload <token>`: Recheck inventory, consume the one-use plan token, and start the approved upload without a visual confirmation.
- `plan-delete <filenames...>`: Classify exact staged names, missing names, and ambiguous rows; return a one-use token.
- `apply-delete <token>`: Recheck inventory, consume the one-use plan token, and start the approved deletion without a visual confirmation.
- `stop`: Request stop after the current upload or during/between deletions.

The plan token expires after five minutes by default. It is bound to the issue, target tab, operation, requested names, and exact staged inventory. The extension also issues a short-lived, one-use authorization ID that the CLI stores only inside the local token record. `apply-*` consumes both layers before mutation. Do not reuse them.

## Output

Each invocation writes one JSON object to stdout. Diagnostics use stderr.

- Exit 0: command completed without reported failure or cancellation.
- Exit 2: invalid command or arguments.
- Exit 3: CDP or browser-session connection failure.
- Exit 4: operation, token, inventory, cancellation, or extension failure.

Mutation results can be partial. Always inspect:

- `succeeded`
- `skipped`
- `failed`
- `remaining`

Duplicate upload names and already staged names are skipped. Missing delete names are skipped. Inventory drift invalidates the plan before mutation.

## Approval boundary

The human extension interface still opens its closed-shadow Confirm/Cancel dialog. The CLI path does not open that dialog. For the CLI, the user's exact request plus the matching one-use local token and extension authorization ID is the approval boundary. `apply-upload` or `apply-delete` rechecks the issue, target tab, requested names, exact planned file objects or rows, and exact staged inventory before it consumes both layers and starts the batch. Do not ask for a second confirmation and do not use browser automation to click a confirmation control.

## Current-session connection

For an already open Chrome session:

```text
node teal-eval-bulk-cli.mjs --browser chrome --issue ABC-123 status
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
