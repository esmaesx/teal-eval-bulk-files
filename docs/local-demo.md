# Local demonstration and screenshot reproduction

The repository includes a complete fictional eval page for safe browser testing. It uses invented question text, rubric criteria, account text, filenames, and run history.

Never use a real Teal issue for mutation tests or public screenshots.

## Start the local page

```powershell
npm install
npm run mock
```

Open this local-only demonstration address with the generated test extension and a dedicated temporary profile:

```text
http://127.0.0.1:8769/issue/DEMO-204?docs=1
```

The production manifest does not match this address. This prevents the production extension from running on unrelated local pages.

## Generate the test manifest

```powershell
npm run test:manifest
```

The command writes a local test manifest. It adds only the exact loopback server match. Do not package it as the production manifest.

## Capture all documentation images

Install Playwright's Chromium browser once if it is not already available:

```powershell
npx playwright-core install chromium
```

Then run:

```powershell
npm run docs:capture
```

The capture process:

1. Starts the local fake server in a hidden process.
2. Copies the extension into the ignored `artifacts/documentation-capture` directory.
3. Adds the loopback match only to that disposable copy.
4. Opens the copy's shadow root only so the test can select fictional files and deterministic controls.
5. Starts Chromium in headless mode with a dedicated temporary profile.
6. Captures the full page plus upload, download, delete, and CLI example images.
7. Closes the headless browser and local server.

The production `extension/content.js` keeps its closed shadow root. The screenshot process does not open a foreground window and does not take focus from the user's active application.

Set `PLAYWRIGHT_CHROMIUM_PATH` to an explicit Chromium executable if the standard Playwright location is not available.

## Verify public documentation

```powershell
npm run docs:verify
```

The check requires every expected image, verifies PNG dimensions, scans public Markdown for the private internal route label, and rejects real Teal issue URLs in the public guides.

## Screenshot privacy rules

- Use only the local fictional page.
- Show no real issue ID, task text, rubric, staged file, account, cookie, token, profile path, or private browser endpoint.
- Capture page content, not browser chrome or the Windows desktop.
- Use placeholders for one-use plan tokens.
- Reload the local page after a source change before capture.
