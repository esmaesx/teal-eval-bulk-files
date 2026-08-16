# CLI and Codex skill guide

The CLI lets a terminal, Codex, Claude, or another local agent manage staged files without visual page navigation. It attaches only to an already open allowed issue tab.

![Fictional plan and apply output](images/cli-plan-example.png)

## Requirements

- Node.js 24
- Teal Eval Bulk Files `0.9.4` loaded unpacked in Chrome or Microsoft Edge
- An open Teal Alpha issue tab
- The selected browser's protected local debugging bridge enabled

The CLI does not launch a browser, open a tab, navigate, log in, or read cookies and passwords.

## Select a browser session

If the user names Chrome, Edge, a profile, a session, or the current browser, use that exact choice. Do not silently use another browser.

For Chrome, open `chrome://inspect/#remote-debugging`. For Edge, open `edge://inspect/#remote-debugging`. Enable remote debugging for the current session. The browser can ask the user to approve one local connection.

Inspect available sessions when no session was named:

```powershell
& .\skill\scripts\inspect-browser-sessions.ps1
```

Then ask which listed session to use. The CLI must find exactly one open tab for the requested issue.

After the user selects the session, use exactly one wrapper transport:

- `-PersistentBridgePath <absolute-path>` for a selected Chrome session with a configured compatible stdio proxy
- `-Browser chrome|edge` for direct current-session mode
- `-CdpEndpoint <loopback-URL>` for an explicit loopback CDP endpoint

The portable wrapper has no default persistent path. The presence of a proxy does not select a browser session.

## Read-only commands

For a user-selected session through a configured persistent bridge:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -PersistentBridgePath "<absolute-path-to-stdio-proxy.mjs>" `
  -Issue DEMO-204 -Command status
```

For direct current-session mode:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command status
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command list
```

`status` reports extension readiness and the active operation. `list` returns the sorted staged-file inventory.

An explicit loopback endpoint can be used instead of current-session mode:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -CdpEndpoint "http://127.0.0.1:9222" -Issue DEMO-204 -Command list
```

## Upload with a two-phase plan

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command plan-upload `
  -Operands "C:\work\new-evidence.csv","C:\work\notes.txt"
```

Show the returned actionable and skipped names. If the user requested that exact upload, apply the returned one-use token:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command apply-upload `
  -Operands "<one-use-token>"
```

The apply command uses the exact `File` objects from the plan, rechecks the staged inventory, consumes both authorization layers, and starts without a visual Confirm click.

## Download with a two-phase plan

Pass exact staged filenames. Do not pass an output path.

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command plan-download `
  -Operands "evidence.csv","notes.txt"
```

Show the returned actionable and skipped names. If the user requested that exact download, apply the returned one-use token:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command apply-download `
  -Operands "<one-use-token>"
```

Apply rechecks the exact issue, tab, URL, page title, page generation, connection mode, and staged inventory. It creates one verified ZIP and opens exactly one native Save As dialog. The user chooses the destination there. The CLI does not accept an arbitrary absolute output path, and it does not open the extension Confirm/Cancel dialog.

## Delete with a two-phase plan

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command plan-delete `
  -Operands "old-evidence.csv","old-notes.txt"
```

Show the exact actionable names. Apply only the matching user-requested plan:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command apply-delete `
  -Operands "<one-use-token>"
```

The five-second stop delay starts when apply begins.

## Stop

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command stop
```

Use `stop` immediately when the user asks. Do not create another plan first.

## Result fields

Every command writes one JSON object to stdout. Apply results report these arrays separately:

- `succeeded`: completed names
- `skipped`: duplicates, missing names, or other safe skips
- `failed`: names that reported an operation failure
- `remaining`: names not started or not completed

Download results also return:

- `archiveFilename`: the generated ZIP filename
- `downloadId`: the identifier returned for the ZIP download

Exit codes are:

- `0`: completed without a reported failure or cancellation
- `2`: usage or argument failure
- `3`: persistent-bridge, browser-session, or debugging connection failure
- `4`: operation, plan, inventory, cancellation, or extension failure

## Failure recovery

Do not retry an uncertain `apply-upload`, `apply-download`, or `apply-delete`. Plan tokens are consumed before the operation call. A timeout, closed transport, `indeterminate: true`, or missing final JSON makes the result uncertain.

1. Run `status`.
2. Run `list`.
3. Compare the current staged inventory with the requested operation.
4. For an uncertain download, do not infer whether Save As completed from the staged inventory.
5. Report succeeded, skipped, failed, remaining, and any uncertainty.
6. Create a new plan only with fresh user authority.

Never print browser WebSocket paths, extension authorization IDs, cookies, or unrelated tab URLs.
