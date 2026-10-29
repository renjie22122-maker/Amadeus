using System;using System.IO;using System.Windows;using System.Windows.Media;using System.Windows.Threading;using System.Web.Script.Serialization;using System.Windows.Interop;
public class WgcRenderFixture {
 [STAThread] public static void Main(string[] args){
  var app=new Application();var target=new Window{Title="Amadeus WGC rendered target",Left=160,Top=160,Width=400,Height=300,Background=new SolidColorBrush(Color.FromRgb(220,30,40))};
  var cover=new Window{Title="Amadeus WGC occluder",Left=160,Top=160,Width=400,Height=300,Background=Brushes.Blue};
  var timer=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(100)};int ticks=0;bool changed=false;
  target.Loaded+=(s,e)=>{cover.Show();timer.Start();};
  timer.Tick+=(s,e)=>{
   if(++ticks==10)File.WriteAllText(args[0],new JavaScriptSerializer().Serialize(new{target=new WindowInteropHelper(target).Handle.ToInt64().ToString(),tier=RenderCapability.Tier>>16}));
   if(!changed&&File.Exists(args[1])){changed=true;target.Background=new SolidColorBrush(Color.FromRgb(20,200,60));}
  };
  app.Run(target);
 }
}
