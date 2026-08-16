# Teal Eval Bulk Files

Teal Eval Bulk Files adds reliable batch file controls to Tacit Teal eval issue pages. It includes:

- a Chrome and Microsoft Edge extension for loose-file upload, one-ZIP download, and checked bulk deletion;
- a dependency-free Node 24 CLI for LLM and terminal workflows;
- a Codex skill that selects an open browser session and calls the CLI;
- a complete local-only demonstration page and repeatable screenshot tests.

Current release: `0.9.4`.

![Complete fictional eval page with the Bulk files control](docs/images/eval-page-overview.png)

## Main features

- Drag several loose files into one upload target.
- Skip duplicate filenames and continue with new files.
- Download selected staged files in one ZIP and use one Save As dialog.
- Select staged files with checkboxes before deletion.
- Stop an upload after the current file or stop a deletion during its five-second delay.
- Keep human Confirm/Cancel review inside the extension.
- Let an authorized CLI plan apply without the extension confirmation dialog. A CLI download still opens one native Save As dialog.
- Reject stale, mismatched, expired, ambiguous, or reused CLI plans.

## Install the extension

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Microsoft Edge.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select the repository's `extension` directory.
6. Reload the Teal issue page.

For update and troubleshooting steps, see [Browser installation](docs/browser-installation.md).

## Use the human interface

Open a Teal Alpha issue page and find **Staged files**. Select **Bulk files**, then select one mode:

- **Upload loose files**: drag files or use **Choose files**.
- **Download staged files**: select rows and create one ZIP.
- **Delete staged files**: select rows, review the exact names, and use the stop delay if needed.

![Upload mode with two new files and one duplicate](docs/images/upload-mode.png)

See [Human interface guide](docs/human-interface.md) for all controls, duplicate rules, partial results, and stop behavior.

## Install the Codex skill

Copy the `skill` directory to the Codex skills directory and name it `teal-eval-bulk-cli`. On Windows, the usual destination is:

```text
%USERPROFILE%\.codex\skills\teal-eval-bulk-cli
```

If the skill is not kept beside the repository's `extension` directory, set `TEAL_EVAL_BULK_EXTENSION_ROOT` to the absolute extension path.

## Use the CLI

The CLI attaches to an already open browser session. It does not launch a browser, log in, or navigate. Select the exact browser or session first. The wrapper then requires exactly one transport: an explicit persistent stdio-proxy path, a current Chrome or Edge session, or an explicit loopback CDP endpoint.

For a user-selected Chrome session with a configured persistent bridge, pass its absolute proxy path. The portable wrapper has no machine-specific default:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -PersistentBridgePath "<absolute-path-to-stdio-proxy.mjs>" `
  -Issue DEMO-204 -Command status
```

For direct current-session mode, enable the browser's protected local debugging bridge at `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging`. Then call the wrapper with the browser and exact issue ID:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command status
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue DEMO-204 -Command list
```

Uploads, downloads, and deletions use two commands: `plan-*` returns a one-use token, and `apply-*` rechecks the exact plan before it starts. The user's requested plan is the CLI approval boundary. No extension confirmation click is required.

For a download, pass exact staged filenames to `plan-download`, then pass only its token to `apply-download`:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command plan-download `
  -Operands "evidence.csv","notes.txt"

& .\skill\scripts\invoke-teal-cli.ps1 `
  -Browser edge -Issue DEMO-204 -Command apply-download `
  -Operands "<one-use-token>"
```

Apply creates one verified ZIP and opens exactly one native Save As dialog. The CLI does not accept an arbitrary absolute output path.

![Fictional CLI plan and apply example](docs/images/cli-plan-example.png)

See [CLI guide](docs/cli-guide.md) for browser selection, every command, JSON fields, and failure recovery.

## Safety model

- The production extension runs only on `https://platform-teal-alpha.vercel.app/issue/*`.
- The CLI accepts only an explicit local persistent-bridge path, a selected current browser session, or an explicit loopback debugging endpoint.
- The CLI reads no cookies, passwords, browser history, or credential databases.
- Upload, download, and delete plans are bound to the exact issue, target tab, URL, page title, page generation, connection mode, requested names, and staged inventory.
- Human upload and delete actions keep the extension's closed-shadow confirmation dialog. Human download uses the native Save As dialog.
- CLI actions require the exact requested plan and two one-use authorization layers.
- Real Teal issues are never used for mutation tests.

Local browser debugging is trusted local mutation authority. The plan controls prevent accidental or stale applies. They cannot protect a debugging session from another hostile local process that already controls it.

## Documentation

- [Browser installation and update](docs/browser-installation.md)
- [Human interface](docs/human-interface.md)
- [CLI and Codex skill](docs/cli-guide.md)
- [Local demonstration and screenshot reproduction](docs/local-demo.md)
- [Extension implementation details](extension/README.md)
- [CLI contract](skill/references/cli-contract.md)

## Tests

Requirements: Node 24 and Python 3. Screenshot capture also needs Playwright's Chromium browser.

```powershell
npm install
npm test
npm run test:manifest
npm run docs:verify
```

The complete demonstration and screenshot workflow is in [Local demonstration and screenshot reproduction](docs/local-demo.md).

## License

No license is included. The repository is public, but no reuse license has been granted.
