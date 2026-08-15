# Teal Eval Bulk Files

This repository contains:

- a Chrome and Microsoft Edge extension for bulk upload, one-ZIP download, and bulk deletion of staged files on Teal Alpha eval issue pages;
- a dependency-free Node 24 CLI with explicit two-phase upload and delete plans;
- a Codex skill that selects a browser session and calls the CLI safely;
- local tests and a false `TAB-TEST` eval page.

The current release is `0.9.1`.

## Install the extension

1. Clone or download this repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable developer mode.
4. Select **Load unpacked**.
5. Select the `extension` directory.

Reload the unpacked extension after a source update.

## Install the Codex skill

Copy the `skill` directory to your Codex skills directory and name it `teal-eval-bulk-cli`. On Windows, this is usually:

```text
%USERPROFILE%\.codex\skills\teal-eval-bulk-cli
```

Set `TEAL_EVAL_BULK_EXTENSION_ROOT` to the absolute path of the cloned `extension` directory when the skill is installed separately. When the skill and extension stay in this repository layout, the wrapper finds the sibling `extension` directory automatically.

## Use the current browser session

Normal page authorization and CLI transport are different permissions. For Chrome, open `chrome://inspect/#remote-debugging`. For Edge, open `edge://inspect/#remote-debugging`. Enable remote debugging for the current browser session. Approve the local connection prompt when the CLI starts.

Then use the wrapper with the browser that contains the exact open issue tab:

```powershell
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue ABC-123 -Command status
& .\skill\scripts\invoke-teal-cli.ps1 -Browser edge -Issue ABC-123 -Command list
```

The CLI fails if the selected browser has no exact matching issue tab or has more than one matching tab. It does not switch to another browser or profile.

## Safety model

- The production extension runs only on `https://platform-teal-alpha.vercel.app/issue/*`.
- The CLI accepts only loopback debugging connections.
- Current-session mode reads only the browser's small `DevToolsActivePort` record. It does not read cookies, credentials, history, or profile databases.
- Upload and delete use one-use plan tokens bound to the issue, target tab, requested names, and staged inventory.
- The CLI cannot approve a mutation. A trusted user click on the extension's closed confirmation dialog is still required.
- Duplicate upload names are skipped independently. Other files continue.
- Bulk deletion has a five-second stop window and continues only while the exact staged row can be proved.

See [extension/README.md](extension/README.md) and [skill/references/cli-contract.md](skill/references/cli-contract.md) for the full contract.

## Local tests

Requirements: Node 24, Python 3 for the mock server, and optional 7-Zip for an external ZIP check.

```powershell
npm test
npm run test:manifest
npm run mock
```

Open `http://127.0.0.1:8769/issue/TAB-TEST` only with a test manifest and a dedicated temporary browser profile. Do not test mutations on a real Teal issue.

## Documentation and screenshots

Future screenshots must use only the local `TAB-TEST` page with fake filenames and content. Keep account names, profile paths, browser history, credentials, real issue IDs, and real Linear content out of every image. A full guide can use `docs/guide.md` with images under `docs/images/`.

## License

No license is included. The repository is public, but no reuse license has been granted.
