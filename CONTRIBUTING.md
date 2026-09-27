# Contributing

Bug reports, compatibility notes ("works with X") and pull requests are all welcome.

## Before you open a PR

1. Keep it focused: one fix or feature per PR.
2. Run the hub self-test. It starts its own app instance on test ports and never touches your real browser:
   ```bash
   cd companion
   bun selftest.js
   ```
3. If you changed how agents talk to the browser, say which clients you tried (Puppeteer, Playwright, Browser Use, raw CDP).
4. Keep the app and extension versions in step (`companion/main.js` `VERSION`, `companion/package.json`, `extension/manifest.json`).

## Ground rules the code keeps

- Everything stays on 127.0.0.1. No network calls out.
- Agents never steal the user's focus, never close the browser, and never see another agent's tabs.
- Anything that reduces the user's control (sharing their tabs, pulling ports from another group) needs their confirmation.

## Project layout

- `extension/`: the Chrome extension (MV3). Drives tabs with `chrome.debugger`, owns settings.
- `companion/`: the app agents connect to. `main.js` is the agent API; `relay/` is the per-port CDP relay.
