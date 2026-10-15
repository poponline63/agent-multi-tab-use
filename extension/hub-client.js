// Link to the local hub (agent-hub.js). Agents call the hub's HTTP API; the hub
// forwards each call here so claims, groups and ports live in the same storage
// the extension page edits. Ops run one at a time so two agents can't grab the
// same port.
var HUB_URL = "ws://127.0.0.1:9223/ext";
var TAKE_CONFIRM_MS = 5 * 60 * 1000;
var hub = { ws: null, delay: 1000 };
var hubQueue = Promise.resolve();
var pendingTakes = new Map();

function hubSend(msg) {
  if (hub.ws?.readyState === WebSocket.OPEN)
    hub.ws.send(JSON.stringify(msg));
}
function pushPortsToHub() {
  hubSend({ t: "ports", ports: settings.ports, token: settings.token, extVersion: chrome.runtime?.getManifest?.().version });
}
async function readAll() {
  const [base, { leases }] = await Promise.all([loadSettings(), chrome.storage.local.get({ leases: {} })]);
  return { ...base, leases: leases && typeof leases === "object" ? leases : {} };
}
function findGroup(groups, name) {
  const key = String(name ?? "").trim().toLowerCase();
  return groups.find((g) => g.name.toLowerCase() === key);
}
// Lookup for delete/take: the full title ("Hermes › Research"), or a sub group's short name when it's
// unambiguous (or narrowed by "parent").
function findGroupLoose(groups, name, parent) {
  const exact = findGroup(groups, parent ? parent + SUB_SEPARATOR + name : name);
  if (exact)
    return exact;
  const key = String(name ?? "").trim().toLowerCase();
  const matches = groups.filter((g) => g.parent && g.name.slice(g.parent.length + SUB_SEPARATOR.length).toLowerCase() === key);
  if (matches.length === 1)
    return matches[0];
  if (matches.length > 1)
    throw new Error(`"${name}" matches several sub groups (${matches.map((g) => g.name).join(", ")}); send the full name or add "parent"`);
  throw new Error(`no group named ${name}`);
}
function groupOfPort(s, port) {
  return s.groups.find((g) => g.ports.includes(port)) ?? null;
}
function nextColor(groups) {
  const used = new Set(groups.map((g) => g.color));
  return COLORS.find((c) => !used.has(c)) ?? "blue";
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
// Sub groups: Chrome can't nest tab groups, so a sub group is its own group
// titled "Parent › Name" that remembers its parent and defaults to its color.
var SUB_SEPARATOR = " › ";
function upsertGroup(s, name, color, parent) {
  let short = String(name ?? "").trim();
  if (!short)
    throw new Error("group name required");
  let parentGroup = null;
  if (String(parent ?? "").trim()) {
    parentGroup = upsertGroup(s, parent);
    if (parentGroup.parent)
      throw new Error(`"${parentGroup.name}" is already a sub group; sub groups can't have their own sub groups`);
    if (short.toLowerCase().startsWith((parentGroup.name + SUB_SEPARATOR).toLowerCase()))
      short = short.slice(parentGroup.name.length + SUB_SEPARATOR.length);
  }
  const fullName = parentGroup ? parentGroup.name + SUB_SEPARATOR + short : short;
  let group = findGroup(s.groups, fullName);
  if (!group) {
    group = { id: crypto.randomUUID(), name: fullName, color: parentGroup?.color ?? nextColor(s.groups), ports: [] };
    if (parentGroup)
      group.parent = parentGroup.name;
    s.groups.push(group);
  }
  if (COLORS.includes(color))
    group.color = color;
  return group;
}
function moveInto(s, group, port) {
  for (const g of s.groups)
    g.ports = g.ports.filter((p) => p !== port);
  group?.ports.push(port);
}
// Ports belong to their group. Moving one out of another group goes through
// /take, which needs the user's confirmation; held ports never move.
function guardMove(s, group, port, agent) {
  const owner = groupOfPort(s, port);
  if (owner && owner !== group)
    throw new Error(`port ${port} belongs to group "${owner.name}". To pull ports from another group use POST /take (the user must confirm).`);
  const holder = s.leases[port];
  if (holder && holder !== agent)
    throw new Error(`port ${port} is held by ${holder}`);
}
// Two-step confirmation for anything that reduces the user's control: the
// first call returns a token, the agent must show the user the message and
// only repeat the call with the token after they say yes.
function issueConfirm(key) {
  const token = crypto.randomUUID().slice(0, 8);
  pendingTakes.set(token, { key, expires: Date.now() + TAKE_CONFIRM_MS });
  return token;
}
function redeemConfirm(confirm, key) {
  const entry = confirm && pendingTakes.get(confirm);
  if (!entry || entry.key !== key || entry.expires < Date.now()) {
    if (confirm)
      throw new Error("confirmation token is invalid or expired; send the request again without it and ask the user");
    return false;
  }
  pendingTakes.delete(confirm);
  return true;
}
function save(s) {
  return chrome.storage.local.set({ ports: s.ports, groups: s.groups, leases: s.leases });
}

var hubOps = {
  async status() {
    const s = await readAll();
    const { laneStatus = [] } = await chrome.storage.session.get("laneStatus").catch(() => ({}));
    const live = new Map(laneStatus.map((l) => [l.port, l]));
    return {
      ports: s.ports.map((port) => ({
        port,
        cdpUrl: `http://127.0.0.1:${port}`,
        group: groupOfPort(s, port)?.name ?? null,
        agent: s.leases[port] ?? null,
        live: !!live.get(port)?.open,
        tabs: live.get(port)?.tabs ?? 0
      })),
      groups: s.groups.map(({ name, color, ports, parent }) => ({ name, color, ports, parent: parent ?? null })),
      shareTabs: s.shareTabs === true,
      closeTabsOnRelease: (await chrome.storage.local.get({ closeTabsOnRelease: false })).closeTabsOnRelease === true
    };
  },
  // Picks, in order: ports this agent already holds (so an agent that
  // reconnects gets its same ports back), an idle port in the agent's group, an
  // idle ungrouped port, then a brand-new port. count > 1 claims several.
  async claim({ agent = "agent", group, parent, color, port, count = 1, avoid = [] } = {}) {
    const s = await readAll();
    agent = String(agent).slice(0, 60);
    const n = Math.max(1, Math.min(Math.floor(Number(count)) || 1, MAX_PORTS));
    const g = group ? upsertGroup(s, group, color, parent) : null;
    const idle = (p) => !s.leases[p] && !avoid.includes(p);
    const picks = [];
    if (port !== undefined) {
      const want = Number(port);
      if (!validPort(want) || want === 9223 || avoid.includes(want))
        throw new Error(`port ${port} can't be used (invalid, the hub's own port, or used by another app)`);
      guardMove(s, g ?? groupOfPort(s, want), want, agent);
      if (!g && groupOfPort(s, want))
        throw new Error(`port ${want} belongs to group "${groupOfPort(s, want).name}"; claim with that group`);
      if (!s.ports.includes(want))
        s.ports.push(want);
      picks.push(want);
    } else {
      while (picks.length < n) {
        const held = s.ports.find((p) => s.leases[p] === agent && !picks.includes(p) && !avoid.includes(p) && (!g || !groupOfPort(s, p) || groupOfPort(s, p) === g));
        if (held !== undefined) {
          picks.push(held);
          continue;
        }
        const mine = g?.ports.find((p) => idle(p) && !picks.includes(p) && s.ports.includes(p));
        const loose = s.ports.find((p) => idle(p) && !picks.includes(p) && !groupOfPort(s, p));
        picks.push(mine ?? loose ?? nextPort(s, avoid));
      }
    }
    for (const p of picks) {
      if (g)
        moveInto(s, g, p);
      s.leases[p] = agent;
    }
    await save(s);
    const claimed = picks.map((p) => ({ port: p, cdpUrl: `http://127.0.0.1:${p}` }));
    const groupName = g?.name ?? null;
    if (n === 1 || port !== undefined)
      return { ...claimed[0], group: groupName ?? `Port ${picks[0]}`, agent };
    return { agent, group: groupName, claimed };
  },
  // Releasing a port leaves the agent's tabs open by default. The user's
  // "closeTabsOnRelease" setting turns auto-close on; an agent can always ask
  // either way ("closeTabs": true / "keepTabs": true), e.g. because the user
  // told it to. Tabs it adopted from the user are always handed back open.
  async release({ port, ports, agent, all, keepTabs, closeTabs } = {}) {
    const s = await readAll();
    if (all && !agent)
      throw new Error('"all" needs "agent" (whose ports to release)');
    const list = all
      ? Object.keys(s.leases).map(Number).filter((p) => s.leases[p] === agent)
      : (Array.isArray(ports) ? ports : [port]).map(Number);
    for (const p of list) {
      const holder = s.leases[p];
      if (holder && agent && holder !== agent)
        throw new Error(`port ${p} is held by ${holder}, not ${agent}`);
    }
    for (const p of list)
      delete s.leases[p];
    await save(s);
    const { closeTabsOnRelease = false } = await chrome.storage.local.get({ closeTabsOnRelease: false });
    const close = keepTabs === true ? false : closeTabs === true ? true : closeTabsOnRelease === true;
    const closing = !close || typeof claims === "undefined" ? [] : [...claims].filter(([tabId, owner]) => list.includes(owner) && createdTabs.get(tabId) === owner).map(([tabId]) => tabId);
    let closedCount = 0;
    if (closing.length)
      // One at a time: chrome.tabs.remove([...]) closes nothing if any id is already gone.
      closedCount = (await Promise.all(closing.map((id) => chrome.tabs.remove(id).then(() => 1, () => 0)))).reduce((a, b) => a + b, 0);
    return { released: list, closedTabs: closedCount };
  },
  // Two-step on purpose: the first call only describes the move and returns a
  // token; the agent must ask the user and repeat the call with that token.
  async take({ agent = "agent", from, to, count, ports, confirm } = {}) {
    const s = await readAll();
    const source = findGroupLoose(s.groups, from);
    if (!String(to ?? "").trim())
      throw new Error(`"to" (the group receiving the ports) is required`);
    if (findGroup(s.groups, to) === source)
      throw new Error("from and to are the same group");
    const idle = source.ports.filter((p) => !s.leases[p]);
    let moving;
    if (Array.isArray(ports) && ports.length) {
      moving = ports.map(Number);
      const bad = moving.filter((p) => !source.ports.includes(p));
      if (bad.length)
        throw new Error(`port(s) ${bad.join(", ")} are not in "${source.name}"`);
      const busy = moving.filter((p) => s.leases[p]);
      if (busy.length)
        throw new Error(`port(s) ${busy.join(", ")} are in use by ${busy.map((p) => s.leases[p]).join(", ")} and can't be pulled`);
    } else {
      const n = Math.max(1, Math.floor(Number(count)) || 1);
      if (idle.length < n)
        throw new Error(`"${source.name}" has only ${idle.length} idle port(s); the rest are in use`);
      moving = idle.sort((a, b) => b - a).slice(0, n).sort((a, b) => a - b);
    }
    const key = JSON.stringify([source.name, String(to).trim().toLowerCase(), moving]);
    const summary = `pull ${moving.length} port${moving.length === 1 ? "" : "s"} (${moving.join(", ")}) out of the "${source.name}" group for "${String(to).trim()}"`;
    if (!redeemConfirm(confirm, key)) {
      const newToken = issueConfirm(key);
      return {
        confirmRequired: true,
        message: `Confirm you want to ${summary}. Ask the user. Only if they say yes, repeat this exact request with "confirm":"${newToken}" (valid 5 minutes).`,
        confirmToken: newToken,
        ports: moving
      };
    }
    const target = upsertGroup(s, to);
    for (const p of moving)
      moveInto(s, target, p);
    await save(s);
    return { moved: moving, from: source.name, to: target.name, message: `Done: moved ${moving.join(", ")} from "${source.name}" to "${target.name}".`, by: agent };
  },
  // Turning sharing off is always allowed at once; turning it on exposes the
  // user's own tabs, so it needs their confirmation.
  async settings({ shareTabs, closeTabsOnRelease, confirm } = {}) {
    if (typeof closeTabsOnRelease === "boolean") {
      await chrome.storage.local.set({ closeTabsOnRelease });
      if (typeof shareTabs !== "boolean")
        return { closeTabsOnRelease, message: closeTabsOnRelease ? "Done: releasing a port now closes the tabs the agent opened." : "Done: releasing a port now leaves the agent's tabs open." };
    }
    if (typeof shareTabs !== "boolean")
      throw new Error('send "shareTabs": true/false and/or "closeTabsOnRelease": true/false');
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
  async group({ name, parent, color, ports, agent } = {}) {
    const s = await readAll();
    const g = upsertGroup(s, name, color, parent);
    const wanted = Array.isArray(ports) ? ports.map(Number).filter(validPort) : [];
    for (const p of wanted)
      guardMove(s, g, p, agent);
    for (const p of wanted) {
      if (!s.ports.includes(p))
        s.ports.push(p);
      moveInto(s, g, p);
    }
    await save(s);
    return { name: g.name, parent: g.parent ?? null, color: g.color, ports: g.ports };
  },
  async deleteGroup({ name, parent } = {}) {
    const s = await readAll();
    const g = findGroupLoose(s.groups, name, parent);
    // Deleting a group also deletes its sub groups; their ports stay, ungrouped.
    s.groups = s.groups.filter((x) => x !== g && x.parent !== g.name);
    await save(s);
    return { deleted: g.name };
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
    // The app starts the relays when it gets the port list; give it a moment, then dial them.
    setTimeout(() => {
      for (const lane of lanes.values()) {
        lane.delay = 1000;
        connect(lane);
      }
    }, 500);
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
      if (msg.t === "foreign")
        chrome.storage.session.set({ foreignPorts: msg.ports }).catch(() => {});
      if (msg.t === "hello")
        chrome.storage.session.set({ appVersion: msg.version }).catch(() => {});
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
    chrome.storage.session.set({ hubOnline: false }).catch(() => {});
    // ponytail: while the app is down this is the only connection retrying; a 5s cap
    // means Chrome links up within seconds of the app starting (one log line per retry).
    const delay = hub.delay;
    hub.delay = Math.min(hub.delay * 2, 5000);
    setTimeout(connectHub, delay);
  };
  socket.onerror = () => socket.close();
}
