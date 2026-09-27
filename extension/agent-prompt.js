// The "Copy for agent" text. Written for any AI agent on any setup: it states
// exactly what to call, what comes back, and what to do when something fails.
const HUB = "http://127.0.0.1:9223";

function buildAgentPrompt({ claimBody, groupName, fallbackPort, shareTabs }) {
	const body = JSON.stringify(claimBody);
	const pyBody = body.replace(/"/g, '\\"');
	const groupLine = groupName
		? `Tabs you open are put in the "${groupName}" tab group automatically, so the user can see what you're doing.`
		: `Add "group":"<name>" to the claim to get your own named tab group (created if missing), e.g. "Hermes Tab Group".`;
	const seeLine = shareTabs
		? "You can see tabs you opened plus the user's own tabs. Only touch the user's tabs when they ask you to."
		: "You can only see tabs you opened. The user's own tabs are private and invisible to you. Always open a new tab for your work.";
	const fallback = fallbackPort
		? `\n   If the app itself is down, you can still connect straight to http://127.0.0.1:${fallbackPort}.`
		: "";
	return `You can control the user's real Chrome browser (their own profile, logged in) through Agent Multi Tab Use.
Every agent gets its own port ("lane") and its own tab group. Everything runs locally on this PC.

STEP 1: CLAIM YOUR PORT
  POST ${HUB}/claim   body: ${body}
  PowerShell: Invoke-RestMethod -Method Post ${HUB}/claim -ContentType application/json -Body '${body}'
  curl:       curl -s -X POST ${HUB}/claim -H "Content-Type: application/json" -d '${body}'
  Python:     json.load(urllib.request.urlopen(urllib.request.Request("${HUB}/claim", b"${pyBody}", {"Content-Type": "application/json"})))
  Reply:      {"port": 9236, "cdpUrl": "http://127.0.0.1:9236", "group": "...", "ready": true}
  - Replace "your-name" with a short fixed name for yourself (e.g. "hermes", "codex-research"). Claiming again
    with the same name returns the same port, so retries are safe.
  - Need several ports (one per sub-agent)? Add "count": 5. Missing ports are created automatically.
  - 503 with "retry": true means Chrome is reconnecting. Wait 5 seconds and retry, for up to a minute.
  - "ready": false means Chrome hasn't attached to that port yet. Wait a few seconds; GET ${HUB}/status shows
    "live": true per port when it's usable.${fallback}

STEP 2: CONNECT TO YOUR cdpUrl (any Chrome DevTools Protocol client works)
  Node, Puppeteer:    const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
                      const page = await browser.newPage(); await page.goto("https://example.com");
  Python, Playwright: browser = p.chromium.connect_over_cdp(cdpUrl)
                      page = browser.contexts[0].new_page(); page.goto("https://example.com")
  Raw CDP websocket:  ws://127.0.0.1:<port>/cdp  ->  Target.createTarget {"url": "..."}  ->
                      Target.attachToTarget {"targetId": "...", "flatten": true}  ->  send page commands with that sessionId
  No CDP at all:      PUT http://127.0.0.1:<port>/json/new?https://example.com  opens a tab; GET /json/list lists yours.
  Target ids are Chrome's real ids (32 hex characters). Treat them as opaque strings; don't parse them.
  Playwright over CDP: page.viewport_size is None; use page.evaluate("[innerWidth, innerHeight]") instead.
  Origin header: send none, or a localhost one (http://127.0.0.1). A web-site Origin is refused with 403.
  PUT /json/new replies with the tab's "groupId" once it has joined your tab group.

STEP 3: WHEN YOU'RE DONE
  Close the tabs you opened, then disconnect (Puppeteer: browser.disconnect(); Playwright: leave the
  "with sync_playwright()" block). browser.close() is harmless (the user's Chrome ignores it) but disconnecting
  is the clean way.
  Release your ports: POST ${HUB}/release  {"agent":"your-name","all":true}
  Your tabs: by default they stay open after you release. GET /status "closeTabsOnRelease" shows the user's
  preference (if true, release closes the tabs you opened). Follow the user: if they ask you to close your
  tabs, add "closeTabs": true to the release (or close them yourself with Target.closeTarget); if they want
  them kept, add "keepTabs": true. Tabs you adopted from the user are always handed back open.
  POST ${HUB}/settings {"closeTabsOnRelease": true|false} changes the default when the user asks.

WHAT YOU CAN SEE
  ${seeLine}
  Other agents' tabs are invisible to you, and yours to them.
  ${groupLine}
  Your tabs open in the background so the user can keep working. You can't switch the user's active tab
  (bringToFront / activateTarget do nothing). If a page acts differently when unfocused, send
  Emulation.setFocusEmulationEnabled {"enabled": true} on your tab (Puppeteer and Playwright already do).

OTHER ENDPOINTS (GET ${HUB}/ lists them all)
  GET  /status   every port: its group, which agent holds it, "live", tab count; plus "chromeConnected"
  POST /group    {"name":"...","color":"yellow"}  create or recolor a tab group
  SUB GROUPS     To keep a separate piece of work apart, claim into a sub group of your group:
                 POST /claim {"agent":"your-name","group":"Research","parent":"<your group>"}
                 It becomes its own Chrome tab group titled "<your group> › Research" in your color.
                 Claim with "group":"<your group>" again to go back to your main group. One level deep only.
                 colors: blue, red, yellow, green, pink, purple, cyan, orange, grey
  POST /adopt    {"agent":"your-name","port":<your port>,"targetId":"4CD57B02A6B1B8D201AB0080C552A9F1"}  take over a tab the user opened
                 (only when the user asks, and only while shareTabs is on). It moves into your tab group and becomes
                 yours; releasing your port gives it back. Get the "id" from GET http://127.0.0.1:<port>/json/list.
  POST /ports    {"add":5}  add more ports
  POST /settings {"shareTabs": false}  agents only see tabs they opened (takes effect at once)
                 {"shareTabs": true}   let agents see the user's own tabs. Only when the user asks you to. The first
                 reply is a confirmation message: show it to the user, and repeat with "confirm":"<token>" only after
                 they say yes. GET /status shows the current "shareTabs".
  POST /take     {"agent":"...","from":"<other group>","to":"<your group>","count":2}  pull idle ports from another
                 group. The first reply is a confirmation message: show it to the user word for word and wait for
                 their yes, then repeat the request with "confirm":"<token>". Never confirm on your own.

RULES
1. Only use the port(s) you claimed. Other ports belong to other agents.
2. Never close tabs you didn't open.
3. This is the user's real, logged-in browser. Ask before purchases, sending messages or posts, or changing
   account settings.
4. If something still fails after retrying, stop and report the exact error. Don't launch a separate browser instead.
   If GET /status has a "warning" (e.g. extension and app versions differ), tell the user; refreshing the
   extension in chrome://extensions usually fixes odd errors after an update.`;
}
