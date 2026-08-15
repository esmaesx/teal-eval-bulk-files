# CLI and Codex skill guide

The CLI lets a terminal, Codex, Claude, or another local agent manage staged files without visual page navigation. It attaches only to an already open allowed issue tab.

![Fictional plan and apply output](images/cli-plan-example.png)

## Requirements

- Node.js 24
- The unpacked extension loaded in Chrome or Microsoft Edge
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

## Read-only commands

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue ABC-123 -Command status
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue ABC-123 -Command list
```

`status` reports extension readiness and the active operation. `list` returns the sorted staged-file inventory.

An explicit loopback endpoint can be used instead of current-session mode:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -CdpEndpoint "http://127.0.0.1:9222" -Issue ABC-123 -Command list
```

## Upload with a two-phase plan

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue ABC-123 -Command plan-upload `
  -Paths "C:\work\new-evidence.csv","C:\work\notes.txt"
```

Show the returned actionable and skipped names. If the user requested that exact upload, apply the returned one-use token:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue ABC-123 -Command apply-upload `
  -PlanToken "<one-use-token>"
```

The apply command uses the exact `File` objects from the plan, rechecks the staged inventory, consumes both authorization layers, and starts without a visual Confirm click.

## Delete with a two-phase plan

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue ABC-123 -Command plan-delete `
  -Names "old-evidence.csv","old-notes.txt"
```

Show the exact actionable names. Apply only the matching user-requested plan:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue ABC-123 -Command apply-delete `
  -PlanToken "<one-use-token>"
```

The five-second stop delay starts when apply begins.

## Stop

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue ABC-123 -Command stop
```

Use `stop` immediately when the user asks. Do not create another plan first.

## Result fields

Every command writes one JSON object to stdout. Mutation results report these arrays separately:

- `succeeded`: completed names
- `skipped`: duplicates, missing names, or other safe skips
- `failed`: names that reported an operation failure
- `remaining`: names not started or not completed

Exit codes are:

- `0`: completed without a reported failure or cancellation
- `2`: usage or argument failure
- `3`: browser-session or debugging connection failure
- `4`: operation, plan, inventory, cancellation, or extension failure

## Failure recovery

Do not retry an uncertain apply. Plan tokens are consumed before the mutation call.

1. Run `status`.
2. Run `list`.
3. Compare the current staged inventory with the requested operation.
4. Report succeeded, skipped, failed, and remaining names.
5. Create a new plan only if the user still wants the remaining action.

Never print browser WebSocket paths, extension authorization IDs, cookies, or unrelated tab URLs.
