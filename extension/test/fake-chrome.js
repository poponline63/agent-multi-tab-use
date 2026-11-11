// A small in-memory Chrome (tabs, tab groups, storage) for testing background.js and
// hub-client.js without a browser. Only what the extension calls is modelled.
export function makeFakeChrome({ local = {} } = {}) {
	const store = { local: structuredClone(local), session: {} };
	const tabs = new Map();
	const groups = new Map();
	let nextTabId = 1;
	let nextGroupId = 100;
	const listeners = () => ({ fns: [], addListener(fn) { this.fns.push(fn); } });
	const hang = new Set(); // tab ids whose close never finishes (a "Leave site?" prompt)
	// Like Chrome 126+: a group whose last tab is closed is kept as a saved group (a chip
	// the user must delete by hand); a group emptied by ungrouping just goes away.
	const saved = [];
	const prune = (closing = false) => {
		for (const [id, g] of [...groups]) {
			if ([...tabs.values()].some((t) => t.groupId === id)) continue;
			if (closing && g.title) saved.push(g.title);
			groups.delete(id);
		}
	};
	const storageArea = (area) => ({
		get: async (keys) => {
			if (typeof keys === "string") return keys in store[area] ? { [keys]: structuredClone(store[area][keys]) } : {};
			if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store[area]).map((k) => [k, structuredClone(store[area][k])]));
			return { ...keys, ...Object.fromEntries(Object.keys(keys ?? {}).filter((k) => k in store[area]).map((k) => [k, structuredClone(store[area][k])])) };
		},
		set: async (patch) => void Object.assign(store[area], structuredClone(patch)),
		remove: async (keys) => [keys].flat().forEach((k) => delete store[area][k]),
	});
	const chrome = {
		runtime: { id: "test", getManifest: () => ({ version: "test" }), reload() {}, openOptionsPage() {}, onStartup: listeners(), onInstalled: listeners() },
		storage: { local: storageArea("local"), session: storageArea("session"), onChanged: listeners() },
		alarms: { create() {}, onAlarm: listeners() },
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: listeners() },
		scripting: { executeScript: async () => [] },
		webNavigation: { onCreatedNavigationTarget: listeners(), onCommitted: listeners() },
		debugger: { getTargets: async () => [], attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: listeners(), onDetach: listeners() },
		tabs: {
			onCreated: listeners(), onUpdated: listeners(), onRemoved: listeners(), onActivated: listeners(),
			create: async ({ url, active = false, windowId = 1 }) => {
				const tab = { id: nextTabId++, url, title: "", active, windowId, pinned: false, groupId: -1, discarded: false, status: "complete" };
				tabs.set(tab.id, tab);
				return { ...tab };
			},
			get: async (id) => {
				if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
				return { ...tabs.get(id) };
			},
			query: async (q = {}) => [...tabs.values()].filter((t) => (q.groupId === undefined || t.groupId === q.groupId) && (q.windowId === undefined || t.windowId === q.windowId)).map((t) => ({ ...t })),
			update: async (id) => ({ ...tabs.get(id) }),
			reload: async () => {},
			remove: (id) => {
				if (hang.has(id)) return new Promise(() => {});
				for (const i of [id].flat()) tabs.delete(i);
				prune(true);
				return Promise.resolve();
			},
			group: async ({ tabIds, groupId, createProperties }) => {
				const ids = [tabIds].flat();
				let gid = groupId;
				if (gid === undefined) {
					gid = nextGroupId++;
					groups.set(gid, { id: gid, title: "", color: "grey", windowId: createProperties?.windowId ?? tabs.get(ids[0]).windowId, collapsed: false });
				}
				if (!groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
				for (const id of ids) tabs.get(id).groupId = gid;
				prune();
				return gid;
			},
			ungroup: async (tabIds) => {
				for (const id of [tabIds].flat()) if (tabs.has(id)) tabs.get(id).groupId = -1;
				prune();
			},
		},
		tabGroups: {
			// Like Chrome, "title" is a pattern; the extension must not rely on it being exact.
			query: async (q = {}) => [...groups.values()].filter((g) => (q.windowId === undefined || g.windowId === q.windowId) && (q.title === undefined || g.title.includes(q.title.replace(/\*/g, "")))).map((g) => ({ ...g })),
			update: async (id, props) => Object.assign(groups.get(id), props),
			get: async (id) => ({ ...groups.get(id) }),
		},
	};
	return { chrome, store, tabs, groups, hang, saved };
}
