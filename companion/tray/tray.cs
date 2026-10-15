// Tray icon for the companion app. The hub exe extracts and starts this, passing
// its own path, pid, API address and log file. The icon lives as long as the hub;
// if the hub crashes (non-zero exit), this starts it again, up to MaxRestarts in a row.
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
	static string hubExe, hubUrl, logFile;
	const int MaxRestarts = 5;
	static Mutex mutex;
	static Control ui;
	static bool restarting;
	static DateTime hubStarted = DateTime.Now;

	[STAThread]
	static void Main(string[] args) {
		bool first;
		mutex = new Mutex(true, "AgentMultiTabUseTray", out first);
		if (!first || args.Length < 3) return;
		hubExe = args[0];
		hubUrl = args[2];
		logFile = args.Length > 3 ? args[3] : "";
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
		if (logFile != "") menu.Items.Add("Open log", null, (s, e) => Process.Start(new ProcessStartInfo(logFile) { UseShellExecute = true }));
		menu.Items.Add("Restart", null, (s, e) => Restart(hub));
		menu.Items.Add("Quit", null, (s, e) => Post("/quit"));

		using (var stream = typeof(Tray).Assembly.GetManifestResourceStream("AppIcon.ico"))
			icon = new NotifyIcon { Icon = new Icon(stream, SystemInformation.SmallIconSize), Text = "Agent Multi Tab Use", ContextMenuStrip = menu, Visible = true };
		icon.DoubleClick += (s, e) => OpenStatus();

		hub.EnableRaisingEvents = true;
		hub.Exited += (s, e) => ui.BeginInvoke((Action)(() => OnHubExit(hub)));

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

	static void Restart(Process hub) {
		restarting = true;
		Post("/quit");
		hub.WaitForExit(5000);
		StartHub(0);
	}

	// Quit (exit code 0) ends the tray too; a crash starts the hub again. The count
	// rides along in the environment and resets once the hub has run 10 minutes.
	static void OnHubExit(Process hub) {
		if (restarting) return;
		int code = 1;
		try { code = hub.ExitCode; } catch { }
		if (code == 0) Exit();
		int restarts;
		int.TryParse(Environment.GetEnvironmentVariable("AMTU_RESTARTS"), out restarts);
		if ((DateTime.Now - hubStarted).TotalMinutes > 10) restarts = 0;
		if (restarts >= MaxRestarts) {
			icon.ShowBalloonTip(10000, "Agent Multi Tab Use stopped", "It crashed " + MaxRestarts + " times in a row. Start it again from the Start menu; the log is " + logFile, ToolTipIcon.Error);
			var later = new System.Windows.Forms.Timer { Interval = 10000 };
			later.Tick += (s, e) => Exit();
			later.Start();
			return;
		}
		Thread.Sleep(Math.Min(1000 << restarts, 15000));
		StartHub(restarts + 1);
	}

	// The new hub starts its own tray, so let go of the icon and the mutex first.
	static void StartHub(int restarts) {
		icon.Visible = false;
		mutex.ReleaseMutex();
		var start = new ProcessStartInfo(hubExe) { UseShellExecute = false, CreateNoWindow = true };
		start.EnvironmentVariables["AMTU_RESTARTS"] = restarts.ToString();
		Process.Start(start);
		Environment.Exit(0);
	}

	static void Exit() {
		icon.Visible = false;
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
