# Browser checks

## Summary controls

Run against the normal Vite dev server, with the summaries plugin checkout next to the host checkout:

```powershell
python E:\Development\Projects\ChattyPop\tests\browser\summaryControls.py
```

The runner uses the Python Playwright installation and Chromium already available on the development machine. It adds no application dependency. Pass `--base-url` or `--plugin-dir` for a different server or absolute plugin path. Optional `--screenshots-dir` captures browser evidence.

The fixture renders the real Summary controls with synthetic servers, channels, and DMs. It installs no API transport and runs no summaries. Checks cover mobile nested modal navigation, keyboard-inset geometry and dismissal animation, accessible names, selection, hidden-tail filtering, cleanup, and desktop popover/keyboard behavior. This is a manual browser regression runner, separate from the Node-only Vitest suite; native iOS keyboard and assistive technology checks still require a device.

## Local spoilers

With the normal Vite server running, open `http://localhost:5173/@fs/E:/Development/Projects/ChattyPop/tests/browser/localSpoilers.html`. The fixture in `E:\Development\Projects\ChattyPop\tests\browser\localSpoilers.mjs` renders the real attachment covers, Markdown links, embed cards, and context menu. Its settings transport uses a separate fixture namespace in browser storage and never reaches Discord or the archive.

Right-click the image, video, or Short link and choose **Mark as spoiler locally**. Confirm that only the selected item is covered (the Short link and its preview share a mark), that covered controls are inert, and that revealing retains a **Local spoiler** badge explaining its origin. Reload to confirm covers return, then right-click and choose **Remove local spoiler**. The third image is a sender spoiler; the fixture sets Show spoiler content to Always, so that image starts uncovered while locally marked items require a reveal. Locally mark it too, confirm its badge says the sender also marked it, then remove the local mark and confirm its sender flag stays true. Use `await window.spoilerFixture.reset()` in the browser console to clear fixture marks; `window.reviewErrors` should stay empty.
