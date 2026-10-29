using System.Windows.Automation;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public class DesktopBridge {
 delegate bool EnumWindowProc(IntPtr h,IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback,IntPtr parameter);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int size);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint processId);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int dx,dy;public uint mouseData,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KEYINPUT {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {[FieldOffset(0)]public MOUSEINPUT mouse;[FieldOffset(0)]public KEYINPUT key;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public INPUTUNION data;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 static void Emit(INPUT value){if(SendInput(1,new[]{value},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Windows rejected input; possible privilege boundary");}
 static void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e){Emit(new INPUT{type=0,data=new INPUTUNION{mouse=new MOUSEINPUT{flags=f,mouseData=d}}});}
 static void Key(ushort vk,ushort scan,uint flags){Emit(new INPUT{type=1,data=new INPUTUNION{key=new KEYINPUT{vk=vk,scan=scan,flags=flags}}});}
 static void CheckTarget(Dictionary<string,object>a){if(GetForegroundWindow()!=new IntPtr(Int64.Parse(Text(a,"windowId"))))throw new Exception("Target lost foreground; stopped input");}

 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll",SetLastError=true)] static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
 static JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=32*1024*1024 };
 static int Number(Dictionary<string,object> a,string k) {if(!a.ContainsKey(k))throw new Exception("Missing "+k);return Convert.ToInt32(a[k]);}
 static string Text(Dictionary<string,object>a,string k) {return a.ContainsKey(k)?Convert.ToString(a[k]):"";}
 [STAThread] public static int Main(string[] args) {
  using(var gate=new Mutex(false,"Local\\AgentDemoDesktopInput")){
   bool owned=false;
   try {try{owned=gate.WaitOne(5000);}catch(AbandonedMutexException){owned=true;}
    if(!owned)throw new Exception("Desktop busy in another conversation");
    return Run(args);
   }finally{if(owned)gate.ReleaseMutex();}
  }
 }
 static int Run(string[] args) {
  try {SetProcessDPIAware(); var a=json.Deserialize<Dictionary<string,object>>(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
   string action=Text(a,"action"); var bounds=SystemInformation.VirtualScreen;
   if(action=="windows"){var windows=new List<object>();EnumWindows((h,p)=>{if(IsWindowVisible(h)){var title=new StringBuilder(1024);GetWindowText(h,title,title.Capacity);uint pid;GetWindowThreadProcessId(h,out pid);RECT r;if(GetWindowRect(h,out r)&&r.R>r.L&&r.B>r.T)windows.Add(new {windowId=h.ToInt64().ToString(),title=title.ToString(),processId=pid,foreground=h==GetForegroundWindow(),minimized=IsIconic(h),x=r.L,y=r.T,width=r.R-r.L,height=r.B-r.T});}return true;},IntPtr.Zero);Console.WriteLine(json.Serialize(new {windows=windows}));return 0;}
   if(action=="activate"){var h=new IntPtr(Int64.Parse(Text(a,"windowId")));if(!IsWindow(h))throw new Exception("Window unavailable");if(IsIconic(h))ShowWindow(h,9);SetForegroundWindow(h);Thread.Sleep(100);if(GetForegroundWindow()!=h)throw new Exception("ACTIVATION_DENIED: Windows did not grant foreground; no input sent");Console.WriteLine(json.Serialize(new {activated=true,windowId=Text(a,"windowId")}));return 0;}
   if(action=="inspect"){
    var handle=new IntPtr(Int64.Parse(Text(a,"windowId")));if(!IsWindow(handle))throw new Exception("Window unavailable");
    var root=AutomationElement.FromHandle(handle);var queue=new Queue<AutomationElement>();queue.Enqueue(root);var controls=new List<object>();var timer=Stopwatch.StartNew();bool incomplete=false;
    while(queue.Count>0 && controls.Count<(a.ContainsKey("maxControls")?Math.Min(1000,Number(a,"maxControls")):300) && timer.ElapsedMilliseconds<3000){
     var element=queue.Dequeue();try{var cur=element.Current;var rect=cur.BoundingRectangle;
      object pattern; string value=null, selectedText=null, toggle=null, expanded=null; bool? selected=null; bool readOnly=true;
      if(!cur.IsPassword){
       if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)){var v=((ValuePattern)pattern).Current;value=v.Value;if(value!=null&&value.Length>2000)value=value.Substring(0,2000);readOnly=v.IsReadOnly;}
       if(element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)){var ranges=((TextPattern)pattern).GetSelection();if(ranges.Length>0)selectedText=ranges[0].GetText(2000);}
       if(element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))toggle=((TogglePattern)pattern).Current.ToggleState.ToString();
       if(element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))expanded=((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString();
       if(element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))selected=((SelectionItemPattern)pattern).Current.IsSelected;
      }
      controls.Add(new {value=value,selectedText=selectedText,readOnly=readOnly,toggle=toggle,expanded=expanded,selected=selected,offscreen=cur.IsOffscreen,name=cur.IsPassword?"[protected]":cur.Name,runtimeId=element.GetRuntimeId(),focused=cur.HasKeyboardFocus,role=cur.ControlType.ProgrammaticName,automationId=cur.AutomationId,enabled=cur.IsEnabled,password=cur.IsPassword,x=rect.X,y=rect.Y,width=rect.Width,height=rect.Height});
      var child=TreeWalker.ControlViewWalker.GetFirstChild(element);
      for(int n=0;child!=null && n<100 && queue.Count<2000;n++){queue.Enqueue(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
      if(child!=null)incomplete=true;
     }catch(ElementNotAvailableException){incomplete=true;}catch(InvalidOperationException){incomplete=true;}
    }
    Console.WriteLine(json.Serialize(new {windowId=Text(a,"windowId"),controls=controls,truncated=incomplete||queue.Count>0,source="UI Automation"}));return 0;
   }
   if(action=="cursor"){Console.WriteLine(json.Serialize(new {x=Cursor.Position.X,y=Cursor.Position.Y}));return 0;}
   if(action=="screenshot"){
    bool window=a.ContainsKey("windowId");IntPtr handle=IntPtr.Zero;
    if(window){
     handle=new IntPtr(Int64.Parse(Text(a,"windowId")));RECT r;
     if(!IsWindow(handle)||!IsWindowVisible(handle)||!GetWindowRect(handle,out r))throw new Exception("CAPTURE_UNAVAILABLE: window is closed or hidden");
     if(IsIconic(handle))throw new Exception("CAPTURE_MINIMIZED: restore the window before capturing");
     bounds=Rectangle.FromLTRB(r.L,r.T,r.R,r.B);
    }
    if(bounds.Width<=0||bounds.Height<=0||(long)bounds.Width*bounds.Height>16000000)throw new Exception("CAPTURE_SIZE: invalid dimensions or more than 16 million pixels");
    using(var b=new Bitmap(bounds.Width,bounds.Height))using(var g=Graphics.FromImage(b))using(var stream=new MemoryStream()){
     if(window){
      g.Clear(Color.FromArgb(255,1,254,3));
      IntPtr dc=g.GetHdc();bool ok;
      try{ok=PrintWindow(handle,dc,2);}finally{g.ReleaseHdc(dc);}
      if(!ok)throw new Exception("CAPTURE_UNSUPPORTED: application rejected PrintWindow; no screen fallback");
      bool painted=false;
      for(int y=0;y<b.Height&&!painted;y+=Math.Max(1,b.Height/32))
       for(int x=0;x<b.Width;x+=Math.Max(1,b.Width/32))
        if(b.GetPixel(x,y).ToArgb()!=Color.FromArgb(255,1,254,3).ToArgb()){painted=true;break;}
      if(!painted)throw new Exception("CAPTURE_EMPTY: application did not paint window pixels");
      RECT after;
      if(!IsWindow(handle)||IsIconic(handle)||!GetWindowRect(handle,out after)||after.L!=bounds.Left||after.T!=bounds.Top||after.R!=bounds.Right||after.B!=bounds.Bottom)
       throw new Exception("CAPTURE_CHANGED: window changed during capture; inspect before retrying");
     }else g.CopyFromScreen(bounds.Left,bounds.Top,0,0,bounds.Size);
     b.Save(stream,ImageFormat.Png);
     Console.WriteLine(json.Serialize(new {image=Convert.ToBase64String(stream.ToArray()),x=bounds.Left,y=bounds.Top,width=bounds.Width,height=bounds.Height,capture=window?"window-print":"visible-screen",windowId=window?handle.ToInt64().ToString():null,contentVerified=false,limitations=window?"PrintWindow is application-dependent; black, stale or incomplete frames remain possible. Not Windows.Graphics.Capture.":"Visible desktop pixels only."}));
    }return 0;}
   {
    var h=new IntPtr(Int64.Parse(Text(a,"windowId")));RECT r;
    if(!IsWindow(h)||GetForegroundWindow()!=h||!GetWindowRect(h,out r))throw new Exception("Target must be the existing foreground window; no input sent");
    bounds=Rectangle.Intersect(bounds,Rectangle.FromLTRB(r.L,r.T,r.R,r.B));
   }
   if(action=="move"||action=="click"||action=="double_click"||action=="drag"){
    int x=Number(a,"x"),y=Number(a,"y");if(!bounds.Contains(x,y))throw new Exception("Point outside target");if(GetAncestor(WindowFromPoint(new Point(x,y)),2)!=new IntPtr(Int64.Parse(Text(a,"windowId"))))throw new Exception("Point covered by another window; inspect again");
    if(action=="drag"){int endX=Number(a,"toX"),endY=Number(a,"toY");if(!bounds.Contains(endX,endY))throw new Exception("Drag outside target");SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);
     try{for(int i=1;i<=10;i++){CheckTarget(a);SetCursorPos(x+(endX-x)*i/10,y+(endY-y)*i/10);Thread.Sleep(20);}}finally{mouse_event(4,0,0,0,UIntPtr.Zero);}
    }else{if(!SetCursorPos(x,y))throw new Exception("Cursor move failed");if(action!="move"){int count=action=="double_click"?2:1;for(int i=0;i<count;i++){CheckTarget(a);uint down=Text(a,"button")=="right"?8u:Text(a,"button")=="middle"?32u:2u;mouse_event(down,0,0,0,UIntPtr.Zero);mouse_event(down*2,0,0,0,UIntPtr.Zero);}}}
   }else if(action=="type"){var focused=AutomationElement.FocusedElement;if(focused==null||focused.Current.IsPassword)throw new Exception("Protected or unavailable focused input; user interaction required");string s=Text(a,"text");if(s.Length>2000)throw new Exception("Text too long");foreach(char c in s){CheckTarget(a);Key(0,(ushort)c,4);Key(0,(ushort)c,6);}}
   else if(action=="key"){
    string[] parts=Text(a,"key").Split('+');var held=new List<ushort>();
    try{for(int i=0;i<parts.Length-1;i++){ushort mod=parts[i]=="CTRL"?(ushort)17:parts[i]=="ALT"?(ushort)18:parts[i]=="SHIFT"?(ushort)16:(ushort)0;if(mod==0)throw new Exception("Unsupported modifier");CheckTarget(a);Key(mod,0,0);held.Add(mod);}
     string k=parts[parts.Length-1];var names=new[]{"ENTER","ESC","TAB","BACKSPACE","UP","DOWN","LEFT","RIGHT","DELETE","HOME","END","PAGEUP","PAGEDOWN","SPACE"};ushort[] codes={13,27,9,8,38,40,37,39,46,36,35,33,34,32};int index=Array.IndexOf(names,k);ushort code;
     int f;if(index>=0)code=codes[index];else if(k.Length==1&&((k[0]>='A'&&k[0]<='Z')||(k[0]>='0'&&k[0]<='9')))code=k[0];else if(k.StartsWith("F")&&int.TryParse(k.Substring(1),out f)&&f>=1&&f<=12)code=(ushort)(111+f);else throw new Exception("Unsupported key");CheckTarget(a);Key(code,0,0);try{CheckTarget(a);}finally{Key(code,0,2);}
    }finally{held.Reverse();foreach(var mod in held)Key(mod,0,2);}
   }
   else if(action=="scroll"){int delta=Number(a,"delta");if(Math.Abs(delta)>1200)throw new Exception("Scroll too large");CheckTarget(a);var point=Cursor.Position;if(!bounds.Contains(point)||GetAncestor(WindowFromPoint(point),2)!=new IntPtr(Int64.Parse(Text(a,"windowId"))))throw new Exception("Scroll cursor is outside or covered; move inside target first");mouse_event(a.ContainsKey("horizontal")&&Convert.ToBoolean(a["horizontal"])?4096u:2048u,0,0,unchecked((uint)delta),UIntPtr.Zero);}
   else throw new Exception("Unsupported action");
   Console.WriteLine(json.Serialize(new {completed=true,inputDispatched=true,applicationEffectVerified=false,action=action}));return 0;
  }catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
 }
}
