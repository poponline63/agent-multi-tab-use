// Agent Multi Tab Use: one Chrome, many relay lanes.
// Each lane is the extension's side of one port's relay in the companion app, so
// every agent gets a home port. All lanes share the one hub websocket (messages
// are tagged with their port), so there is a single connection to keep alive and
// no per-port reconnect state. chrome.debugger allows one attachment per tab
// per extension, so attachments are shared: owners tracks which lanes use a tab,
// CDP events go only to those lanes, and the tab detaches when the last one leaves.
//
// Tab ownership: the relay attaches every tab for discovery, so attach is not a
// claim. A lane claims a tab when it creates it or asks to group it (the relay
// groups exactly the tabs an agent drives). A claimed tab is hidden from every
// other lane (they get tabRemoved) until the owner ungroups it or is released.
// Ownership is kept in chrome.storage.session, so a service-worker restart (Chrome
// stops idle workers) or an app restart doesn't take agents' tabs away.
//
// Named groups: ports can be put in a named group ("Hermes Tab Group"); every
// port in it files its tabs into that one Chrome tab group.
var MAX_PORTS = 250;
var DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 9224 + i);
var COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
var lanes = new Map();
var owners = new Map();
var claims = new Map();
// Tab -> port that opened it. Releasing a port closes only the tabs that port opened and still owns;
// tabs it adopted (from the user, or left behind by another agent) are handed back open.
var createdTabs = new Map();
var settings = { ports: [], groups: [], shareTabs: false };

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
async function loadSettings() {
  const stored = await chrome.storage.local.get({ ports: DEFAULT_PORTS, groups: [], shareTabs: false });
  const ports = [...new Set((Array.isArray(stored.ports) ? stored.ports : DEFAULT_PORTS).map(Number).filter(validPort))].slice(0, MAX_PORTS);
  const groups = (Array.isArray(stored.groups) ? stored.groups : []).filter((g) => g && typeof g.name === "string").map((g) => ({
    id: String(g.id),
    name: g.name.trim() || "Tab Group",
    color: COLORS.includes(g.color) ? g.color : "blue",
    ports: (Array.isArray(g.ports) ? g.ports : []).map(Number).filter(validPort),
    ...(typeof g.parent === "string" && g.parent ? { parent: g.parent } : {})
  }));
  return { ports, groups, shareTabs: stored.shareTabs === true };
}
var tabStateSaving = null;
function saveTabState() {
  tabStateSaving ??= Promise.resolve().then(() => {
    tabStateSaving = null;
    return chrome.storage.session.set({ tabState: { claims: [...claims], created: [...createdTabs] } });
  }).catch(() => {});
}
async function loadTabState() {
  const [{ tabState } = {}, tabs] = await Promise.all([chrome.storage.session.get("tabState").catch(() => ({})), chrome.tabs.query({})]);
  const alive = new Set(tabs.map((tab) => tab.id));
  for (const [tabId, port] of tabState?.claims ?? []) {
    if (alive.has(tabId))
      claims.set(tabId, port);
  }
  for (const [tabId, port] of tabState?.created ?? []) {
    if (alive.has(tabId))
      createdTabs.set(tabId, port);
  }
}
function laneLook(port) {
  const group = settings.groups.find((g) => g.ports.includes(port));
  if (group)
    return { title: group.name, color: group.color };
  const index = Math.max(0, settings.ports.indexOf(port));
  return { title: `Port ${port}`, color: COLORS[index % COLORS.length] };
}
function snapshot(tab) {
  if (tab.id === undefined)
    return null;
  return {
    tabId: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    windowId: tab.windowId,
    pinned: tab.pinned,
    groupId: tab.groupId,
    sleeping: tab.discarded === true || tab.frozen === true
  };
}
// Chrome's own target id per tab, so the relay can use real ids (Playwright
// needs page target id == main frame id). Read without attaching a debugger.
var targetIds = new Map();
async function withTargetId(snap) {
  if (!snap)
    return snap;
  if (!targetIds.has(snap.tabId)) {
    for (const t of await chrome.debugger.getTargets().catch(() => [])) {
      if (t.tabId !== undefined && t.type === "page")
        targetIds.set(t.tabId, t.id);
    }
  }
  const targetId = targetIds.get(snap.tabId);
  return targetId ? { ...snap, targetId } : snap;
}
function post(lane, msg) {
  if (lane?.open)
    hubSend({ t: "lane", port: lane.port, msg });
}
function broadcast(msg) {
  for (const lane of lanes.values())
    post(lane, msg);
}
function postToOwners(tabId, msg) {
  for (const port of owners.get(tabId) ?? [])
    post(lanes.get(port), msg);
}
// Private by default: an agent sees only tabs it opened. With "shareTabs" on,
// it also sees the user's own (unclaimed) tabs, never another agent's.
function visibleTo(lane, tabId) {
  const owner = claims.get(tabId);
  return owner === lane.port || (owner === undefined && settings.shareTabs);
}
function postVisible(tabId, msg) {
  for (const lane of lanes.values()) {
    if (visibleTo(lane, tabId))
      post(lane, msg);
  }
}
function claimedBy(port) {
  return [...claims].filter(([, owner]) => owner === port).map(([tabId]) => tabId);
}
function claim(lane, tabId) {
  const owner = claims.get(tabId);
  if (owner !== undefined)
    return owner === lane.port;
  claims.set(tabId, lane.port);
  saveTabState();
  // Memory Saver would put an agent's background tab to sleep mid-task.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  for (const other of lanes.values()) {
    if (other !== lane)
      post(other, { t: "tabRemoved", tabId });
  }
  refreshStatus();
  return true;
}
async function release(tabId) {
  const owner = claims.get(tabId);
  if (owner === undefined)
    return;
  claims.delete(tabId);
  saveTabState();
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  refreshStatus();
  const snap = await chrome.tabs.get(tabId).then(snapshot, () => null).then(withTargetId);
  if (!snap)
    return;
  for (const lane of lanes.values()) {
    if (lane.port !== owner && visibleTo(lane, tabId))
      post(lane, { t: "tabCreated", tab: snap });
  }
}
async function refreshStatus() {
  const laneStatus = [...lanes.values()].map((lane) => ({
    port: lane.port,
    open: lane.open,
    tabs: claimedBy(lane.port).length
  }));
  const live = laneStatus.filter((lane) => lane.open).length;
  try {
    await chrome.storage.session.set({ laneStatus });
    await chrome.action.setBadgeText({ text: live ? String(live) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#1f9d55" });
  } catch {}
}
var groupOps = Promise.resolve();
function enqueueGroupOp(fn) {
  const result = groupOps.then(fn, fn);
  groupOps = result.catch(() => {});
  return result;
}
async function groupTabs(tabIds, title, color) {
  const byWindow = new Map;
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.pinned || tab.id === undefined)
        continue;
      const bucket = byWindow.get(tab.windowId) ?? [];
      bucket.push(tab.id);
      byWindow.set(tab.windowId, bucket);
    } catch {}
  }
  const grouped = {};
  for (const [windowId, ids] of byWindow) {
    const existing = await chrome.tabGroups.query({ title, windowId });
    const groupId = existing[0] ? await chrome.tabs.group({ tabIds: ids, groupId: existing[0].id }) : await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, { title, color });
    for (const id of ids)
      grouped[String(id)] = groupId;
  }
  return { grouped };
}
// Renaming/recoloring updates the Chrome group in place. Moving tabs to a new
// group would change their groupId, which the relay reads as the user dragging
// them out (permanent opt-out).
async function restyleGroups() {
  for (const lane of lanes.values()) {
    const look = laneLook(lane.port);
    const groupIds = new Set();
    for (const tabId of claimedBy(lane.port)) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.groupId >= 0)
        groupIds.add(tab.groupId);
    }
    for (const groupId of groupIds)
      await chrome.tabGroups.update(groupId, look).catch(() => {});
  }
}
async function buildHello(lane) {
  const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
  for (const t of targets) {
    if (t.tabId !== undefined && t.type === "page")
      targetIds.set(t.tabId, t.id);
  }
  // "claimed" lets a restarted app restore which tabs this port drives.
  const snapshots = tabs.map(snapshot).filter((snap) => snap && visibleTo(lane, snap.tabId)).map((snap) => ({
    ...snap,
    ...targetIds.has(snap.tabId) ? { targetId: targetIds.get(snap.tabId) } : {},
    ...claims.get(snap.tabId) === lane.port ? { claimed: true } : {}
  }));
  const attachedTabIds = targets.filter((target) => target.attached && target.tabId !== undefined && owners.get(target.tabId)?.has(lane.port)).map((target) => target.tabId);
  const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
  return {
    t: "hello",
    userAgent: navigator.userAgent,
    browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
    tabs: snapshots,
    attachedTabIds
  };
}
// A tab Memory Saver discarded has no page to debug; reload it first.
async function wake(tabId) {
  if (!(await chrome.tabs.get(tabId)).discarded)
    return;
  await chrome.tabs.reload(tabId);
  for (let i = 0; i < 50 && (await chrome.tabs.get(tabId)).status !== "complete"; i++)
    await new Promise((resolve) => setTimeout(resolve, 200));
}
async function attachFor(lane, tabId) {
  const set = owners.get(tabId);
  if (set?.size) {
    set.add(lane.port);
    return;
  }
  await wake(tabId);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    // ponytail: after a service-worker restart owners is empty but Chrome may still
    // hold our attachment; adopt it. Ceiling: also adopts a DevTools/other-extension
    // attach, whose commands then fail on send instead of here.
    if (!String(err?.message ?? err).includes("already attached"))
      throw err;
  }
  owners.set(tabId, new Set([lane.port]));
}
async function detachFor(port, tabId) {
  const set = owners.get(tabId);
  if (!set?.delete(port) || set.size > 0)
    return;
  owners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
async function runRpc(lane, msg) {
  switch (msg.op) {
    case "attach":
      await attachFor(lane, msg.tabId);
      return {};
    case "detach":
      await detachFor(lane.port, msg.tabId);
      return {};
    case "send":
      // Agents work in the background: never let one pull the user's view to its tab.
      if (msg.method === "Page.bringToFront")
        return {};
      // Chrome can drop the debugger on its own (renderer swap, worker restart); attach again instead of failing.
      if (!owners.get(msg.tabId)?.has(lane.port))
        await attachFor(lane, msg.tabId);
      return await chrome.debugger.sendCommand(msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId }, msg.method, msg.params);
    case "createTab": {
      const creating = (async () => {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        const snap = await withTargetId(snapshot(tab));
        if (!snap)
          throw new Error("created tab has no id");
        claim(lane, snap.tabId);
        createdTabs.set(snap.tabId, lane.port);
        saveTabState();
        return { tab: snap };
      })();
      inflightCreates.add(creating);
      try {
        return await creating;
      } finally {
        inflightCreates.delete(creating);
      }
    }
    case "removeTab":
      await chrome.tabs.remove(msg.tabId);
      return {};
    case "activateTab":
      // ponytail: agents never switch the user's active tab or window focus. If a
      // "let agents bring tabs to front" option is ever wanted, gate this on a setting.
      return {};
    case "group": {
      const mine = msg.tabIds.filter((tabId) => claim(lane, tabId));
      const look = laneLook(lane.port);
      return await enqueueGroupOp(() => groupTabs(mine, look.title, look.color));
    }
    case "ungroup": {
      const mine = msg.tabIds.filter((tabId) => claims.get(tabId) === lane.port);
      await enqueueGroupOp(() => chrome.tabs.ungroup(mine).catch(() => {}));
      await Promise.all(mine.map(release));
      return {};
    }
  }
}
// Agents' new tabs fire tabs.onCreated before createTab has claimed them; other
// lanes must not see them in that gap.
var inflightCreates = new Set();
function handleRelayMessage(lane, msg) {
  if (!lane || !msg || msg.t !== "rpc")
    return;
  runRpc(lane, msg).then((result) => post(lane, { t: "rpcResult", id: msg.id, ok: true, result })).catch((err) => {
    post(lane, { t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  });
}
// The app opened this port's relay: say hello (the tabs this port may see).
function laneOpened(port) {
  // A port claimed a moment ago can open before storage.onChanged has added its lane.
  if (!lanes.has(port))
    lanes.set(port, { port, open: false });
  const lane = lanes.get(port);
  lane.open = true;
  refreshStatus();
  sendHello(lane);
}
function sendHello(lane) {
  buildHello(lane).then((hello) => post(lane, hello)).catch(() => {
    setTimeout(() => lane.open && sendHello(lane), 1000);
  });
}
function lanesClosed() {
  for (const lane of lanes.values())
    lane.open = false;
  refreshStatus();
}
async function dropLane(lane) {
  lanes.delete(lane.port);
  const mine = claimedBy(lane.port);
  if (mine.length)
    await enqueueGroupOp(() => chrome.tabs.ungroup(mine).catch(() => {}));
  await Promise.all(mine.map(release));
  for (const tabId of [...owners.keys()])
    await detachFor(lane.port, tabId);
}
async function applySettings() {
  const next = await loadSettings();
  // A visibility change only needs a fresh tab list per relay, never a disconnect.
  const visibilityChanged = next.shareTabs !== settings.shareTabs;
  settings = next;
  for (const lane of [...lanes.values()]) {
    if (!settings.ports.includes(lane.port))
      await dropLane(lane);
    else if (visibilityChanged && lane.open)
      sendHello(lane);
  }
  for (const port of settings.ports) {
    if (!lanes.has(port))
      lanes.set(port, { port, open: false });
  }
  refreshStatus();
  restyleGroups();
  pushPortsToHub();
}
importScripts("hub-client.js");
var ready = null;
function start() {
  ready ??= loadTabState().then(applySettings);
  return ready.then(connectHub);
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined)
    postToOwners(source.tabId, { t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined)
    return;
  postToOwners(source.tabId, { t: "detached", tabId: source.tabId, reason });
  owners.delete(source.tabId);
});
chrome.tabs.onCreated.addListener(async (tab) => {
  await Promise.allSettled([...inflightCreates]);
  const snap = await withTargetId(snapshot(tab));
  if (snap)
    postVisible(snap.tabId, { t: "tabCreated", tab: snap });
});
chrome.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
  const snap = await withTargetId(snapshot(tab));
  if (snap)
    postVisible(snap.tabId, { t: "tabUpdated", tab: snap });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  broadcast({ t: "tabRemoved", tabId });
  owners.delete(tabId);
  targetIds.delete(tabId);
  createdTabs.delete(tabId);
  if (claims.delete(tabId))
    refreshStatus();
  saveTabState();
});
chrome.alarms.create("amtu-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "amtu-keepalive")
    start();
});
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local")
    ready = applySettings();
});
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install")
    chrome.tabs.create({ url: "welcome.html" });
  start();
});
chrome.runtime.onStartup.addListener(() => void start());
start();
