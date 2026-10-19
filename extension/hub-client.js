// Link to the companion app. Agents call the app's HTTP API; the app forwards
// each call here so ports and leases live in the same storage the extension
// page reads. Ops run one at a time so two agents can't grab the same port.
// The same socket carries every port's relay traffic ({t:"lane", port, msg}).
//
// Model: ports are one shared pool. A lease ({agent, group, since}) says who
// holds a port and which Chrome tab group its tabs go in; a released port goes
// back to the pool. Groups aren't configured anywhere: the name an agent claims
// with is the group, and groupColors only remembers each name's color.
var HUB_URL = "ws://127.0.0.1:9223/ext";
var hub = { ws: null, delay: 1000 };
var hubQueue = Promise.resolve();
var DEFAULT_GROUP = "Agents";
var POOL_FLOOR = 10;
var POOL_SPARE = 3;
// Sub groups: Chrome can't nest tab groups, so a sub group is its own group titled "Parent › Name".
var SUB_SEPARATOR = " › ";

function hubSend(msg) {
  if (hub.ws?.readyState === WebSocket.OPEN)
    hub.ws.send(JSON.stringify(msg));
}
function pushPortsToHub() {
  hubSend({ t: "ports", ports: settings.ports, extVersion: chrome.runtime?.getManifest?.().version });
}
function readAll() {
  return loadSettings();
}
function save(s) {
  return chrome.storage.local.set({ ports: s.ports, leases: s.leases, groupColors: s.groupColors });
}
function findGroupName(s, name) {
  const key = String(name ?? "").trim().toLowerCase();
  return Object.keys(s.groupColors).find((n) => n.toLowerCase() === key);
}
function nextColor(s) {
  const used = new Set(Object.values(s.groupColors));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[Object.keys(s.groupColors).length % COLORS.length];
}
// The tab-group title for a claim, remembering its color (sub groups start in their parent's).
function groupTitle(s, group, parent, color) {
  let short = String(group ?? "").trim();
  if (!short)
    throw new Error("group name required");
  const parentName = String(parent ?? "").trim() ? findGroupName(s, parent) ?? String(parent).trim() : null;
  if (parentName?.includes(SUB_SEPARATOR))
    throw new Error(`"${parentName}" is already a sub group; sub groups can't have their own sub groups`);
  if (parentName && short.toLowerCase().startsWith((parentName + SUB_SEPARATOR).toLowerCase()))
    short = short.slice(parentName.length + SUB_SEPARATOR.length);
  const full = parentName ? parentName + SUB_SEPARATOR + short : short;
  const name = findGroupName(s, full) ?? full;
  if (COLORS.includes(color))
    s.groupColors[name] = color;
  else if (!s.groupColors[name])
    s.groupColors[name] = (parentName && s.groupColors[findGroupName(s, parentName) ?? ""]) || nextColor(s);
  return name;
}
function nextPort(s, avoid) {
  let port = Math.max(9223, ...s.ports) + 1;
  while (avoid.includes(port) || s.ports.includes(port))
    port++;
  if (port > 65535 || s.ports.length >= MAX_PORTS)
    throw new Error(`port limit (${MAX_PORTS}) reached`);
  s.ports.push(port);
  return port;
}
// Free ports beyond a small spare pool are removed again, highest first, so the
// list shrinks back after a busy spell instead of only ever growing.
function trimPool(s) {
  const free = s.ports.filter((p) => !s.leases[p]).sort((a, b) => b - a);
  let removable = Math.min(free.length - POOL_SPARE, s.ports.length - POOL_FLOOR);
  for (const port of free) {
    if (removable-- <= 0)
      break;
    s.ports = s.ports.filter((p) => p !== port);
  }
}

var hubOps = {
  async status() {
    const s = await readAll();
    const { laneStatus = [] } = await chrome.storage.session.get("laneStatus").catch(() => ({}));
    const live = new Map(laneStatus.map((l) => [l.port, l]));
    const ports = s.ports.map((port) => ({
      port,
      cdpUrl: `http://127.0.0.1:${port}`,
      group: s.leases[port]?.group ?? null,
      agent: s.leases[port]?.agent ?? null,
      since: s.leases[port]?.since ?? null,
      live: !!live.get(port)?.open,
      tabs: live.get(port)?.tabs ?? 0
    }));
    const groups = [...new Set(ports.map((p) => p.group).filter(Boolean))].map((name) => ({
      name,
      color: s.groupColors[name] ?? null,
      ports: ports.filter((p) => p.group === name).map((p) => p.port)
    }));
    return { ports, groups, shareTabs: s.shareTabs === true };
  },
  // Picks, in order: ports this agent already holds (so an agent that comes back
  // gets the same ports), the lowest free port, then a new port. count > 1 claims several.
  async claim({ agent = "agent", group, parent, color, port, count = 1, avoid = [] } = {}) {
    const s = await readAll();
    trimPool(s);
    agent = String(agent).slice(0, 60);
    const n = Math.max(1, Math.min(Math.floor(Number(count)) || 1, MAX_PORTS));
    const title = group || parent ? groupTitle(s, group || parent, group ? parent : null, color) : null;
    const free = (p) => !s.leases[p] && !avoid.includes(p);
    const picks = [];
    if (port !== undefined) {
      const want = Number(port);
      if (!validPort(want) || want === 9223 || avoid.includes(want))
        throw new Error(`port ${port} can't be used (invalid, the hub's own port, or used by another app)`);
      if (s.leases[want] && s.leases[want].agent !== agent)
        throw new Error(`port ${want} is held by ${s.leases[want].agent}`);
      if (!s.ports.includes(want))
        s.ports.push(want);
      picks.push(want);
    } else {
      const pool = [...s.ports].sort((a, b) => a - b);
      while (picks.length < n) {
        const held = pool.find((p) => s.leases[p]?.agent === agent && !picks.includes(p) && !avoid.includes(p));
        picks.push(held ?? pool.find((p) => free(p) && !picks.includes(p)) ?? nextPort(s, avoid));
      }
    }
    for (const p of picks) {
      const group2 = title ?? s.leases[p]?.group ?? groupTitle(s, DEFAULT_GROUP);
      s.leases[p] = { agent, group: group2, since: s.leases[p]?.agent === agent ? s.leases[p].since : Date.now() };
    }
    await save(s);
    const claimed = picks.map((p) => ({ port: p, cdpUrl: `http://127.0.0.1:${p}` }));
    if (n === 1 || port !== undefined)
      return { ...claimed[0], group: s.leases[picks[0]].group, agent };
    return { agent, group: s.leases[picks[0]].group, claimed };
  },
  // Release tidies up: tabs the agent opened close, except ones the user has
  // looked at (those, and tabs it adopted, are handed back open). "keepTabs":true
  // keeps them all; "closeTabs":true closes them even if the user looked.
  async release({ port, ports, agent, all, keepTabs, closeTabs } = {}) {
    const s = await readAll();
    if (all && !agent)
      throw new Error('"all" needs "agent" (whose ports to release)');
    const list = all
      ? Object.keys(s.leases).map(Number).filter((p) => s.leases[p].agent === agent)
      : (Array.isArray(ports) ? ports : [port]).map(Number);
    for (const p of list) {
      const holder = s.leases[p]?.agent;
      if (holder && holder !== agent)
        throw new Error(agent ? `port ${p} is held by ${holder}, not ${agent}` : `port ${p} is held by ${holder}; send "agent":"${holder}" to release it`);
    }
    for (const p of list)
      delete s.leases[p];
    trimPool(s);
    await save(s);
    const closing = keepTabs === true || typeof claims === "undefined"
      ? []
      : [...claims].filter(([tabId, owner]) => list.includes(owner) && createdTabs.get(tabId) === owner && (closeTabs === true || !seenTabs.has(tabId))).map(([tabId]) => tabId);
    // One at a time: chrome.tabs.remove([...]) closes nothing if any id is already gone.
    const closedTabs = (await Promise.all(closing.map((id) => chrome.tabs.remove(id).then(() => 1, () => 0)))).reduce((a, b) => a + b, 0);
    // Tabs left open go back to the user; still claimed, they'd show up for the port's next agent.
    for (const p of list)
      await releasePortTabs(p);
    return { released: list, closedTabs };
  },
  // Turning sharing off is always allowed at once; turning it on exposes the
  // user's own tabs, so it needs their confirmation.
  async settings({ shareTabs, closeTabsOnRelease, confirm } = {}) {
    if (typeof shareTabs !== "boolean") {
      if (typeof closeTabsOnRelease === "boolean")
        return { message: 'Nothing to set: release now always closes the tabs you opened unless the user looked at them. Pass "keepTabs":true or "closeTabs":true on /release to override.' };
      throw new Error('send "shareTabs": true/false');
    }
    if (!shareTabs) {
      await chrome.storage.local.set({ shareTabs: false });
      return { shareTabs: false, message: "Done: agents now only see tabs they opened." };
    }
    const key = JSON.stringify(["shareTabs", true]);
    if (!redeemConfirm(confirm, key)) {
      const token = issueConfirm(key);
      return {
        confirmRequired: true,
        message: `Confirm you want to let every agent see and use the tabs you opened yourself (your email, accounts, anything you have open). Ask the user. Only if they say yes, repeat this exact request with "confirm":"${token}" (valid 5 minutes).`,
        confirmToken: token
      };
    }
    await chrome.storage.local.set({ shareTabs: true });
    return { shareTabs: true, message: "Done: agents can now see your own tabs. Turn it off anytime with shareTabs:false or in the extension." };
  },
  async group({ name, parent, color } = {}) {
    const s = await readAll();
    const title = groupTitle(s, name, parent, color);
    await save(s);
    return { name: title, color: s.groupColors[title] };
  },
  async deleteGroup({ name } = {}) {
    const s = await readAll();
    const title = findGroupName(s, name);
    if (!title)
      throw new Error(`no group named ${name}`);
    for (const key of Object.keys(s.groupColors)) {
      if (key === title || key.startsWith(title + SUB_SEPARATOR))
        delete s.groupColors[key];
    }
    await save(s);
    return { deleted: title };
  },
  async addPorts({ add = 1, avoid = [] } = {}) {
    const s = await readAll();
    const n = Math.max(1, Math.min(Math.floor(Number(add)) || 1, MAX_PORTS - s.ports.length));
    const added = [];
    while (added.length < n)
      added.push(nextPort(s, avoid));
    await save(s);
    return { added };
  }
};

// Two-step confirmation for anything that reduces the user's privacy: the first
// call returns a token; the agent must show the user the message and only repeat
// the call with the token after they say yes.
var CONFIRM_MS = 5 * 60 * 1000;
var pendingConfirms = new Map();
function issueConfirm(key) {
  const token = crypto.randomUUID().slice(0, 8);
  pendingConfirms.set(token, { key, expires: Date.now() + CONFIRM_MS });
  return token;
}
function redeemConfirm(confirm, key) {
  const entry = confirm && pendingConfirms.get(confirm);
  if (!entry || entry.key !== key || entry.expires < Date.now()) {
    if (confirm)
      throw new Error("confirmation token is invalid or expired; send the request again without it and ask the user");
    return false;
  }
  pendingConfirms.delete(confirm);
  return true;
}

function connectHub() {
  if (hub.ws && (hub.ws.readyState === WebSocket.OPEN || hub.ws.readyState === WebSocket.CONNECTING))
    return;
  const socket = new WebSocket(HUB_URL);
  hub.ws = socket;
  socket.onopen = () => {
    hub.delay = 1000;
    clearInterval(hub.ping ?? undefined);
    hub.ping = setInterval(() => hubSend({ t: "ping" }), 20000);
    pushPortsToHub();
    chrome.storage.session.set({ hubOnline: true }).catch(() => {});
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.t) {
      if (msg.t === "lane")
        handleRelayMessage(lanes.get(msg.port), msg.msg);
      if (msg.t === "laneOpen")
        laneOpened(msg.port);
      if (msg.t === "foreign")
        chrome.storage.session.set({ foreignPorts: msg.ports }).catch(() => {});
      if (msg.t === "hello")
        chrome.storage.session.set({ appVersion: msg.version }).catch(() => {});
      // The app was updated along with the extension's files: load the new files.
      if (msg.t === "reload")
        chrome.runtime.reload();
      return;
    }
    const op = hubOps[msg.op];
    hubQueue = hubQueue.then(async () => {
      try {
        if (!op)
          throw new Error(`unknown op ${msg.op}`);
        hubSend({ id: msg.id, ok: true, result: await op(msg.args) });
      } catch (err) {
        hubSend({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };
  socket.onclose = () => {
    if (hub.ws !== socket)
      return;
    hub.ws = null;
    clearInterval(hub.ping ?? undefined);
    lanesClosed();
    chrome.storage.session.set({ hubOnline: false }).catch(() => {});
    // ponytail: while the app is down this is the only connection retrying; a 5s cap
    // means Chrome links up within seconds of the app starting (one log line per retry).
    const delay = hub.delay;
    hub.delay = Math.min(hub.delay * 2, 5000);
    setTimeout(connectHub, delay);
  };
  socket.onerror = () => socket.close();
}
