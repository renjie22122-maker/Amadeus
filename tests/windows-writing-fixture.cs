using System;
using System.IO;
using System.Drawing;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Windows.Forms;
using AmadeusWriting;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using System.Linq;
using System.Text;

class Fixture
{
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    static void Editor()
    {
        var form = new Form { Text = "Amadeus isolated editor fixture", TopMost = true };
        var normal = new TextBox { Text = "sample draft", Dock = DockStyle.Top };
        var password = new TextBox { Text = "synthetic-password", UseSystemPasswordChar = true, Dock = DockStyle.Bottom };
        form.Controls.Add(normal); form.Controls.Add(password);
        form.Shown += (s, e) =>
        {
            ShowWindow(form.Handle, 5); SetForegroundWindow(form.Handle); form.Activate(); normal.Focus(); normal.Select(normal.TextLength, 0);
            Console.WriteLine(form.Handle.ToInt64() + " " + normal.Handle.ToInt64() + " " + password.Handle.ToInt64()); Console.Out.Flush();
            var reader = new Thread(() =>
            {
                string command;
                while ((command = Console.ReadLine()) != null)
                {
                    var c = command;
                    form.Invoke((Action)(() =>
                    {
                        if (c == "end") { normal.Focus(); normal.Select(normal.TextLength, 0); }
                        if (c == "password") password.Focus();
                        if (c == "readonly") { normal.Focus(); normal.ReadOnly = true; }
                        if (c == "append") normal.AppendText(" now");
                        if (c == "state") Console.WriteLine(normal.Text);
                        else Console.WriteLine("ready");
                        Console.Out.Flush();
                        if (c == "quit") form.Close();
                    }));
                    if (c == "quit") return;
                }
            }); reader.IsBackground = true; reader.Start();
        };
        Application.Run(form);
    }
    sealed class ModelFixture : HttpMessageHandler
    {
        public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            string body = await request.Content.ReadAsStringAsync();
            Check(!body.Contains("synthetic-password"), "Password reached provider");
            Calls++;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"suggestion\":\" accepted\"}", Encoding.UTF8, "application/json") };
        }
    }
    static void Pump(int milliseconds) { var end = DateTime.UtcNow.AddMilliseconds(milliseconds); while (DateTime.UtcNow < end) { Application.DoEvents(); Thread.Sleep(20); } }
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0) { Editor(); return 0; }
        string path = Process.GetCurrentProcess().MainModule.FileName;
        var allowed = new Dictionary<string, Grant>(StringComparer.OrdinalIgnoreCase);
        using (var child = Process.Start(new ProcessStartInfo(path, "editor") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true }))
        {
            try
            {
                var handles = Array.ConvertAll(child.StandardOutput.ReadLine().Split(' '), s => new IntPtr(long.Parse(s)));

                ShowWindow(handles[0], 5);
                SwitchToThisWindow(handles[0], true);
                try {System.Windows.Automation.AutomationElement.FromHandle(handles[1]).SetFocus();} catch (InvalidOperationException) { /* Non-interactive runner. */ }
                Func<string, string> command = c => { child.StandardInput.WriteLine(c); child.StandardInput.Flush(); return child.StandardOutput.ReadLine(); };
                Check(Sample.Read(allowed) == null, "Unauthorized app");
                allowed[path] = new Grant { Path = path, Mode = "sentence" };
                Func<int, Sample> read = index => Sample.ReadEditor(handles[0], child.Id, System.Windows.Automation.AutomationElement.FromHandle(handles[index]), allowed[path]);
                Sample sample = null;
                for (int i = 0; i < 4 && sample == null; i++) { Thread.Sleep(120); sample = Sample.Read(allowed); }
                if (sample == null)
                {
                    int foregroundPid; Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out foregroundPid);
                    Console.WriteLine("Fixture foreground: " + (foregroundPid == child.Id));
                    if (foregroundPid == child.Id)
                    {
                        var f = System.Windows.Automation.AutomationElement.FocusedElement;
                        Console.WriteLine("Fixture control: " + f.Current.ControlType.ProgrammaticName + "; hwnd=" + f.Current.NativeWindowHandle + "; focus=" + f.Current.HasKeyboardFocus + "; protected=" + f.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.IsPasswordProperty, true));
                    }
                }
                bool foregroundVerified = sample != null;
                if (!foregroundVerified) sample = read(1);
                Check(sample != null && sample.Draft == "sample draft", "Focused plain editor unsupported");
                sample.Apply(" works");
                Check(command("state") == "sample draft works", "Targeted edit failed");
                Check(!sample.Same(read(1)), "Stale suggestion still valid");
                if (foregroundVerified)
                {
                    var provider = new ModelFixture();
                    using (var panel = new AmadeusWriting.Panel(new Uri("http://127.0.0.1/"), provider))
                    {
                        var owner = panel.Handle;
                        panel.Enable(allowed[path], "fixture");
                        Pump(900); command("append");
                        bool offered = false;
                        for (int i = 0; i < 36 && !offered; i++) { Pump(125); offered = Application.OpenForms.Cast<Form>().Any(f => f is Hint && f.Visible); }
                        if (!offered) { int front; Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out front); Console.WriteLine("candidate calls=" + provider.Calls + " foreground=" + (front == child.Id) + " status=" + String.Join(" / ", panel.Controls[0].Controls.OfType<Label>().Select(l => l.Text))); }
                        Check(offered, "No visible Tab offer");
                        Check(Sample.Read(allowed) != null, "Synthetic editor lost focus before Tab");
                        SendKeys.SendWait("{TAB}"); Pump(450);
                        Check(command("state") == "sample draft works now accepted", "Tab did not accept the offered suggestion");
                        int calls = provider.Calls;
                        command("password"); Pump(1600);
                        Check(provider.Calls == calls, "Password field triggered provider");
                        panel.Close();
                        Console.WriteLine("PASS: real foreground sample, visible candidate, registered Tab acceptance and no password request.");
                    }
                }
                command("password"); Check(read(2) == null, "Password must be skipped");
                command("readonly"); Check(read(1) == null, "Read-only input must be skipped");
                Console.WriteLine("Foreground path verified: " + foregroundVerified); Console.WriteLine("PASS: app scope, plain editor, targeted insert, stale candidate, password and read-only fields.");
            }
            finally { if (!child.HasExited) { child.StandardInput.WriteLine("quit"); child.StandardInput.Flush(); if (!child.WaitForExit(3000)) child.Kill(); } }
        }
        return 0;
    }
}
