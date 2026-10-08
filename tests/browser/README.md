# Summary controls browser checks

Run against the normal Vite dev server, with the summaries plugin checkout next to the host checkout:

```powershell
python E:\Development\Projects\ChattyPop\tests\browser\summaryControls.py
```

The runner uses the Python Playwright installation and Chromium already available on the development machine. It adds no application dependency. Pass `--base-url` or `--plugin-dir` for a different server or absolute plugin path. Optional `--screenshots-dir` captures browser evidence.

The fixture renders the real Summary controls with synthetic servers, channels, and DMs. It installs no API transport and runs no summaries. Checks cover mobile nested modal navigation, keyboard-inset geometry and dismissal animation, accessible names, selection, hidden-tail filtering, cleanup, and desktop popover/keyboard behavior. This is a manual browser regression runner, separate from the Node-only Vitest suite; native iOS keyboard and assistive technology checks still require a device.
