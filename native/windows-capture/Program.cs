using System.Runtime.InteropServices;
using System.Text.Json;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

internal static class Program {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int L,T,R,B; }
 [DllImport("user32.dll")] static extern bool IsWindow(nint h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint h,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(nint h);
 [DllImport("user32.dll")] static extern bool IsIconic(nint h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(nint h,out Rect r);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(nint context);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint h,int attribute,out Rect value,int size);
 [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(nint adapter,int driverType,nint software,uint flags,nint levels,uint levelCount,uint sdk,out nint device,out int featureLevel,out nint context);
 [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgi,out nint device);
 [DllImport("combase.dll",CharSet=CharSet.Unicode)] static extern int WindowsCreateString(string value,int length,out nint result);
 [DllImport("combase.dll")] static extern int WindowsDeleteString(nint value);
 [DllImport("combase.dll")] static extern int RoGetActivationFactory(nint name,ref Guid iid,out nint factory);
 [ComImport,Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface CaptureInterop { nint CreateForWindow(nint window,ref Guid iid); nint CreateForMonitor(nint monitor,ref Guid iid); }
 static GraphicsCaptureItem Item(nint window) {
  string name="Windows.Graphics.Capture.GraphicsCaptureItem";
  Marshal.ThrowExceptionForHR(WindowsCreateString(name,name.Length,out var str));
  nint factory=0,item=0;
  try {
   var iid=typeof(CaptureInterop).GUID;
   Marshal.ThrowExceptionForHR(RoGetActivationFactory(str,ref iid,out factory));
   var interop=(CaptureInterop)Marshal.GetObjectForIUnknown(factory);
   try { var itemId=new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760"); item=interop.CreateForWindow(window,ref itemId); return MarshalInterface<GraphicsCaptureItem>.FromAbi(item); }
   finally { Marshal.ReleaseComObject(interop); }
  } finally {if(item!=0)Marshal.Release(item);if(factory!=0)Marshal.Release(factory);WindowsDeleteString(str);}
 }
 static IDirect3DDevice Device() {
  nint device=0,context=0,dxgi=0,inspectable=0;
  try {
   int hr=D3D11CreateDevice(0,1,0,0x20,0,0,7,out device,out _,out context);
   Marshal.ThrowExceptionForHR(hr);
   var iid=new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
   Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device,ref iid,out dxgi));
   Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out inspectable));
   return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
  } finally {foreach(var p in new[]{inspectable,dxgi,context,device})if(p!=0)Marshal.Release(p);}
 }
 static Rect Bounds(nint h) {
  if(!IsWindow(h)||!IsWindowVisible(h))throw new Exception("CAPTURE_UNAVAILABLE: window is closed or hidden");
  if(IsIconic(h))throw new Exception("CAPTURE_MINIMIZED: restore the target window");
  if(DwmGetWindowAttribute(h,9,out var r,Marshal.SizeOf<Rect>())<0&&!GetWindowRect(h,out r))throw new Exception("CAPTURE_BOUNDS: cannot read target bounds");
  if(r.R<=r.L||r.B<=r.T||(long)(r.R-r.L)*(r.B-r.T)>16000000)throw new Exception("CAPTURE_SIZE: invalid bounds or more than 16 million pixels");
  return r;
 }
 static async Task<object> Capture(nint h) {
  SetProcessDpiAwarenessContext(new nint(-4));
  var before=Bounds(h);
  if(!GraphicsCaptureSession.IsSupported())throw new Exception("CAPTURE_UNSUPPORTED: Windows Graphics Capture unavailable");
  var item=Item(h);
  using var device=Device();
  using var pool=Direct3D11CaptureFramePool.CreateFreeThreaded(device,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,item.Size);
  using var session=pool.CreateCaptureSession(item);
  session.IsCursorCaptureEnabled=false;
  var ready=new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
  pool.FrameArrived+=(sender,_)=>{try {var f=sender.TryGetNextFrame();if(f!=null&&!ready.TrySetResult(f))f.Dispose();}catch(Exception e){ready.TrySetException(e);}};
  session.StartCapture();
  using var frame=await ready.Task.WaitAsync(TimeSpan.FromSeconds(6));
  // Copy outside FrameArrived: waiting on the capture callback can deadlock WinRT.
  using var bitmap=await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface,BitmapAlphaMode.Premultiplied).AsTask().WaitAsync(TimeSpan.FromSeconds(6));
  var after=Bounds(h);
  if(!before.Equals(after)||frame.ContentSize.Width!=after.R-after.L||frame.ContentSize.Height!=after.B-after.T||bitmap.PixelWidth!=frame.ContentSize.Width||bitmap.PixelHeight!=frame.ContentSize.Height)
   throw new Exception("CAPTURE_CHANGED: dimensions changed; observe again before acting");
  using var stream=new InMemoryRandomAccessStream();
  var encoder=await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId,stream);
  encoder.SetSoftwareBitmap(bitmap);await encoder.FlushAsync();
  stream.Seek(0);using var reader=new DataReader(stream.GetInputStreamAt(0));
  await reader.LoadAsync((uint)stream.Size);byte[] bytes=new byte[(int)stream.Size];reader.ReadBytes(bytes);
  GetWindowThreadProcessId(h,out var pid);
  return new { processId=pid,image=Convert.ToBase64String(bytes),x=after.L,y=after.T,width=bitmap.PixelWidth,height=bitmap.PixelHeight,windowId=h.ToInt64().ToString(),capture="windows-graphics-capture",contentVerified=false,frameTimestampTicks=frame.SystemRelativeTime.Ticks,limitations="Fresh compositor frame; protected content, secure desktops and application rendering defects may still produce unavailable or blank content. No screen or PrintWindow fallback." };
 }
 [MTAThread] static int Main(string[] args) {
  try {var result=Capture(new nint(long.Parse(args[0]))).WaitAsync(TimeSpan.FromSeconds(15)).GetAwaiter().GetResult();Console.WriteLine(JsonSerializer.Serialize(result));return 0;}
  catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}
 }
}

