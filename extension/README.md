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

The Teal platform posts one Linear comment when it finalizes each staged file. The extension shows this warning and requires an explicit confirmation before it begins an upload batch.

The extension does not upload, delete, or post anything by itself. Before a batch starts, its closed-shadow in-extension alert dialog shows the exact selected names. Only a trusted click on **Confirm** starts the batch. A scripted click, including a CLI CDP command, cannot approve it.

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

If the page shows two rows with the same filename and SHA-256 value, the extension marks them as duplicate rows and excludes them from bulk download and bulk deletion. Use the page's native control for those rows so the extension cannot act on the wrong copy.

For deletions, the final confirmation shows the exact filename and the first eight characters of its SHA-256 value. After confirmation, a five-second countdown starts before the first deletion. Choose **Stop deletion** during the countdown to delete nothing and keep the full selection. Choose it after deletion starts to finish only the current file and keep all later files selected. The extension also stops if the page changes before it can delete the exact next row.

## Local CLI (optional)

`teal-eval-bulk-cli.mjs` is a dependency-free Node 24 tool for an already open browser. It supports an explicit loopback CDP endpoint and a user-selected current Chrome or Edge session. It does not launch a browser, open a tab, navigate a page, read cookies, or read credential stores.

```text
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST status
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST list
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST plan-upload C:\files\one.txt C:\files\two.csv
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST apply-upload <plan-token>
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST plan-delete old-file.txt
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST apply-delete <plan-token>
node teal-eval-bulk-cli.mjs --cdp http://127.0.0.1:9222 --issue TAB-TEST stop
```

For a selected current Chrome or Edge session, first enable remote debugging at `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging`. The browser can show one local connection permission prompt. Then use:

```text
node teal-eval-bulk-cli.mjs --browser chrome --issue ABC-123 status
node teal-eval-bulk-cli.mjs --browser edge --issue ABC-123 list
```

Current-session mode reads only the selected browser data root's small `DevToolsActivePort` record. It uses the private loopback WebSocket path without printing it. It lists targets internally only to find exactly one allowed issue URL and never prints unrelated tab URLs.

The explicit endpoint mode remains available. A separate Edge debug profile can be started with a loopback port when current-session access is not available. Load this unpacked extension in that profile once, then keep the target issue tab open. Example PowerShell launch:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\TealBulkCliProfile"
```

The CLI never confirms a mutation. After `apply-upload` or `apply-delete`, review the exact list in the extension and select **Confirm** there. Select **Cancel** to keep the page unchanged.

The CLI only accepts an already open allowed issue target. It uses the browser debugging protocol only to select that exact target, set paths on the extension's file input, and call the narrow isolated bridge commands: `status`, `list`, `plan-upload`, `apply-upload`, `plan-delete`, `apply-delete`, and `stop`. It cannot send JavaScript, selectors, URLs, fetch requests, or arbitrary browser methods through that bridge.

Each `plan-*` command writes a random, one-use token in the local temporary state file. The token expires after five minutes by default. It is bound to the issue ID, target tab ID, operation, exact requested names, and a sorted staged-file inventory. `apply-*` rechecks that inventory before it consumes the token and asks for the in-extension trusted confirmation. The JSON result reports `succeeded`, `skipped`, `failed`, and `remaining`; it never retries a mutation automatically.

For local-only verification, `work/generate-teal-test-manifest.mjs` can create a manifest with the exact `http://127.0.0.1:8769/issue/*` match and exact loopback host permission. It changes only the generated manifest. The extension source files are unchanged. Do not package that generated manifest.

## Permissions

The extension runs only on Teal Alpha issue pages. Its production content-script match is only `https://platform-teal-alpha.vercel.app/issue/*`, and its production host permission is only `https://platform-teal-alpha.vercel.app/*`. It uses `scripting` only for one self-contained native delete click. That temporary main-world function accepts exactly one native remove prompt with the exact expected text; no prompt, a wrong prompt, or a repeated prompt fails the deletion. It restores the page's confirmation function before it returns. It uses the browser `downloads` permission only to open one Edge Save As dialog for the locally built ZIP. It uses temporary session storage to remember the active ZIP download across service-worker restarts. It does not store signed download links or file contents.

## Limits

- Uploads and deletions run one file at a time. ZIP source files are read one at a time.
- A ZIP can contain at most 500 files, 256 MB per file, and 512 MB of source data. The ZIP uses no compression, so its size is close to the total source size.
- During ZIP preparation, **Stop after current file** stops before the next source file. It saves no partial ZIP and keeps the complete selection.
- During upload, **Stop after current file** does not cancel a file that the Teal page already started. During deletion, **Stop deletion** cancels the countdown or stops before the next file.
- The extension depends on the visible labels **Staged files**, **Add file**, and **remove**. It fails closed if these controls are not present.
- This is an unpacked local extension. It is not published in the Chrome Web Store.
