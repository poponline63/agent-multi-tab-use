const MAX_PORTS = 250;
const DEFAULTS = { ports: Array.from({ length: 10 }, (_, i) => 9224 + i), groups: [], leases: {}, shareTabs: false, closeTabsOnRelease: false };
const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
const $ = (id) => document.getElementById(id);

let settings = DEFAULTS;
let status = new Map();
let foreign = new Set();
const selected = new Set();

function el(tag, props = {}, ...children) {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}
function icon(path) {
	const wrap = document.createElement("span");
	wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
	return wrap.firstChild;
}
function toast(text) {
	const t = $("toast");
	t.textContent = text;
	t.classList.add("show");
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => t.classList.remove("show"), 1600);
}
function save(patch) {
	settings = { ...settings, ...patch };
	return chrome.storage.local.set(patch);
}
function groupOf(port) {
	return settings.groups.find((g) => g.ports.includes(port));
}
function portColor(port) {
	return groupOf(port)?.color ?? COLORS[settings.ports.indexOf(port) % COLORS.length];
}
function ranges(ports) {
	const sorted = [...ports].sort((a, b) => a - b);
	const out = [];
	for (let i = 0; i < sorted.length; i++) {
		let j = i;
		while (sorted[j + 1] === sorted[j] + 1) j++;
		out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
		i = j;
	}
	return out.join(" ");
}

const SUB_SEPARATOR = " › ";

// Parents first, each followed by its sub groups (Chrome can't nest groups, so
// a sub group is its own tab group titled "Parent › Name").
function orderedGroups() {
	const byParent = (name) => settings.groups.filter((g) => g.parent === name);
	const tops = settings.groups.filter((g) => !g.parent || !settings.groups.some((p) => p.name === g.parent));
	return tops.flatMap((g) => [g, ...byParent(g.name)]);
}

function renderGroups() {
	const cards = orderedGroups().map((group) => {
		const short = group.parent ? group.name.slice(group.parent.length + SUB_SEPARATOR.length) : group.name;
		const name = el("input", { className: "name", value: short, spellcheck: false, ariaLabel: "Group name" });
		name.addEventListener("change", () => {
			const next = name.value.trim() || "Tab Group";
			const oldName = group.name;
			group.name = group.parent ? group.parent + SUB_SEPARATOR + next : next;
			for (const child of settings.groups.filter((g) => g.parent === oldName)) {
				child.name = group.name + SUB_SEPARATOR + child.name.slice(oldName.length + SUB_SEPARATOR.length);
				child.parent = group.name;
			}
			save({ groups: settings.groups });
		});
		name.addEventListener("keydown", (e) => e.key === "Enter" && name.blur());
		const swatches = el(
			"div",
			{ className: "swatches" },
			...COLORS.map((color) => {
				const b = el("button", { className: "swatch", type: "button", title: color, ariaLabel: `${color} color` });
				b.style.setProperty("--s", `var(--${color})`);
				b.setAttribute("aria-pressed", String(group.color === color));
				b.addEventListener("click", () => {
					group.color = color;
					save({ groups: settings.groups });
				});
				return b;
			}),
		);
		const ports = [...group.ports].sort((a, b) => a - b);
		const chips = el("div", { className: "chips" }, ...(ports.length ? ports.map((p) => el("span", { textContent: p })) : [el("em", { textContent: "No ports yet" })]));
		const del = el("button", { className: "icon-btn", type: "button", title: "Delete group", ariaLabel: "Delete group" }, icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'));
		del.addEventListener("click", () => save({ groups: settings.groups.filter((g) => g !== group && g.parent !== group.name) }));
		const actions = el("div", { className: "group-actions" }, del);
		if (!group.parent) {
			const sub = el("button", { className: "sub-btn", type: "button", textContent: "+ Sub group", title: `Add a sub group inside ${group.name}` });
			sub.addEventListener("click", () => {
				const count = settings.groups.filter((g) => g.parent === group.name).length + 1;
				save({ groups: [...settings.groups, { id: crypto.randomUUID(), name: `${group.name}${SUB_SEPARATOR}Sub group ${count}`, parent: group.name, color: group.color, ports: [] }] });
			});
			actions.prepend(sub);
		}
		const label = group.parent ? el("div", { className: "sub-of", textContent: `Sub group of ${group.parent}` }) : "";
		const card = el("div", { className: `group${group.parent ? " sub" : ""}` }, label, name, swatches, el("div", { className: "foot" }, chips, actions));
		card.style.setProperty("--c", `var(--${group.color})`);
		return card;
	});
	const add = el("button", { className: "new-group", type: "button" }, el("span", { textContent: "+  New tab group" }));
	add.addEventListener("click", () => {
		const used = new Set(settings.groups.map((g) => g.color));
		const color = COLORS.find((c) => !used.has(c)) ?? "blue";
		save({ groups: [...settings.groups, { id: crypto.randomUUID(), name: `Tab Group ${settings.groups.length + 1}`, color, ports: [] }] });
	});
	$("groups").replaceChildren(...cards, add);

	const move = $("moveTo");
	move.replaceChildren(
		el("option", { value: "", textContent: "Move to group…", disabled: true, selected: true }),
		...orderedGroups().map((g) => el("option", { value: g.id, textContent: g.name })),
		el("option", { value: "none", textContent: "No group (own tab group)" }),
	);
}

function renderPorts() {
	const tiles = settings.ports.map((port, i) => {
		const lane = status.get(port);
		const group = groupOf(port);
		const copy = el("button", { className: "copy", type: "button", textContent: "Copy URL", title: `http://127.0.0.1:${port}` });
		copy.addEventListener("click", async (e) => {
			e.stopPropagation();
			await navigator.clipboard.writeText(`http://127.0.0.1:${port}`);
			toast(`Copied http://127.0.0.1:${port}`);
		});
		const tabs = lane?.tabs ?? 0;
		const holder = settings.leases[port];
		const taken = foreign.has(port);
		const tile = el(
			"div",
			{ className: `port${lane?.open ? " live" : ""}${taken ? " foreign" : ""}`, role: "button", tabIndex: 0 },
			el("div", { className: "num" }, `${port}`, el("span", { className: "dot", title: taken ? "Another app uses this port" : lane?.open ? "Relay connected" : "No relay on this port" })),
			el("div", { className: "tag" }, el("i"), taken ? "Used by another app" : group ? group.name : `Port ${port}`),
			el(
				"div",
				{ className: "meta" },
				el("span", { textContent: holder ? `${holder} · ${tabs}` : `${tabs} ${tabs === 1 ? "tab" : "tabs"}`, title: holder ? `Claimed by ${holder}` : "" }),
				copy,
			),
		);
		tile.setAttribute("aria-pressed", String(selected.has(port)));
		tile.style.setProperty("--c", `var(--${portColor(port)})`);
		tile.style.setProperty("--i", i);
		const toggle = () => {
			selected.has(port) ? selected.delete(port) : selected.add(port);
			tile.setAttribute("aria-pressed", String(selected.has(port)));
			renderSelection();
		};
		tile.addEventListener("click", toggle);
		tile.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle()));
		return tile;
	});
	$("ports").replaceChildren(...tiles);

	const live = settings.ports.filter((p) => status.get(p)?.open).length;
	$("live").textContent = live;
	$("total").textContent = settings.ports.length;
	$("claimed").textContent = settings.ports.reduce((sum, p) => sum + (status.get(p)?.tabs ?? 0), 0);
	$("add1").disabled = $("add10").disabled = settings.ports.length >= MAX_PORTS;
	renderSelection();
}


function renderPrompt() {
	const pick = $("promptFor");
	const current = pick.value;
	const options = [
		el("option", { value: "any", textContent: "Any agent (picks its own port and group)" }),
		...settings.groups.filter((g) => g.ports.length).map((g) => el("option", { value: `g:${g.id}`, textContent: `${g.name} (${ranges(g.ports)})` })),
		...settings.ports.filter((p) => !groupOf(p)).map((p) => el("option", { value: `p:${p}`, textContent: `Port ${p}` })),
	];
	pick.replaceChildren(...options);
	if (options.some((o) => o.value === current)) pick.value = current;
	const [kind, id] = pick.value.split(":");
	const group = kind === "g" ? settings.groups.find((g) => g.id === id) : null;
	const shareTabs = settings.shareTabs === true;
	$("prompt").textContent = group
		? buildAgentPrompt({ claimBody: { agent: "your-name", group: group.name }, groupName: group.name, fallbackPort: Math.min(...group.ports), shareTabs })
		: kind === "p"
			? buildAgentPrompt({ claimBody: { agent: "your-name", port: Number(id) }, groupName: `Port ${id}`, fallbackPort: Number(id), shareTabs })
			: buildAgentPrompt({ claimBody: { agent: "your-name", group: "Your Agent Tab Group" }, shareTabs });
}

function renderSelection() {
	for (const p of [...selected]) if (!settings.ports.includes(p)) selected.delete(p);
	$("selCount").textContent = selected.size;
	$("moveTo").disabled = $("remove").disabled = selected.size === 0;
	$("release").disabled = ![...selected].some((p) => settings.leases[p]);
	$("selectAll").textContent = selected.size === settings.ports.length && selected.size > 0 ? "Clear" : "Select all";
}

function addPorts(n) {
	const ports = [...settings.ports];
	let next = ports.length ? Math.max(...ports) + 1 : 9224;
	while (n-- > 0 && ports.length < MAX_PORTS && next <= 65535) ports.push(next++);
	save({ ports });
	toast(`${ports.length} ports`);
}

$("add1").addEventListener("click", () => addPorts(1));
$("add10").addEventListener("click", () => addPorts(10));
$("selectAll").addEventListener("click", () => {
	const all = selected.size !== settings.ports.length;
	selected.clear();
	if (all) settings.ports.forEach((p) => selected.add(p));
	renderPorts();
});
$("remove").addEventListener("click", () => {
	const gone = new Set(selected);
	selected.clear();
	save({
		ports: settings.ports.filter((p) => !gone.has(p)),
		groups: settings.groups.map((g) => ({ ...g, ports: g.ports.filter((p) => !gone.has(p)) })),
		leases: Object.fromEntries(Object.entries(settings.leases).filter(([p]) => !gone.has(Number(p)))),
	});
	toast(`Removed ${gone.size} ${gone.size === 1 ? "port" : "ports"}`);
});
$("release").addEventListener("click", () => {
	const freed = [...selected].filter((p) => settings.leases[p]);
	selected.clear();
	save({ leases: Object.fromEntries(Object.entries(settings.leases).filter(([p]) => !freed.includes(Number(p)))) });
	toast(`Released ${freed.join(", ")}`);
});
$("moveTo").addEventListener("change", (e) => {
	const target = e.target.value;
	const moving = [...selected];
	const groups = settings.groups.map((g) => {
		const ports = g.ports.filter((p) => !selected.has(p));
		return { ...g, ports: g.id === target ? [...ports, ...moving] : ports };
	});
	selected.clear();
	save({ groups });
	const name = settings.groups.find((g) => g.id === target)?.name;
	toast(name ? `Moved ${moving.length} to ${name}` : `Ungrouped ${moving.length}`);
});
$("download").href = DOWNLOAD_URL;
$("closeTabsOnRelease").addEventListener("change", (e) => {
	save({ closeTabsOnRelease: e.target.checked });
	toast(e.target.checked ? "Agents' tabs close when they're done" : "Agents' tabs stay open when they're done");
});
$("shareTabs").addEventListener("change", (e) => {
	save({ shareTabs: e.target.checked });
	toast(e.target.checked ? "Agents can now see your own tabs" : "Agents only see tabs they opened");
});
$("promptFor").addEventListener("change", renderPrompt);
$("copyPrompt").addEventListener("click", async () => {
	await navigator.clipboard.writeText($("prompt").textContent);
	toast("Agent instructions copied");
});

async function loadSettings() {
	settings = await chrome.storage.local.get(DEFAULTS);
	$("shareTabs").checked = settings.shareTabs === true;
	$("closeTabsOnRelease").checked = settings.closeTabsOnRelease === true;
	renderGroups();
	renderPorts();
	renderPrompt();
}
async function loadStatus() {
	const { laneStatus = [], hubOnline = false, foreignPorts = [], appVersion } = await chrome.storage.session
		.get(["laneStatus", "hubOnline", "foreignPorts", "appVersion"])
		.catch(() => ({}));
	status = new Map(laneStatus.map((lane) => [lane.port, lane]));
	foreign = new Set(foreignPorts);
	$("hub").className = hubOnline ? "on" : "off";
	$("hub").lastChild.textContent = hubOnline ? " online" : " offline";
	$("appCard").className = `card app-card ${hubOnline ? "online" : "offline"}`;
	$("appBanner").hidden = hubOnline;
	$("appTitle").textContent = hubOnline ? "Companion app is running" : "Companion app not detected";
	const extVersion = chrome.runtime.getManifest().version;
	const mismatch = hubOnline && appVersion && appVersion !== extVersion;
	$("appSub").textContent = hubOnline
		? `App ${appVersion ?? "?"} · Extension ${extVersion} · on 127.0.0.1:9223, starts with Windows.${mismatch ? " Versions differ: update whichever is older." : ""}`
		: `Extension ${extVersion}. Install the app, or open AgentMultiTabUse.exe if it's already installed. Agents can't connect until it runs.`;
	$("appSub").classList.toggle("warn", !!mismatch);
	renderPorts();
}

chrome.storage.onChanged.addListener((_changes, area) => {
	if (area === "local") loadSettings();
	else if (area === "session") loadStatus();
});
loadSettings()
	.then(loadStatus)
	.then(() => setTimeout(() => document.body.classList.add("settled"), 900));
