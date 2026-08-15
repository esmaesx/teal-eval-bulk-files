---
name: teal-eval-bulk-cli
description: Manage staged files on Tacit Teal eval issue pages through the local Teal Eval Bulk Files CLI. Use when a user asks Codex to inspect, bulk upload, bulk delete, or stop staged-file work through an open Microsoft Edge, Google Chrome, Brave, or Chromium browser session; names a browser, profile, logged-in session, issue ID, or current Teal tab; or asks an LLM to use the Teal bulk-file extension without visual page navigation.
---

# Teal Eval Bulk CLI

Use the version 0.9.2 CLI in the repository's `extension` directory. The wrapper resolves it from, in order:

1. the explicit `-ExtensionRoot` value;
2. `TEAL_EVAL_BULK_EXTENSION_ROOT`;
3. the repository's sibling `extension` directory.

Read [references/cli-contract.md](references/cli-contract.md) before the first mutation in a conversation or when browser selection, CDP setup, or result handling is unclear.

## Select the browser session

1. Extract any explicit browser, browser-session, profile, CDP endpoint, tab, URL, or issue-ID directive from the user's request.
2. Respect an explicit directive. Do not silently substitute another browser, profile, session, or issue.
3. If the user did not select a session, run:

   ```powershell
   & "<skill-root>\scripts\inspect-browser-sessions.ps1"
   ```

4. Show the open sessions with browser name, attach mode, profile root when known, remote-debugging setup URL, and Teal issue targets when the endpoint can list them. Ask the user which browser/session to use. Do not choose for the user.
5. `BrowserSession` means the open Chrome or Edge session has a protected `DevToolsActivePort` record. Use `-Browser chrome` or `-Browser edge`. The browser can show one local debugging permission prompt. The user must approve that prompt; it is separate from upload or delete confirmation.
6. `RemoteDebuggingDisabled` means the browser is open but has not enabled its protected local debugging bridge. Ask the user to open the returned `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging` URL, enable remote debugging, and tell you when it is ready. Do not navigate to or change that browser setting for the user.
7. If discovery returns no open supported session, ask: "Which browser and browser profile should I use?" Offer to use an open browser after the user enables its protected local bridge, an already CDP-enabled session, or a separate debug profile. Start or restart a browser only after explicit authority.
8. If the user supplied a CDP endpoint, inspect only that endpoint:

   ```powershell
   & "<skill-root>\scripts\inspect-browser-sessions.ps1" -CdpEndpoint "http://127.0.0.1:9222"
   ```

9. Do not restart, close, relaunch, or copy a logged-in profile without explicit user authority.
10. Treat "this browser," "current browser," or "current tab" as an explicit session directive. Match the current issue URL and browser family to one discovered session. If an exact match cannot be proved, ask rather than guess.

## Verify before action

1. Require an exact issue ID such as `ABC-123` from the user, current-tab context, or one selected discovered target.
2. Run `status`, then `list`, against the selected session and issue. Stop if the returned issue ID, target, extension bridge, or inventory does not match.
3. Report that uploads cause Teal to post one Linear comment for each finalized file.
4. Confirm that upload source paths exist and are loose files. Do not accept directories.
5. For deletion, show the exact requested names from the current inventory.

Use the wrapper for every command. For an explicit endpoint:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -CdpEndpoint "http://127.0.0.1:9222" `
  -Issue "ABC-123" `
  -Command list
```

For a selected current browser session:

```powershell
& "<skill-root>\scripts\invoke-teal-cli.ps1" `
  -Browser chrome `
  -Issue "ABC-123" `
  -Command list
```

## Use two-phase mutations

For upload:

1. Run `plan-upload` with exact absolute file paths.
2. Show `actionableNames` and `skipped` to the user.
3. Run `apply-upload` with the returned token only when the user already requested that upload.
4. Do not open browser control and do not wait for an extension dialog. A valid `apply-upload` token starts the approved actionable plan without a visual confirmation.

For deletion:

1. Run `plan-delete` with exact staged filenames.
2. Show `actionableNames` and `skipped` to the user.
3. Run `apply-delete` with the returned token only when the user already requested that deletion.
4. Do not open browser control and do not wait for an extension dialog. A valid `apply-delete` token starts the approved actionable plan without a visual confirmation. The five-second stop window starts when apply begins.

Use `stop` immediately when the user asks to stop an active batch. Do not wait for a new confirmation.

## Handle results safely

- Parse the single stdout JSON object. Treat stderr as diagnostics and preserve the exit code.
- Report `succeeded`, `skipped`, `failed`, and `remaining` separately.
- Treat exit code 2 as usage failure, 3 as session/CDP failure, and 4 as operation failure.
- Never retry `apply-upload` or `apply-delete` after an uncertain result. Tokens are consumed before the mutation call. Run `status` and `list`, explain the observed state, then create a new plan only with user authority.
- Do not navigate, open, close, restart, or log into a browser unless the user explicitly requests that separate action.
- The user's exact upload or deletion request and the matching one-use plan are the authority for `apply-*`. Do not ask for another approval and do not use browser automation for a confirmation dialog.
- Do not expose cookies, tokens, authorization headers, profile secrets, private browser WebSocket paths, or unrelated tab URLs.
- Do not use a real Teal issue for testing. Use only the repository's fictional local demo issue in a dedicated temporary profile when a test is explicitly requested.
