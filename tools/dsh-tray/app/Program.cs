// dsh-tray — native WinForms tray launcher for DeepSeek Harness instances.
// Hides the dsh console, lives in the notification area, and manages
// start/stop/restart per instance. Config: config.json next to the exe.

using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Management;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Win32;

namespace DshTray;

internal sealed class InstanceConfig
{
    public string Name { get; set; } = "";
    public string Profile { get; set; } = "";
    public List<string> Args { get; set; } = new();
    public string WebUrl { get; set; } = "";
    public string? GatewayUrl { get; set; }
    public bool StartOnBoot { get; set; }
}

internal static class Program
{
    private static readonly string ExeDir = AppContext.BaseDirectory;
    private static readonly string ConfigPath = Path.Combine(ExeDir, "config.json");
    private static readonly string LogDir = Path.Combine(ExeDir, "logs");

    private static List<InstanceConfig> _instances = new();
    private static NotifyIcon? _tray;
    private static readonly Dictionary<string, bool> StartedByUs = new();
    private static readonly Dictionary<string, string> LastState = new();

    [STAThread]
    private static void Main(string[] args)
    {
        Directory.CreateDirectory(LogDir);
        _instances = LoadConfig();
        Log($"tray started (pid {Environment.ProcessId}, {_instances.Count} instance(s))");

        ApplicationConfiguration.Initialize();
        using var context = new ApplicationContext();

        _tray = new NotifyIcon
        {
            Icon = MakeIcon(),
            Text = "DSH 启动器",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.MouseUp += (_, e) =>
        {
            if (e.Button == MouseButtons.Right) _tray.ContextMenuStrip = BuildMenu();
        };

        if (_instances.Any(i => i.StartOnBoot))
            foreach (var inst in _instances.Where(i => i.StartOnBoot))
                StartInstance(inst);

        using var timer = new System.Windows.Forms.Timer { Interval = 3000 };
        timer.Tick += (_, _) => RefreshStates();
        timer.Start();

        Application.Run(context);
        _tray.Visible = false;
    }

    // ── config / helpers ────────────────────────────────────────────────────

    private static List<InstanceConfig> LoadConfig()
    {
        try
        {
            var json = File.ReadAllText(ConfigPath);
            var doc = JsonSerializer.Deserialize<JsonElement>(json);
            return doc.GetProperty("instances").EnumerateArray()
                .Select(el => new InstanceConfig
                {
                    Name = Get(el, "name"),
                    Profile = Get(el, "profile"),
                    Args = el.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Array
                        ? a.EnumerateArray().Select(x => x.GetString() ?? "").ToList() : new List<string>(),
                    WebUrl = Get(el, "webUrl"),
                    GatewayUrl = el.TryGetProperty("gatewayUrl", out var g) && g.ValueKind == JsonValueKind.String ? g.GetString() : null,
                    StartOnBoot = el.TryGetProperty("startOnBoot", out var s) && s.ValueKind == JsonValueKind.True,
                }).ToList();
        }
        catch (Exception ex)
        {
            Log($"config load failed: {ex.Message}");
            return new List<InstanceConfig>();
        }
    }

    private static string Get(JsonElement el, string key)
        => el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static void Log(string line) => File.AppendAllText(Path.Combine(LogDir, "tray.log"), $"{DateTime.Now:HH:mm:ss} {line}\r\n");

    private static int PortOf(string url) => new Uri(url).Port;

    private static bool PortListening(int port)
    {
        if (port <= 0) return false;
        try
        {
            using var client = new TcpClient();
            var ar = client.BeginConnect("127.0.0.1", port, null, null);
            return ar.AsyncWaitHandle.WaitOne(400) && client.Connected;
        }
        catch { return false; }
    }

    private static (bool webUp, bool gwUp) StateOf(InstanceConfig inst)
        => (PortListening(PortOf(inst.WebUrl)), inst.GatewayUrl != null && PortListening(PortOf(inst.GatewayUrl)));

    private static List<int> ProfilePids(string profile)
    {
        var pids = new List<int>();
        try
        {
            using var searcher = new ManagementObjectSearcher(
                $"SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'");
            foreach (var obj in searcher.Get())
            {
                var cl = obj["CommandLine"] as string;
                if (cl != null && cl.Contains($"--profile {profile}", StringComparison.OrdinalIgnoreCase))
                    pids.Add(Convert.ToInt32(obj["ProcessId"]));
            }
        }
        catch (Exception ex) { Log($"pid query failed: {ex.Message}"); }
        return pids;
    }

    // ── instance lifecycle ──────────────────────────────────────────────────

    private static void StartInstance(InstanceConfig inst)
    {
        if (ProfilePids(inst.Profile).Count > 0) return;
        var args = $"/c dsh --profile {inst.Profile}";
        if (inst.Args.Count > 0) args += " " + string.Join(" ", inst.Args);
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", args)
            {
                WindowStyle = ProcessWindowStyle.Hidden,
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, e) => { if (e.Data != null) File.AppendAllText(LogPath(inst, ".out.log"), e.Data + "\r\n"); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data != null) File.AppendAllText(LogPath(inst, ".err.log"), e.Data + "\r\n"); };
            if (proc.Start())
            {
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                StartedByUs[inst.Profile] = true;
                Log($"started {inst.Profile}");
            }
        }
        catch (Exception ex)
        {
            Log($"start {inst.Profile} failed: {ex.Message}");
            _tray?.ShowBalloonTip(3000, "dsh-tray", $"启动 {inst.Name} 失败：{ex.Message}", ToolTipIcon.Error);
        }
    }

    private static string LogPath(InstanceConfig inst, string suffix) => Path.Combine(LogDir, inst.Profile + suffix);

    private static void StopInstance(InstanceConfig inst)
    {
        foreach (var pid in ProfilePids(inst.Profile))
        {
            try { Process.GetProcessById(pid).Kill(); } catch { }
        }
        StartedByUs[inst.Profile] = false;
        Log($"stopped {inst.Profile}");
    }

    // ── menu ────────────────────────────────────────────────────────────────

    private static ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip { ShowImageMargin = false };
        var first = true;
        foreach (var inst in _instances)
        {
            if (!first) menu.Items.Add(new ToolStripSeparator());
            first = false;
            var (webUp, gwUp) = StateOf(inst);
            var pids = ProfilePids(inst.Profile);
            var ours = pids.Count > 0;
            var byUs = StartedByUs.TryGetValue(inst.Profile, out var startedByUs) && startedByUs;
            var status = webUp ? $"● 运行中 :{PortOf(inst.WebUrl)}" : "○ 已停止";
            if (ours && !byUs) status += "（外部托管）";

            var header = new ToolStripMenuItem($"{inst.Name}  —  {status}") { Enabled = false };
            menu.Items.Add(header);

            var openWeb = new ToolStripMenuItem($"打开页面  {inst.WebUrl}") { Enabled = webUp };
            openWeb.Click += (_, _) => OpenUrl(inst.WebUrl);
            menu.Items.Add(openWeb);

            if (inst.GatewayUrl != null)
            {
                var openGw = new ToolStripMenuItem($"打开网关  {inst.GatewayUrl}") { Enabled = gwUp };
                openGw.Click += (_, _) => OpenUrl(inst.GatewayUrl!);
                menu.Items.Add(openGw);
            }

            if (!webUp)
            {
                var start = new ToolStripMenuItem("启动");
                start.Click += (_, _) => StartInstance(inst);
                menu.Items.Add(start);
            }
            else
            {
                var restart = new ToolStripMenuItem("重启");
                restart.Click += (_, _) =>
                {
                    if (Confirm($"重启 {inst.Name}？")) { StopInstance(inst); Thread.Sleep(800); StartInstance(inst); }
                };
                menu.Items.Add(restart);

                var stop = new ToolStripMenuItem("停止");
                var note = byUs ? "" : "\r\n（该实例不是本托盘启动的，停止将直接结束其 node 进程）";
                stop.Click += (_, _) =>
                {
                    if (Confirm($"停止 {inst.Name}？{note}")) StopInstance(inst);
                };
                menu.Items.Add(stop);
            }
        }

        menu.Items.Add(new ToolStripSeparator());
        var auto = new ToolStripMenuItem("开机自启") { Checked = IsAutostart() };
        auto.Click += (_, _) => { SetAutostart(!IsAutostart()); auto.Checked = IsAutostart(); };
        menu.Items.Add(auto);

        var quit = new ToolStripMenuItem("退出托盘");
        quit.Click += (_, _) =>
        {
            var r = MessageBox.Show("退出托盘？\r\n\r\n是：退出并保持实例运行\r\n否：退出并停止全部实例\r\n取消：留在托盘",
                "dsh-tray", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (r == DialogResult.Cancel) return;
            if (r == DialogResult.No) foreach (var inst in _instances) StopInstance(inst);
            _tray!.Visible = false;
            Application.Exit();
        };
        menu.Items.Add(quit);
        return menu;
    }

    private static bool Confirm(string message)
        => MessageBox.Show(message, "dsh-tray", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;

    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception ex) { Log($"open url failed: {ex.Message}"); }
    }

    // ── status refresh / crash detection ────────────────────────────────────

    private static void RefreshStates()
    {
        foreach (var inst in _instances)
        {
            var (webUp, _) = StateOf(inst);
            var prev = LastState.GetValueOrDefault(inst.Profile);
            var byUs = StartedByUs.GetValueOrDefault(inst.Profile);
            if (prev == "down" && webUp && byUs)
                _tray?.ShowBalloonTip(3000, "dsh-tray", $"{inst.Name} 已就绪", ToolTipIcon.Info);
            if (prev == "up" && !webUp && byUs)
            {
                var tail = "";
                var err = LogPath(inst, ".err.log");
                if (File.Exists(err))
                    tail = "：" + string.Join(" ", File.ReadLines(err).TakeLast(3)).Trim();
                _tray?.ShowBalloonTip(5000, "dsh-tray", $"{inst.Name} 异常退出{tail}", ToolTipIcon.Warning);
            }
            LastState[inst.Profile] = webUp ? "up" : "down";
        }
    }

    // ── autostart ───────────────────────────────────────────────────────────

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static bool IsAutostart()
    {
        try { return Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue("dsh-tray") != null; }
        catch { return false; }
    }

    private static void SetAutostart(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (on) key.SetValue("dsh-tray", $"\"{Environment.ProcessPath}\"");
            else key.DeleteValue("dsh-tray", false);
        }
        catch (Exception ex) { Log($"autostart toggle failed: {ex.Message}"); }
    }

    // ── icon ────────────────────────────────────────────────────────────────

    private static Icon MakeIcon()
    {
        // The bitmap must outlive the Icon: Icon.FromHandle wraps the hicon,
        // which dies with its bitmap, so disposing the bitmap here would leave
        // a valid-looking-but-invisible tray icon. One 16x16 leak is fine.
        var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var bg = new SolidBrush(Color.FromArgb(57, 100, 254));
            g.FillEllipse(bg, 0, 0, 16, 16);
            using var font = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var fg = new SolidBrush(Color.White);
            g.DrawString("G", font, fg, 3f, 1f);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}
