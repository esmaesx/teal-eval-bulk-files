# Browser installation and update

The extension is installed as an unpacked Manifest V3 extension. Use the same `extension` directory in Chrome or Microsoft Edge.

## Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Select the repository's `extension` directory.
5. Open or reload a Teal Alpha issue page.
6. Confirm that **Bulk files** appears beside **Add file** in the **Staged files** card.

## Google Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Select the repository's `extension` directory.
5. Open or reload a Teal Alpha issue page.
6. Confirm that **Bulk files** appears beside **Add file**.

## Reload after an update

The repository files can change while the unpacked extension is installed.

1. Open the browser's extension page.
2. Find **Teal Eval Bulk Files**.
3. Select **Reload**.
4. Reload the Teal issue page.

If the button is missing, check these items:

- The address matches `https://platform-teal-alpha.vercel.app/issue/*`.
- The page shows a **Staged files** card and an **Add file** button.
- The extension has no error on the browser's extension page.
- The selected unpacked directory contains `manifest.json`, not another parent directory.

## Remove or disable

Use the browser's extension page to disable or remove the unpacked extension. Removing the extension does not delete files already staged on Teal.

## CLI connection is separate

Loading the extension lets the human interface work. The CLI also needs the selected browser's protected local debugging bridge.

- Chrome: `chrome://inspect/#remote-debugging`
- Edge: `edge://inspect/#remote-debugging`

The browser can show one local connection prompt. This prompt grants the CLI connection. It is not an upload or deletion confirmation.
