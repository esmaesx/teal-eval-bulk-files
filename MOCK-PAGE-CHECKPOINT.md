# Full Tacit mock page checkpoint

Status: paused on 2026-08-15 at Sahar's request.

## Requested result

Replace the current narrow `TAB-TEST` uploader mock with a complete, local-only Tacit eval page. The page must closely match the current dark Tacit issue layout, but it must contain only fake task names, fake question text, a fake rubric, fake staged files, and fake run history.

## Live layout observations already collected

- Page background: `rgb(16, 16, 18)`.
- Main text: `rgb(232, 232, 232)`.
- Observed browser viewport: 1526 x 897.
- Observed page size: about 1516 x 6176.
- Top bar: Tacit Evals label, issue search input, purple Go button, Menu button, help control, account text, and Sign out.
- Issue header: issue ID followed by a muted taxonomy path.
- Main row: narrow left action rail, Question panel, and Rubric panel.
- Left rail: Sync with Linear, model selector, Get an Answer, Get a Score, and task-analysis actions.
- Question and Rubric panels: bordered dark cards with fixed-height scrollable content.
- Staged files card: full width below the three-column row, with Bulk files and Add file actions at the upper right.
- Run history starts below the staged-files card.

Do not copy real task or rubric text into the mock or public documentation.

## Files to change

- `tests/mock/issue/TAB-TEST/index.html`
- `tests/mock/server.py` only if the richer page needs more fake routes or data
- the working mock under `../../work/teal-extension-mock/` if local legacy tests still use it

## Resume steps

1. Inspect the current live Tacit page again because its UI can change.
2. Build the full fake page in `tests/mock/issue/TAB-TEST/index.html`.
3. Keep all upload, delete, download, duplicate, stop, and list behaviors compatible with the extension tests.
4. Start the local mock server on `127.0.0.1:8769`.
5. Load the generated test manifest in a dedicated temporary browser profile.
6. Test only `http://127.0.0.1:8769/issue/TAB-TEST`.
7. Never use a real Teal issue for mutation tests.
