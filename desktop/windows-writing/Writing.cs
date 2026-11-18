using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

namespace AmadeusWriting
{
    internal static class Native
    {
        internal delegate void WinEvent(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint milliseconds);
        [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
        [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
        [DllImport("user32.dll")] internal static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] internal static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] internal static extern int GetWindowLong(IntPtr hwnd, int index);
        internal static long Message(IntPtr h, uint msg, IntPtr w, IntPtr l)
        {
            IntPtr result;
            if (SendMessageTimeout(h, msg, w, l, 2, 150, out result) == IntPtr.Zero) throw new InvalidOperationException();
            return result.ToInt64();
        }
    }
    internal sealed class Grant
    {
        internal string Path, Mode, Conversation, Profile;
        public override string ToString() { return System.IO.Path.GetFileName(Path) + " · " + Mode; }
    }
    internal sealed class Sample
    {
        internal AutomationElement Field;
        internal IntPtr Window, Edit;
        internal string Draft, Full;
        internal int Caret;
        internal Grant Grant;
        internal bool Same(Sample other)
        {
            return other != null && Window == other.Window && Edit == other.Edit && Grant == other.Grant && Draft == other.Draft && Full == other.Full && Caret == other.Caret && Automation.Compare(Field, other.Field);
        }
        internal static Sample Read(Dictionary<string, Grant> grants)
        {
            if (grants.Count == 0) return null;
            IntPtr window = Native.GetForegroundWindow(); int pid;
            Native.GetWindowThreadProcessId(window, out pid);
            if (pid <= 0) return null;
            Grant grant;
            using (var process = Process.GetProcessById(pid))
            {
                if (!grants.TryGetValue(process.MainModule.FileName, out grant)) return null;
            }
            var f = AutomationElement.FocusedElement;
            if (f == null || !f.Current.HasKeyboardFocus || Native.GetForegroundWindow() != window) return null;
            return ReadEditor(window, pid, f, grant);
        }
        internal static Sample ReadEditor(IntPtr window, int pid, AutomationElement f, Grant grant)
        {
            if (!f.Current.IsEnabled ||
                !Object.Equals(f.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true), false)) return null;
            int editorPid = f.Current.ProcessId;
            if (editorPid != pid)
            {
                using (var editorProcess = Process.GetProcessById(editorPid))
                {
                    if (!String.Equals(editorProcess.MainModule.FileName, grant.Path, StringComparison.OrdinalIgnoreCase)) return null;
                }
            }
            var type = f.Current.ControlType;
            if (type != ControlType.Edit && type != ControlType.Document) return null;
            IntPtr h = new IntPtr(f.Current.NativeWindowHandle);
            var cls = new StringBuilder(128);
            if (h != IntPtr.Zero) Native.GetClassName(h, cls, cls.Capacity);
            string name = cls.ToString();
            bool native = name.Equals("Edit", StringComparison.OrdinalIgnoreCase) || name.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || name.StartsWith("WindowsForms10.EDIT.", StringComparison.OrdinalIgnoreCase);
            if (native)
            {
                int owner; Native.GetWindowThreadProcessId(h, out owner);
                if (owner != editorPid || (Native.GetWindowLong(h, -16) & (0x20 | 0x800)) != 0 || Native.Message(h, 0xd2, IntPtr.Zero, IntPtr.Zero) != 0) return null;
            }
            if (native)
            {
                // Native Edit messages are bound to the validated HWND. No clipboard or simulated typing.
                long length = Native.Message(h, 0xe, IntPtr.Zero, IntPtr.Zero);
                if (length > 0 && length <= 2000)
                {
                    long pos = Native.Message(h, 0xb0, IntPtr.Zero, IntPtr.Zero);
                    if (pos == -1 || (pos & 65535) != ((pos >> 16) & 65535)) return null;
                    int caret = (int)(pos & 65535);
                    var buf = Marshal.AllocHGlobal(((int)length + 1) * 2);
                    try
                    {
                        int copied = (int)Native.Message(h, 0xd, new IntPtr(length + 1), buf);
                        if (caret > copied) return null;
                        string value = Marshal.PtrToStringUni(buf, copied);
                        int start = Math.Max(0, caret - 512);
                        string fragment = value.Substring(start, caret - start);
                        int newline = Math.Max(fragment.LastIndexOf('\r'), fragment.LastIndexOf('\n'));
                        fragment = fragment.Substring(newline + 1);
                        return new Sample { Window = window, Field = f, Edit = h, Draft = fragment, Grant = grant, Caret = caret };
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
            }
            object pattern;
            if (!f.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return null;
            var text = (TextPattern)pattern;
            if (!native && (type != ControlType.Edit || !f.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)) return null;
            var ranges = text.GetSelection();
            if (ranges.Length != 1) return null;
            var cursor = ranges[0];
            if (cursor.CompareEndpoints(TextPatternRangeEndpoint.Start, cursor, TextPatternRangeEndpoint.End) != 0) return null;
            var prefix = cursor.Clone();
            prefix.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -512);
            string draft = prefix.GetText(512);
            int line = Math.Max(draft.LastIndexOf('\r'), draft.LastIndexOf('\n'));
            if (line >= 0) draft = draft.Substring(line + 1);
            if (draft.Trim().Length < 4) return null;
            var current = new Sample { Window = window, Field = f, Edit = native ? h : IntPtr.Zero, Draft = draft, Grant = grant };
            if (native)
            {
                long pos = Native.Message(h, 0xb0, IntPtr.Zero, IntPtr.Zero);
                if (pos == -1 || (pos & 65535) != ((pos >> 16) & 65535)) return null;
                current.Caret = (int)(pos & 65535);
                if (current.Caret < draft.Length) return null;
            }
            else
            {
                // Only a short plain Edit with a target-bound setter can be updated safely.

                var document = text.DocumentRange;
                string full = document.GetText(2001);
                if (full.Length > 2000 || !full.EndsWith(draft, StringComparison.Ordinal)) return null;
                // A provider may expose a trailing caret stop beyond its final text character.
                // Verify both sides of the caret and the value before treating it as appendable.
                var left = document.Clone();
                left.MoveEndpointByRange(TextPatternRangeEndpoint.End, cursor, TextPatternRangeEndpoint.End);
                var right = document.Clone();
                right.MoveEndpointByRange(TextPatternRangeEndpoint.Start, cursor, TextPatternRangeEndpoint.End);
                if (left.GetText(2001) != full || right.GetText(1).Length != 0 ||
                    ((ValuePattern)pattern).Current.Value != full) return null;
                current.Full = full; current.Caret = full.Length;
            }
            return current;
        }
        internal void Apply(string suggestion)
        {
            bool grammar = Grant.Mode == "grammar";
            string replacement = Grant.Mode == "paragraph" ? "\r\n\r\n" + suggestion : suggestion;
            if (Edit != IntPtr.Zero)
            {
                long selection = Native.Message(Edit, 0xb0, IntPtr.Zero, IntPtr.Zero);
                if (selection == -1 || (selection & 65535) != Caret || ((selection >> 16) & 65535) != Caret) return;
                Native.Message(Edit, 0xb1, new IntPtr(grammar ? Caret - Draft.Length : Caret), new IntPtr(Caret));
                IntPtr buffer = Marshal.StringToHGlobalUni(replacement);
                try { Native.Message(Edit, 0xc2, new IntPtr(1), buffer); } finally { Marshal.FreeHGlobal(buffer); }
            }
            else
            {
                var value = (ValuePattern)Field.GetCurrentPattern(ValuePattern.Pattern);
                if (value.Current.IsReadOnly || value.Current.Value != Full) return;
                value.SetValue(Full.Substring(0, grammar ? Caret - Draft.Length : Caret) + replacement);
            }
        }
    }
    internal sealed class Hint : Form
    {
        internal Hint() { FormBorderStyle = FormBorderStyle.FixedToolWindow; ShowInTaskbar = false; TopMost = true; Size = new Size(360, 110); Text = "Amadeus Dot · Tab 采纳"; StartPosition = FormStartPosition.Manual; }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
    }
    public sealed class Panel : Form
    {
        readonly Dictionary<string, Grant> grants = new Dictionary<string, Grant>(StringComparer.OrdinalIgnoreCase);
        readonly ListBox apps = new ListBox(); readonly ComboBox mode = new ComboBox();
        readonly Label status = new Label(); readonly Hint hint = new Hint(); readonly Label preview = new Label();
        readonly HttpClient http; readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Native.WinEvent focusChanged; IntPtr foregroundHook, focusHook;
        Sample observed, offered; string proposed, csrf; DateTime changed, expires; bool requested, working, reading;
        CancellationTokenSource pending;
        void ClearOffer() { if (offered != null) Native.UnregisterHotKey(Handle, 1); offered = null; proposed = null; hint.Hide(); }
        void Reset() { ClearOffer(); if (pending != null) pending.Cancel(); observed = null; requested = false; }
        internal Panel(Uri service, HttpMessageHandler testHandler = null)
        {
            var handler = testHandler ?? new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, CookieContainer = new CookieContainer() };
            http = new HttpClient(handler) { BaseAddress = service, Timeout = TimeSpan.FromSeconds(18) };
            Text = "Amadeus Dot · 应用写作辅助"; Size = new Size(540, 315);
            var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(12), AutoScroll = true }; Controls.Add(layout);
            layout.Controls.Add(new Label { AutoSize = true, Text = "选择允许读取编辑框的应用。关闭本窗口即停止所有应用辅助。" });
            apps.Width = 470; apps.Height = 78; layout.Controls.Add(apps);
            mode.DropDownStyle = ComboBoxStyle.DropDownList; mode.Items.AddRange(new object[] { "补完当前句", "续写下一段", "语法修正" }); mode.SelectedIndex = 0; layout.Controls.Add(mode);
            var buttons = new FlowLayoutPanel { AutoSize = true }; layout.Controls.Add(buttons);
            var add = new Button { Text = "选择应用…", AutoSize = true }; var remove = new Button { Text = "停用所选", AutoSize = true }; buttons.Controls.Add(add); buttons.Controls.Add(remove);
            add.Click += async (s, e) => { add.Enabled = false; try { await AddApp(); } catch { status.Text = "无法授权，请确认已绑定 Dot 会话、已配置模型且服务在线。"; } finally { if (!IsDisposed) add.Enabled = true; } };
            remove.Click += (s, e) => { var g = apps.SelectedItem as Grant; if (g != null) { Reset(); grants.Remove(g.Path); apps.Items.Remove(g); } };
            status.AutoSize = true; status.Text = "本次会话尚未授权应用"; layout.Controls.Add(status);
            preview.Dock = DockStyle.Fill; preview.Padding = new Padding(8); preview.AutoEllipsis = true; hint.Controls.Add(preview);
            focusChanged = (hook, evt, window, obj, child, thread, ms) => { if (!IsDisposed) Reset(); };
            foregroundHook = Native.SetWinEventHook(3, 3, IntPtr.Zero, focusChanged, 0, 0, 2);
            focusHook = Native.SetWinEventHook(0x8005, 0x8005, IntPtr.Zero, focusChanged, 0, 0, 2);
            if (foregroundHook == IntPtr.Zero || focusHook == IntPtr.Zero) throw new InvalidOperationException("Focus monitoring unavailable");
            timer.Interval = 350; timer.Tick += (s, e) => Tick(); timer.Start();
        }
        async Task<Dictionary<string, object>> Request(string path, object body, CancellationToken signal)
        {
            using (var req = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, path))
            {
                if (body != null) { req.Headers.Add("X-CSRF-Token", csrf); req.Content = new StringContent(json.Serialize(body), Encoding.UTF8, "application/json"); }
                using (var res = await http.SendAsync(req, signal)) { res.EnsureSuccessStatusCode(); return json.Deserialize<Dictionary<string, object>>(await res.Content.ReadAsStringAsync()); }
            }
        }
        async Task AddApp()
        {
            string path;
            using (var picker = new OpenFileDialog { Filter = "Windows 应用 (*.exe)|*.exe", CheckFileExists = true })
            {
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                path = System.IO.Path.GetFullPath(picker.FileName);
            }
            var token = (string)(await Request("/api/bootstrap", null, CancellationToken.None))["csrf"];
            var c = await Request("/api/personal/dot/writing-context", null, CancellationToken.None);
            if (MessageBox.Show(this, path + "\n\n输入停顿后，发送当前段光标前最多 512 个字符到 " + c["model"] + " (" + c["origin"] + ")。可能产生模型费用。仅本次开启。", "允许此应用使用 Dot？", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
            Enable(new Grant { Path = path, Mode = new[] { "sentence", "paragraph", "grammar" }[mode.SelectedIndex], Conversation = (string)c["conversationId"], Profile = (string)c["profileKey"] }, token);
        }
        internal void Enable(Grant g, string token)
        {
            Reset(); Grant old; if (grants.TryGetValue(g.Path, out old)) apps.Items.Remove(old);
            csrf = token; grants[g.Path] = g; apps.Items.Add(g); status.Text = "已开启 · 输入后停顿以获取建议";
        }
        async void Tick()
        {
            try
            {
                if (offered != null && (DateTime.UtcNow >= expires || Native.GetForegroundWindow() != offered.Window)) ClearOffer();
                if (observed != null && Native.GetForegroundWindow() != observed.Window) Reset();
                if (reading || grants.Count == 0) return;
                var enabled = new Dictionary<string, Grant>(grants, StringComparer.OrdinalIgnoreCase);
                Sample current;
                reading = true;
                try { current = await Task.Run(() => Sample.Read(enabled)); } finally { reading = false; }
                if (IsDisposed) return;
                Grant live;
                if (current != null && (Native.GetForegroundWindow() != current.Window || !grants.TryGetValue(current.Grant.Path, out live) || live != current.Grant)) current = null;
                if (current == null) { Reset(); return; }
                if (!current.Same(observed))
                {
                    bool sameField = observed != null && current.Grant == observed.Grant && Automation.Compare(current.Field, observed.Field);
                    Reset(); observed = current; changed = DateTime.UtcNow; requested = !sameField; return;
                }
                if (current.Draft.Trim().Length < 4 || working || requested || DateTime.UtcNow - changed < TimeSpan.FromMilliseconds(1100)) return;
                requested = true; working = true; var cts = new CancellationTokenSource(); pending = cts;
                try
                {
                    var g = current.Grant;
                    var response = await Request("/api/personal/dot/draft-suggestion", new { conversationId = g.Conversation, mode = g.Mode, draft = current.Draft, profileKey = g.Profile }, cts.Token);
                    string result = response["suggestion"] as string;
                    if (cts.IsCancellationRequested || String.IsNullOrWhiteSpace(result) || result.Contains("\0") || (g.Mode == "grammar" && result == current.Draft)) return;
                    var confirm = await Task.Run(() => Sample.Read(enabled));
                    if (cts.IsCancellationRequested || IsDisposed || !current.Same(confirm) || Native.GetForegroundWindow() != current.Window) return;
                    if (!Native.RegisterHotKey(Handle, 1, 0x4000, 9)) { status.Text = "Tab 已被其他程序占用"; return; }
                    offered = current; proposed = result; expires = DateTime.UtcNow.AddSeconds(10); preview.Text = result;
                    var area = Screen.FromHandle(current.Window).WorkingArea; hint.Location = new Point(area.Right - hint.Width - 8, area.Bottom - hint.Height - 8); hint.Show();
                }
                catch (OperationCanceledException) { }
                catch { if (!IsDisposed) status.Text = "本次建议不可用，请检查模型连接或重新授权应用。"; }
                finally { working = false; pending = null; cts.Dispose(); }
            }
            catch { if (!IsDisposed) Reset(); }
        }
        protected override void WndProc(ref Message m)
        {
            const int WM_HOTKEY = 0x312;
            if (m.Msg != WM_HOTKEY || m.WParam.ToInt32() != 1) { base.WndProc(ref m); return; }
            var target = offered;
            var value = proposed;
            ClearOffer();
            try {
                if (target != null && DateTime.UtcNow < expires && target.Same(Sample.Read(grants))) target.Apply(value);
            } catch { status.Text = "编辑框已变化，请继续输入以取得新建议。"; }
            finally { Reset(); }
        }
        protected override void OnFormClosed(FormClosedEventArgs e) { timer.Stop(); Native.UnhookWinEvent(foregroundHook); Native.UnhookWinEvent(focusHook); Reset(); timer.Dispose(); hint.Dispose(); http.Dispose(); base.OnFormClosed(e); }
        [STAThread]
        public static int Main(string[] args)
        {
            int pid;
            if(args.Length!=2||!Int32.TryParse(args[1],out pid))return 2;
            try {Run(args[0],pid);return 0;}
            catch {return 1;}
        }
        static void Run(string address, int parentPid)
        {
            var uri = new Uri(address); if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/") throw new ArgumentException("Local Amadeus service required");
            Application.EnableVisualStyles();
            using (var parent = Process.GetProcessById(parentPid))
            using (var panel = new Panel(uri))
            {
                var watch = new System.Windows.Forms.Timer { Interval = 1000 };
                watch.Tick += (s, e) => { if (parent.HasExited) panel.Close(); }; watch.Start();
                try { Application.Run(panel); } finally { watch.Dispose(); }
            }
        }
    }
}
