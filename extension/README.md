# Teal Eval Bulk Files

This local Chrome extension adds a **Bulk files** button beside **Add file** on Teal Alpha eval issue pages.

It supports:

- multi-select upload of loose files;
- drag-and-drop upload of multiple loose files;
- sequential upload through the page's existing file control;
- a selectable staged-file list;
- verified bulk download as one ZIP with one Edge Save As dialog;
- an in-extension Confirm/Cancel review for each upload or delete batch;
- stop-after-current-file behavior;
- duplicate-filename skipping, while new filenames continue;
- a stable-ready wait between sequential uploads;
- failed-batch recovery that keeps unstarted files selected;
- stale-row and hash checks before deletion;
- native-list loading and re-render waits between sequential deletions.

The dialog uses the Teal eval page's dark theme variables for its background, text, borders, accent, warning, danger, and success colors. Upload, download, and delete modes use one fixed-size shell. The mode tabs do not move, and both staged-file lists have the same size and position as the upload drop target. The upload target fills the complete middle area. Selected upload names appear inside that target instead of in a second box.

## Important upload behavior

The Teal platform posts one Linear comment when it finalizes each staged file. The human interface shows this warning and requires an explicit confirmation before it begins an upload batch.

The extension does not upload, delete, or post anything by itself. For a batch started in the human interface, its closed-shadow in-extension alert dialog shows the exact selected names. Only a trusted click on **Confirm** starts that human-interface batch. The CLI does not script this button. It uses its separate one-use plan-token path.

## Install in Chrome or Microsoft Edge

1. Extract the ZIP file if you received the extension as a ZIP.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Select the `teal-eval-bulk-files-extension` folder.
6. Reload an open Teal Alpha issue page.

The page must match this address pattern:

`https://platform-teal-alpha.vercel.app/issue/*`

## Update an existing unpacked installation

The files in this folder are updated in place. Open `edge://extensions`, select **Reload** on **Teal Eval Bulk Files**, and then refresh the Teal eval page.

## Use

1. Open a Teal Alpha eval issue page.
2. Find **Staged files**.
3. Select **Bulk files**.
4. Use **Upload loose files**, **Download staged files**, or **Delete staged files**.

For uploads, drag loose files onto the drop zone or use **Choose files**. Folders are rejected.

For uploads, files whose names are already staged are marked and skipped. Other selected files continue. If the selection contains the same new filename more than once, the extension uploads the first copy and skips the later copies.

After each successful upload, the extension waits until the new staged row, the **Add file** button, and the native file input remain ready together. This prevents the next file from starting while Teal is still finishing the prior file. If Teal still reports an error, the extension stops safely and keeps the failed and unstarted files selected for a manual retry.

For downloads, select the staged files and choose **Download selected files as ZIP**. The extension verifies each selected file against the current Teal staged-file API, including Teal's `byte_size` field, reads the selected files, and builds one uncompressed ZIP locally in the browser. Edge then opens exactly one **Save As** dialog for the ZIP. Four selected files produce one ZIP and one dialog.

If you cancel the Save As dialog, a file cannot be read, or the ZIP cannot be built, no archive is saved and all selected rows remain selected for retry. The success message appears after Edge reports that the ZIP download is complete.

The ZIP keeps each original filename. If two selected rows have the same filename, select only one of them so extraction cannot overwrite one file with the other.

If the page shows two rows with the same filename and SHA-256 value, the extension marks them as duplicate rows and excludes them from bulk download and bulk deletion. An agent must never click the page's native **remove** control. Ask the human operator to use that control for an ambiguous row.

For deletions, the final confirmation shows the exact filename and the first eight characters of its SHA-256 value. After confirmation, a five-second countdown starts before the first deletion. Choose **Stop deletion** during the countdown to delete nothing and keep the full selection. Choose it after deletion starts to finish only the current file and keep all later files selected. The extension also stops if the page changes before it can delete the exact next row.

The current interface already shows SHA-256 prefixes in delete review and per-file progress during upload, download, and delete work. Version 0.9.7 has no visual interface change.

## Local CLI (optional)

`teal-eval-bulk-cli.mjs` is a dependency-free Node 24 tool for an already open browser. Version 0.9.7 supports planned upload, download, deletion, and read-only verification through an optional persistent MCP transport. It requires Chrome DevTools MCP persistent bridge 0.1.2. Keep the bridge checkout separate from this repository. The transport uses the reviewed stdio proxy and the existing long-running Chrome backend. It does not read the daemon token or connect to the daemon pipe. It does not launch a browser, open a tab, navigate a page, read cookies, or read credential stores.

```text
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 status
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 list
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 plan-upload C:\work\evidence.csv C:\work\notes.txt
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 apply-upload <one-use-plan-token>
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 plan-download report.pdf results.csv
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 apply-download <one-use-plan-token>
node teal-eval-bulk-cli.mjs --persistent-bridge <path-to-stdio-proxy.mjs> --issue DEMO-204 verify C:\work\report.pdf
```

The public PowerShell wrapper requires the persistent proxy path for each persistent-mode call:

```powershell
& "<path-to-invoke-teal-cli.ps1>" `
  -PersistentBridgePath "<absolute-path-to-stdio-proxy.mjs>" `
  -BridgeWaitSeconds 120 `
  -Issue DEMO-204 `
  -Command status
```

Persistent mode opens a short stdio proxy session for each browser action. Each session lists the pages, selects the exact issue tab, performs one action, and closes. The shared daemon and Chrome backend stay open. `-BridgeWaitSeconds` or `--bridge-wait-seconds` accepts a canonical integer from 1 through 300 and defaults to 120 seconds. It is persistent-only. The client gives only the first `list_pages` call the queue wait plus its normal 45-second timeout. `select_page` and the target tool stay in that session under one lease. A failed persistent call never falls back to direct CDP. Direct current-browser and explicit CDP mode can show a local browser permission prompt.

If more than one allowed issue tab matches, the CLI reports only safe target IDs and titles. It never selects one by itself. Pass `--target-id <listed-id>` to select one exact allowed tab. The PowerShell wrapper uses `-TargetId <listed-id>`.

`list`, all plans, and `verify` require a present staged-files panel that is not loading. A present ready panel with no rows is a valid empty inventory. A missing or loading panel is an observation failure. Each plan selects rows and records inventory from one strict refreshed observation.

`plan-upload` is read-only. It validates absolute regular paths, streams local size and SHA-256 values, lists staged inventory, classifies repeated and already staged names, and writes a version-2 one-use token. It transfers no file handle and sends no extension upload plan. `apply-upload` rechecks the issue, target, page, inventory, and local name, size, and SHA-256 values. It copies the approved bytes to a private snapshot and verifies the snapshot. It then claims and consumes the local token atomically before one transfer. Chrome receives only the verified snapshot. After each ready-panel wait, the extension checks the exact filename again. It records a proved skip and sends no native upload when that filename became staged. It then requests extension authorization and applies the upload.

The snapshot store uses a private per-user root with an owner-only Windows DACL or POSIX mode. It verifies exact root containment, metadata, nonce, deadlines, and no reparse point. A bounded `building` deadline covers construction. A renewed `transferring` lease covers each file-selection call. The store enters `browser_active` before authorization and retains bytes for 150 minutes. The content upload batch has a two-hour total deadline. A proved terminal result removes the snapshot. On uncertainty, a bounded cleaner and a strict startup scavenger remove only exact expired snapshots. They leave active or ambiguous directories unchanged. A cleanup failure adds a warning and does not permit a retry.

Keep the plan's `actionableFiles` as the approved manifest. After apply, run `list`. Require exactly one staged row with the same complete filename and SHA-256 value for each manifest item. Use `verify` only when the local paths are the complete intended replacement set for all staged files.

An error after that transfer without a proved terminal result is `indeterminate`. The CLI does not retry. A proved stopped upload with non-empty `remaining` exits `4`. Run `status` and `list`, then review `uploadedBeforeFailure` with the operator. `verify <absolute paths...>` is read-only and returns `matched`, `mismatched`, `missingRemotely`, and `missingLocally`. A difference returns exit `4`.

Every CLI JSON object has `exitCode` and `exitMeaning`. Delete and download plans include `actionableFiles` records with filename, SHA-256, and size. The human interface keeps its Confirm/Cancel controls. The CLI path does not click them.

For a persistent transport failure, use the `runtime` folder that contains `stdio-proxy.mjs` and run `status.ps1` first. `backend_connected: true` does not prove that the browser lease is free. Run `start-daemon.ps1` only when status confirms `daemon_absent` and local authority permits the start. The CLI accepts the real proxy's exact bounded startup record for this status. Ambiguous child output is `proxy_lifecycle`. A queue timeout before Chrome dispatch is `lease_busy` with `dispatched: false`, exits `3`, and does not cause confirmation or a resend. For `lease_busy`, preserve an authenticated owner PID. Keep `held_unknown` unknown. Never expose command lines, tokens, or page data. Check the exact owner and liveness. Do not kill or restart a process by count or age. Do not retry an uncertain apply.

Direct current-browser and explicit CDP modes remain available for compatibility. They are not the default and can create another Chrome permission request. For direct current-browser mode, use:

```text
node teal-eval-bulk-cli.mjs --browser chrome --issue DEMO-204 status
node teal-eval-bulk-cli.mjs --browser edge --issue DEMO-204 list
```

Current-session mode reads only the selected browser data root's small `DevToolsActivePort` record. It uses the private loopback WebSocket path without printing it. It lists targets internally only to find exactly one allowed issue URL and never prints unrelated tab URLs.

The explicit endpoint mode remains available. A separate Edge debug profile can be started with a loopback port when current-session access is not available. Load this unpacked extension in that profile once, then keep the target issue tab open. Example PowerShell launch:

```powershell
& "<path-to-msedge.exe>" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\TealBulkCliProfile"
```

The CLI does not open or click a visual confirmation. After the user requests an exact upload, download, or deletion, `plan-*` returns the actionable names and a one-use token. `apply-*` uses that token to start the matching plan without an OK or Confirm click. A download apply uses the same verified ZIP pipeline as the human interface and opens exactly one browser **Save As** dialog.

The CLI only accepts an already open allowed issue target. Persistent mode uses fixed accessibility controls inside the extension's closed shadow root. It can fill one strict command envelope, add one local file at a time to the dedicated upload input, and read a request-bound result. It cannot send arbitrary JavaScript, selectors, URLs, fetch requests, or browser methods through that extension protocol.

Treat local CDP access as a trusted local mutation authority. The one-use plan layers prevent accidental, stale, mismatched, and repeated CLI applies. They do not protect against a hostile local process that already controls the same CDP session, because that process can create and apply its own plan.

Each `plan-*` command writes a random, one-use token in the local temporary state file. State read-modify-write work uses an exclusive lock and atomic same-volume replacement. Each apply claims its token under the lock before transfer or dispatch. Parallel use of one token can reach mutation at most once. The extension also returns a short-lived, one-use authorization ID that the CLI keeps only inside that token record and does not print. The plan is bound to the issue ID, target tab ID, exact URL, page title, page-document generation, connection mode, operation, exact requested names, original planned upload evidence or staged rows, and a sorted staged-file inventory. `apply-*` rechecks that inventory and consumes both authorization layers before it starts. The JSON result reports `succeeded`, `skipped`, `failed`, and `remaining`. A completed download also reports `archiveFilename` and `downloadId`. The CLI never retries an apply automatically.

For local-only verification, `tests/generate-teal-test-manifest.mjs` can create a manifest with the exact `http://127.0.0.1:8769/issue/*` match and exact loopback host permission. It changes only the generated manifest. The extension source files are unchanged. Do not package that generated manifest.

## Permissions

The extension runs only on Teal Alpha issue pages. Its production content-script match is only `https://platform-teal-alpha.vercel.app/issue/*`, and its production host permission is only `https://platform-teal-alpha.vercel.app/*`. It uses `scripting` only for one self-contained native delete click. That temporary main-world function accepts exactly one native remove prompt with the exact expected text; no prompt, a wrong prompt, or a repeated prompt fails the deletion. It restores the page's confirmation function before it returns. It uses the browser `downloads` permission only to open one Edge Save As dialog for the locally built ZIP. It uses temporary session storage to remember the active ZIP download across service-worker restarts. It does not store signed download links or file contents.

## Limits

- Uploads and deletions run one file at a time. ZIP source files are read one at a time.
- A ZIP can contain at most 500 files, 256 MB per file, and 512 MB of source data. The ZIP uses no compression, so its size is close to the total source size.
- During ZIP preparation, **Stop after current file** stops before the next source file. It saves no partial ZIP and keeps the complete selection.
- During upload, **Stop after current file** does not cancel a file that the Teal page already started. During deletion, **Stop deletion** cancels the countdown or stops before the next file.
- The extension depends on the visible labels **Staged files**, **Add file**, and **remove**. It fails closed if these controls are not present.
- This is an unpacked local extension. It is not published in the Chrome Web Store.
