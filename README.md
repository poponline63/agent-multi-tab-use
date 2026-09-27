# Agent Multi Tab Use

Let every AI agent on your PC work in **your real Chrome** at the same time. Each agent gets its own port and its own tab group, and they never fight over tabs or steal your screen.

![Dashboard](docs/dashboard.png)

Works with anything that speaks the Chrome DevTools Protocol: Claude Code, Codex, Hermes, custom agents, **Puppeteer**, **Playwright**, **Browser Use**, and raw CDP.

## Why

Browser automation normally means launching a separate, logged-out Chrome, or pointing every agent at the same debug port where they trip over each other. Agent Multi Tab Use gives each agent its own lane into the browser you're already signed into:

- **One port per agent.** An agent claims a port and gets a CDP URL (`http://127.0.0.1:9236`).
- **One tab group per agent.** Its tabs land in a named, colored Chrome tab group ("Hermes", "Claude", ...), with optional sub groups ("Hermes › Research").
- **Agents can't see each other's tabs.** Tabs are owned by the port that opened them.
- **Private by default.** Agents only see tabs they opened, never your email or bank. You can switch sharing on.
- **Never steals focus.** Agent tabs open in the background and can't be brought to the front.
- **Agents self-serve.** They claim ports, create groups, and add ports through a small local API. Anything that reduces your control (sharing your tabs, pulling ports from another agent's group) needs your confirmation first.

## How it works

```
agent  ──connects to──▶  companion app (127.0.0.1)  ◀──connects to──  Chrome extension ──▶ your tabs
```

Chrome extensions can't accept incoming connections, so a small companion app listens on the ports and passes messages to the extension, which drives your tabs with `chrome.debugger`.

## Install (Windows)

1. Download `AgentMultiTabUse.exe` and `agent-multi-tab-use-extension.zip` from [Releases](https://github.com/poponline63/agent-multi-tab-use/releases/latest).
2. Run `AgentMultiTabUse.exe`. It has no window, runs in the background, and starts with Windows. (Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**. The app isn't code-signed yet.)
3. Unzip the extension, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
4. Click the extension icon. The dashboard should show **Hub online**.

To stop the app: `AgentMultiTabUse.exe --quit`.

## Give an agent access

Open the dashboard, go to **Agent setup**, pick a group, and click **Copy for agent**. Paste that into your agent. It explains everything below with ready-to-run snippets.

Quick version:

```bash
# 1. claim a port (same agent name = same port back)
curl -s -X POST http://127.0.0.1:9223/claim -H "Content-Type: application/json" -d '{"agent":"my-agent","group":"My Agent"}'
# -> {"port":9236,"cdpUrl":"http://127.0.0.1:9236","group":"My Agent","ready":true}
```

```js
// 2. drive it with Puppeteer
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9236", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://example.com");
```

```python
# or Playwright
browser = p.chromium.connect_over_cdp("http://127.0.0.1:9236")
page = browser.contexts[0].new_page()
page.goto("https://example.com")
```

```bash
# 3. release when done
curl -s -X POST http://127.0.0.1:9223/release -H "Content-Type: application/json" -d '{"agent":"my-agent","all":true}'
```

### API (`GET http://127.0.0.1:9223/` lists it all)

| Endpoint | What it does |
|---|---|
| `GET /status` | Every port, its group, who holds it, live or not, plus settings and version info |
| `POST /claim` | Get your own port(s). `count` for several, `parent` for a sub group |
| `POST /release` | Give ports back. `all`, `closeTabs`, `keepTabs` |
| `POST /group` | Create or recolor a tab group |
| `POST /group/delete` | Delete a group and its sub groups |
| `POST /ports` | Add ports (up to 250) |
| `POST /adopt` | Take over a tab the user opened (only while sharing is on) |
| `POST /take` | Pull idle ports from another group. **User must confirm** |
| `POST /settings` | `shareTabs` (turning it on needs **user confirmation**), `closeTabsOnRelease` |

Each port also serves the standard DevTools endpoints: `GET /json/version`, `GET /json/list`, `PUT /json/new?<url>`, and `WS /cdp`.

## Security

- Everything listens on **127.0.0.1 only**. Nothing is reachable from your network or the internet, and nothing is sent online.
- **Web pages can't use it.** Requests carrying a website's `Origin` are refused.
- A private key, generated automatically, stops other extensions or programs from posing as the browser.
- Agents can't close your browser, grant site permissions, or switch your active tab.
- **Any program on your PC can reach the ports while the app runs**, the same as Chrome's own `--remote-debugging-port`. Quit the app when you don't want agents in your browser.
- Chrome shows a "started debugging this browser" bar on tabs agents control. That's expected.

## Build from source

Requires [Bun](https://bun.sh).

```bash
cd companion
bun selftest.js      # hub self-test, runs on its own test ports
bun run build        # -> companion/dist/AgentMultiTabUse.exe
```

The extension in `extension/` loads unpacked as is.

## Credits

- The per-port CDP relay in `companion/relay/` is adapted from the browser relay in [oh-my-pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) by Mario Zechner and Can Bölük (MIT). See `companion/relay/LICENSE` and `NOTICE`.
- Fonts: Bricolage Grotesque and JetBrains Mono, SIL Open Font License (see `extension/fonts/`).

## License

MIT. See [LICENSE](LICENSE).
