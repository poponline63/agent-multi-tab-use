// Tray icon for the companion app. The hub exe extracts and starts this, passing
// its own path, pid and API address; the icon lives exactly as long as the hub.
// Built by build.js with the csc.exe that ships with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Tray {
	static NotifyIcon icon;
	static ToolStripMenuItem statusItem;
	static string hubExe, hubUrl;
	static Mutex mutex;
	static Control ui;
	static bool restarting;

	[STAThread]
	static void Main(string[] args) {
		bool first;
		mutex = new Mutex(true, "AgentMultiTabUseTray", out first);
		if (!first || args.Length < 3) return;
		hubExe = args[0];
		hubUrl = args[2];
		Process hub;
		try { hub = Process.GetProcessById(int.Parse(args[1])); } catch { return; }

		Application.EnableVisualStyles();
		ui = new Control();
		ui.Handle.ToInt64(); // creates the window handle BeginInvoke needs
		var menu = new ContextMenuStrip();
		statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
		menu.Items.Add(statusItem);
		menu.Items.Add(new ToolStripSeparator());
		menu.Items.Add("Open status page", null, (s, e) => OpenStatus());
		menu.Items.Add("Restart", null, (s, e) => Restart(hub));
		menu.Items.Add("Quit", null, (s, e) => Post("/quit"));

		using (var stream = typeof(Tray).Assembly.GetManifestResourceStream("AppIcon.ico"))
			icon = new NotifyIcon { Icon = new Icon(stream, SystemInformation.SmallIconSize), Text = "Agent Multi Tab Use", ContextMenuStrip = menu, Visible = true };
		icon.DoubleClick += (s, e) => OpenStatus();

		hub.EnableRaisingEvents = true;
		hub.Exited += (s, e) => { if (!restarting) { icon.Visible = false; Environment.Exit(0); } };

		var timer = new System.Windows.Forms.Timer { Interval = 5000 };
		timer.Tick += (s, e) => ThreadPool.QueueUserWorkItem(_ => Refresh());
		timer.Start();
		ThreadPool.QueueUserWorkItem(_ => Refresh());
		Application.Run();
	}

	static void Refresh() {
		string text;
		try {
			var json = Get("/status");
			var agents = Regex.Matches(json, "\"agent\":\"[^\"]+\"").Count;
			text = json.Contains("\"chromeConnected\":true")
				? "Chrome connected, " + agents + (agents == 1 ? " agent" : " agents")
				: "Waiting for Chrome";
		} catch {
			text = "Hub not answering";
		}
		ui.BeginInvoke((Action)(() => {
			statusItem.Text = text;
			icon.Text = "Agent Multi Tab Use: " + text;
		}));
	}

	static string Get(string path) {
		using (var web = new TimeoutClient()) return web.DownloadString(hubUrl + path);
	}

	static void Post(string path) {
		try { using (var web = new TimeoutClient()) web.UploadString(hubUrl + path, "{}"); } catch { }
	}

	static void OpenStatus() {
		Process.Start(new ProcessStartInfo(hubUrl + "/status") { UseShellExecute = true });
	}

	// The new hub starts its own tray, so let go of the icon and the mutex first.
	static void Restart(Process hub) {
		restarting = true;
		Post("/quit");
		hub.WaitForExit(5000);
		icon.Visible = false;
		mutex.ReleaseMutex();
		Process.Start(new ProcessStartInfo(hubExe) { UseShellExecute = false, CreateNoWindow = true });
		Environment.Exit(0);
	}

	class TimeoutClient : WebClient {
		protected override WebRequest GetWebRequest(Uri address) {
			var request = base.GetWebRequest(address);
			request.Timeout = 8000;
			return request;
		}
	}
}
