import {embeddedSource} from "../../shared/embedded-source.js";
                                      
                                             
export const windowsJobHolderSource=                             embeddedSource("csharp", `
public static class NxJobHolder {
 [StructLayout(LayoutKind.Sequential)] struct Association {public IntPtr key,port;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int cb;public string reserved,desktop,title;public int x,y,width,height,xchars,ychars,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Association value,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr port,IntPtr key,uint concurrency);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out IntPtr key,out IntPtr value,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
 static Exception Error(){return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 static string Pipe(string job){return job.Substring(job.LastIndexOf('\\\\')+1)+"-native";}
 static string Quote(string value){return "\\""+value.Replace("\\"","\\\\\\"")+"\\"";}
 static IntPtr Identity(uint pid,long generation) {
  IntPtr handle=OpenProcess(0x101000,false,pid);if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)return IntPtr.Zero;throw Error();}
  long created,exited,kernel,user;
  if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)){CloseHandle(handle);throw Error();}
  if(created!=generation){CloseHandle(handle);throw new InvalidOperationException("holder process generation changed");}return handle;
 }
                                                         
 public static string LaunchAttached(string name,uint pid,long generation,string completion) {
  string app=System.Reflection.Assembly.GetExecutingAssembly().Location;long own,exited,kernel,user;
  if(!GetProcessTimes(GetCurrentProcess(),out own,out exited,out kernel,out user))throw Error();
  using(var ready=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset,name+"-ready"))
  using(var commit=new System.Threading.EventWaitHandle(false,System.Threading.EventResetMode.ManualReset,name+"-commit")) {
   Startup startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));Info child;
   string command=Quote(app)+" job-hold "+Quote(name)+" "+pid+" "+generation+" "+GetCurrentProcessId()+" "+own+" direct "+Quote(completion);
   if(!CreateProcessW(app,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,null,ref startup,out child))throw Error();
   try{
    if(WaitForMultipleObjects(2,new IntPtr[]{ready.SafeWaitHandle.DangerousGetHandle(),child.process},false,10000)!=0)throw new InvalidOperationException("job holder startup unconfirmed");
    long created;if(!GetProcessTimes(child.process,out created,out exited,out kernel,out user))throw Error();
    commit.Set();return "{\\"name\\":"+NxHookIdentity.Json(name)+",\\"holder\\":{\\"pid\\":"+child.pid+",\\"startedAt\\":\\""+created+"\\"},\\"completionFile\\":"+NxHookIdentity.Json(completion)+"}";
   }finally{CloseHandle(child.thread);CloseHandle(child.process);}
  }
 }
 static int Complete(string file){try{Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));using(var receipt=new FileStream(file,FileMode.CreateNew,FileAccess.Write)){} }catch(IOException){if(!File.Exists(file))throw;}return 0;}
 static bool Empty(IntPtr job) {
  IntPtr accounting=Marshal.AllocHGlobal(48);
  try{uint returned;if(!QueryInformationJobObject(job,1,accounting,48,out returned))throw Error();return Marshal.ReadInt32(accounting,40)==0;}finally{Marshal.FreeHGlobal(accounting);}
 }
 public static int Declare(string[] args) {
  using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",Pipe(args[1]),System.IO.Pipes.PipeDirection.InOut)){
   pipe.Connect(10000);var output=new StreamWriter(pipe,new UTF8Encoding(false));output.AutoFlush=true;output.WriteLine(args[2]+" "+args[3]);
   string result=new StreamReader(pipe,Encoding.UTF8).ReadLine();if(result!="ok")throw new InvalidOperationException(result??"job holder disconnected");Console.Write("\\"ok\\"");return 0;
  }
 }
 public static int Run(string[] args) {
  string name=args[1];uint pid=UInt32.Parse(args[2]),parentPid=UInt32.Parse(args[4]);long generation=Int64.Parse(args[3]),parentGeneration=Int64.Parse(args[5]);bool handoff=args[6]=="handoff";
  IntPtr job=IntPtr.Zero,port=IntPtr.Zero,parent=IntPtr.Zero,root=IntPtr.Zero,native=IntPtr.Zero;
  System.IO.Pipes.NamedPipeServerStream server=null;System.Threading.Thread receiver=null,watcher=null;
  var closing=new System.Threading.ManualResetEvent(false);
  try{
   job=OpenJobObjectW(14,false,name);if(job==IntPtr.Zero)throw Error();
   root=Identity(pid,generation);if(root==IntPtr.Zero)throw new InvalidOperationException("job root exited before holder");
   parent=Identity(parentPid,parentGeneration);if(parent==IntPtr.Zero)throw new InvalidOperationException("job launcher exited before holder");
   port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1);if(port==IntPtr.Zero)throw Error();
   Association association=new Association();association.port=port;
   if(!SetInformationJobObject(job,7,ref association,(uint)Marshal.SizeOf(typeof(Association))))throw Error();
   using(var ready=System.Threading.EventWaitHandle.OpenExisting(name+"-ready"))
   using(var commit=System.Threading.EventWaitHandle.OpenExisting(name+"-commit")){
    if(handoff)server=new System.IO.Pipes.NamedPipeServerStream(Pipe(name),System.IO.Pipes.PipeDirection.InOut,1,System.IO.Pipes.PipeTransmissionMode.Byte,System.IO.Pipes.PipeOptions.Asynchronous);
    ready.Set();uint state=WaitForMultipleObjects(2,new IntPtr[]{commit.SafeWaitHandle.DangerousGetHandle(),parent},false,0xffffffff);
    if(state!=0){if(!TerminateJobObject(job,1))throw Error();}
    else if(!handoff){IntPtr held=root;watcher=new System.Threading.Thread(()=>{if(WaitForMultipleObjects(2,new IntPtr[]{closing.SafeWaitHandle.DangerousGetHandle(),held},false,0xffffffff)==1)TerminateJobObject(job,1);}){IsBackground=true};watcher.Start();}
    else {
     var channel=server;uint nativePid=0;long nativeGeneration=0;
                                                
     receiver=new System.Threading.Thread(()=>{
      while(!closing.WaitOne(0)){
       IntPtr candidate=IntPtr.Zero;
       try{
        channel.WaitForConnection();string reply;
        try{
         var input=new StreamReader(channel,Encoding.UTF8);var read=input.ReadLineAsync();
         if(!read.Wait(10000))throw new InvalidOperationException("native declaration timed out");
         string line=read.Result;string[] values=line==null?new string[0]:line.Split(' ');uint requestedPid;long requestedGeneration;
         if(values.Length!=2||!UInt32.TryParse(values[0],out requestedPid)||requestedPid==0||!Int64.TryParse(values[1],out requestedGeneration)||requestedGeneration<=0)throw new InvalidOperationException("invalid native declaration");
         if(native!=IntPtr.Zero){if(requestedPid!=nativePid||requestedGeneration!=nativeGeneration)throw new InvalidOperationException("native root already declared");}
         else{
          candidate=Identity(requestedPid,requestedGeneration);
          if(candidate==IntPtr.Zero)throw new InvalidOperationException("native root exited before declaration");
          bool inside;if(!IsProcessInJob(candidate,job,out inside))throw Error();
          if(!inside||WaitForSingleObject(candidate,0)!=258)throw new InvalidOperationException("native root is not a live member of this Job");
          native=candidate;candidate=IntPtr.Zero;nativePid=requestedPid;nativeGeneration=requestedGeneration;
          IntPtr held=native;
          watcher=new System.Threading.Thread(()=>{if(WaitForMultipleObjects(2,new IntPtr[]{closing.SafeWaitHandle.DangerousGetHandle(),held},false,0xffffffff)==1)TerminateJobObject(job,1);}){IsBackground=true};watcher.Start();
         }
         reply="ok";
        }catch(Exception error){reply=error.Message;}
        var output=new StreamWriter(channel,new UTF8Encoding(false));output.AutoFlush=true;output.WriteLine(reply);
                                                       
        channel.WaitForPipeDrain();
       }catch(Exception){if(closing.WaitOne(0))break;}
       finally{if(candidate!=IntPtr.Zero)CloseHandle(candidate);try{if(channel.IsConnected)channel.Disconnect();}catch{}}
      }
     }){IsBackground=true};receiver.Start();
    }
   }
                                                   
   for(;;){
    if(Empty(job))return Complete(args[7]);
    uint message;IntPtr key,value;
    if(!GetQueuedCompletionStatus(port,out message,out key,out value,3000)&&Marshal.GetLastWin32Error()!=258)throw Error();
   }
  }finally{
   closing.Set();if(server!=null)server.Dispose();if(receiver!=null)receiver.Join();if(watcher!=null)watcher.Join();
   foreach(IntPtr handle in new IntPtr[]{native,root,parent,job,port})if(handle!=IntPtr.Zero)CloseHandle(handle);closing.Dispose();
  }
 }
}
`);

                                                         
export const windowsHookIdentitySource=                             embeddedSource("csharp", `
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class NxHookIdentity {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public IntPtr reserved1,peb,reserved2a,reserved2b;public UIntPtr pid,parent;}
 [StructLayout(LayoutKind.Sequential)] struct Unicode {public ushort length,maximum;public IntPtr buffer;}
 sealed class HeldProcess {public uint pid,parent;public long created;public IntPtr handle;public string image,launchImage;}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder image,ref int size);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out Basic info,int size,out int returned);
 [DllImport("ntdll.dll",EntryPoint="NtQueryInformationProcess")] static extern int QueryCommand(IntPtr process,int kind,IntPtr info,int size,out int returned);
 static string Command(IntPtr process) {
  int needed;QueryCommand(process,60,IntPtr.Zero,0,out needed);
  if(needed<Marshal.SizeOf(typeof(Unicode))||needed>1048576)throw new InvalidOperationException("native command line size unavailable");
  IntPtr buffer=Marshal.AllocHGlobal(needed);
  try {
   int returned;if(QueryCommand(process,60,buffer,needed,out returned)!=0)throw new InvalidOperationException("native command line unavailable");
   Unicode value=(Unicode)Marshal.PtrToStructure(buffer,typeof(Unicode));long offset=value.buffer.ToInt64()-buffer.ToInt64();
   if(value.length%2!=0||offset<0||offset+value.length>needed)throw new InvalidOperationException("native command line range invalid");
   return Marshal.PtrToStringUni(value.buffer,value.length/2);
  } finally {Marshal.FreeHGlobal(buffer);}
 }
 internal static string Json(string text) {
  StringBuilder result=new StringBuilder("\\"");foreach(char ch in text){if(ch=='"'||ch=='\\\\')result.Append('\\\\').Append(ch);else if(ch<32||Char.IsSurrogate(ch))result.Append("\\\\u").Append(((int)ch).ToString("x4"));else result.Append(ch);}return result.Append('"').ToString();
 }
 static string ImageName(string image) {return image.Substring(image.LastIndexOf('\\\\')+1);}
 internal static string Image(IntPtr handle) {
  int length=32768;StringBuilder image=new StringBuilder(length);
  if(!QueryFullProcessImageNameW(handle,0,image,ref length)) {
   image.Clear();length=32768;
   if(!QueryFullProcessImageNameW(handle,1,image,ref length))throw new InvalidOperationException("native process image unavailable");
  }
  return image.ToString();
 }
                                                    
 static string HostImage(string image,string host) {
  string name=ImageName(image),official=host+".exe",prefix=official+".old.";
  if(String.Equals(name,official,StringComparison.OrdinalIgnoreCase))return image;
  if(!name.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)||name.Length==prefix.Length)return null;
  for(int i=prefix.Length;i<name.Length;i++)if(name[i]<'0'||name[i]>'9')return null;
  string current=image.Substring(0,image.Length-name.Length)+official;
  return current;
 }
 static string LaunchImage(string image) {
  foreach(string host in new string[]{"claude","codex"}){string candidate=HostImage(image,host);if(candidate!=null)return candidate;}
  return image;
 }
 static int Ancestors(string[] args) {
  uint pid;int depth;
  if(args.Length!=3||!UInt32.TryParse(args[1],out pid)||pid==0||!Int32.TryParse(args[2],out depth)||depth<1)throw new ArgumentException("invalid ancestry request");
  List<HeldProcess> rows=new List<HeldProcess>();List<IntPtr> handles=new List<IntPtr>();HashSet<uint> seen=new HashSet<uint>();
  bool complete=false;string reason="depth";
  try {
   long childCreated=Int64.MaxValue;
   while(pid>0&&rows.Count<depth) {
                                                        
    if(!seen.Add(pid)){complete=true;reason="parent_reused";break;}
                                           
    IntPtr handle=OpenProcess(0x101000,false,pid);
    if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87){complete=true;reason=rows.Count==0?"missing":"parent_missing";}else reason="access";break;}
    handles.Add(handle);Basic info;int returned;long created,exited,kernel,user;
    if(NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(Basic)),out returned)!=0||!GetProcessTimes(handle,out created,out exited,out kernel,out user)){reason="query";break;}
    if(info.pid.ToUInt64()!=pid||info.parent.ToUInt64()>Int32.MaxValue)throw new InvalidOperationException("native ancestry identity changed");
    if(WaitForSingleObject(handle,0)!=258){complete=true;reason=rows.Count==0?"missing":"parent_missing";handles.RemoveAt(handles.Count-1);CloseHandle(handle);break;}
                                                 
    if(created>childCreated){complete=true;reason="parent_reused";handles.RemoveAt(handles.Count-1);CloseHandle(handle);break;}
    string image;try{image=Image(handle);}catch(InvalidOperationException){reason="image";break;}
    rows.Add(new HeldProcess{pid=pid,parent=(uint)info.parent.ToUInt64(),created=created,handle=handle,image=image,launchImage=LaunchImage(image)});
    childCreated=created;pid=(uint)info.parent.ToUInt64();
   }
   if(pid==0){complete=true;reason="root";}
   for(int index=0;index<handles.Count;index++){
    uint state=WaitForSingleObject(handles[index],0);
    if(state==258)continue;
    if(index<rows.Count)rows.RemoveRange(index,rows.Count-index);
    complete=state==0;reason=complete?(rows.Count==0?"missing":"parent_missing"):"query";break;
   }
   List<string> result=new List<string>();
   foreach(HeldProcess row in rows)result.Add("{\\"pid\\":"+row.pid+",\\"parentPid\\":"+row.parent+",\\"name\\":"+Json(ImageName(row.launchImage))+",\\"image\\":"+Json(row.image)+",\\"launchImage\\":"+Json(row.launchImage)+",\\"startedAt\\":"+Json(row.created.ToString())+",\\"procStart\\":"+Json((DateTime.FromFileTime(row.created).Ticks/10*10).ToString())+",\\"procStartFt\\":"+Json(row.created.ToString())+"}");
   Console.Write("{\\"ancestors\\":["+String.Join(",",result.ToArray())+"],\\"complete\\":"+(complete?"true":"false")+",\\"reason\\":"+Json(reason)+"}");return 0;
  }finally{foreach(IntPtr handle in handles)CloseHandle(handle);}
 }
 static int Probe(string[] args) {
  List<string> rows=new List<string>();
  for(int index=1;index<args.Length;index++) {
   uint pid;if(!UInt32.TryParse(args[index],out pid)||pid==0)continue;
   IntPtr handle=OpenProcess(0x101000,false,pid);
   if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)rows.Add("{\\"pid\\":"+pid+",\\"missing\\":true}");continue;}
   try {
    long created,exited,kernel,user;
    if(WaitForSingleObject(handle,0)==0){rows.Add("{\\"pid\\":"+pid+",\\"missing\\":true}");continue;}
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))continue;
    if(WaitForSingleObject(handle,0)!=258){rows.Add("{\\"pid\\":"+pid+",\\"missing\\":true}");continue;}
    rows.Add("{\\"pid\\":"+pid+",\\"generation\\":"+Json(created.ToString())+",\\"ticks\\":"+Json(DateTime.FromFileTimeUtc(created).Ticks.ToString())+"}");
   }finally{CloseHandle(handle);}
  }
  Console.Write("["+String.Join(",",rows.ToArray())+"]");return 0;
 }
 static int Stop(string[] args) {
  uint pid,timeout;long generation;
  if(args.Length!=4||!UInt32.TryParse(args[1],out pid)||pid==0||!Int64.TryParse(args[2],out generation)||!UInt32.TryParse(args[3],out timeout))throw new ArgumentException("invalid stop request");
  IntPtr handle=OpenProcess(0x101000,false,pid),termination=IntPtr.Zero;
  if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87){Console.Write("\\"dead\\"");return 0;}throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
  try {
   long created,exited,kernel,user;
   if(!GetProcessTimes(handle,out created,out exited,out kernel,out user))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   if(created!=generation||WaitForSingleObject(handle,0)==0){Console.Write("\\"dead\\"");return 0;}
                                              
   if(!DuplicateHandle(GetCurrentProcess(),handle,GetCurrentProcess(),out termination,1,false,0))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   if(!TerminateProcess(termination,1)){int error=Marshal.GetLastWin32Error();if(error!=5)throw new System.ComponentModel.Win32Exception(error);}
   uint state=WaitForSingleObject(handle,timeout);
   if(state!=0&&state!=258)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   Console.Write(state==0?"\\"dead\\"":"\\"pending\\"");return 0;
  }finally{if(termination!=IntPtr.Zero)CloseHandle(termination);CloseHandle(handle);}
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 static List<HeldProcess> JobMembers(IntPtr job,uint rootPid,long generation) {
  List<HeldProcess> rows=new List<HeldProcess>();int size=4096;
  try {
   for(;;) {
    IntPtr data=Marshal.AllocHGlobal(size);
    try {
     uint returned;
     if(!QueryInformationJobObject(job,3,data,(uint)size,out returned)){if(Marshal.GetLastWin32Error()==234){size*=2;continue;}throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
     int count=Marshal.ReadInt32(data,4);
     for(int i=0;i<count;i++) {
      uint pid=(uint)Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64();IntPtr handle=OpenProcess(0x101000,false,pid);
      if(handle==IntPtr.Zero){if(Marshal.GetLastWin32Error()==87)continue;throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
      bool keep=false;
      try {
       bool inside;long created,exited,kernel,user;Basic info;int needed;
       if(WaitForSingleObject(handle,0)==0)continue;
       if(!IsProcessInJob(handle,job,out inside))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
       if(!inside)continue;
       if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)||NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(Basic)),out needed)!=0)throw new InvalidOperationException("job member identity unavailable");
       if(created<generation||pid==rootPid&&created!=generation)throw new InvalidOperationException("job root generation changed");
       string image;try{image=Image(handle);}catch(InvalidOperationException){if(WaitForSingleObject(handle,0)==0)continue;throw;}
       rows.Add(new HeldProcess{pid=pid,parent=(uint)info.parent.ToUInt64(),created=created,handle=handle,image=image,launchImage=LaunchImage(image)});keep=true;
      }finally{if(!keep)CloseHandle(handle);}
     }
     return rows;
    }finally{Marshal.FreeHGlobal(data);}
   }
  }catch{foreach(HeldProcess row in rows)CloseHandle(row.handle);throw;}
 }
 static int Job(string[] args) {
  uint pid;long generation;
  if(args.Length<4||!UInt32.TryParse(args[2],out pid)||!Int64.TryParse(args[3],out generation))throw new ArgumentException("invalid job request");
  bool stop=args[0]=="job-stop";IntPtr job=OpenJobObjectW(stop?12u:4u,false,args[1]);
  if(job==IntPtr.Zero){if(Marshal.GetLastWin32Error()==2)throw new InvalidOperationException("job_holder_missing");throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
  List<HeldProcess> rows=null;
  try {
   if(stop){bool inside;if(!IsProcessInJob(GetCurrentProcess(),job,out inside))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if(inside)throw new InvalidOperationException("job_contains_caller");}
   rows=JobMembers(job,pid,generation);
   if(!stop&&rows.Count==0){IntPtr count=Marshal.AllocHGlobal(48);try{uint returned;if(!QueryInformationJobObject(job,1,count,48,out returned))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if(Marshal.ReadInt32(count,40)!=0)throw new InvalidOperationException("job members changed during observation");}finally{Marshal.FreeHGlobal(count);}}
   if(stop) {
    uint timeout;if(args.Length!=5||!UInt32.TryParse(args[4],out timeout))throw new ArgumentException("invalid job timeout");
    if(!TerminateJobObject(job,1))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    DateTime deadline=DateTime.UtcNow.AddMilliseconds(timeout);
    foreach(HeldProcess row in rows){uint left=(uint)Math.Max(0,(deadline-DateTime.UtcNow).TotalMilliseconds);if(WaitForSingleObject(row.handle,left)!=0){Console.Write("\\"pending\\"");return 0;}}
                                                 
    IntPtr accounting=Marshal.AllocHGlobal(48);
    try{for(;;){uint returned;if(!QueryInformationJobObject(job,1,accounting,48,out returned))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());if(Marshal.ReadInt32(accounting,40)==0)break;if(DateTime.UtcNow>=deadline){Console.Write("\\"pending\\"");return 0;}System.Threading.Thread.Sleep(10);}}
    finally{Marshal.FreeHGlobal(accounting);}
    Console.Write("\\"dead\\"");return 0;
   }
   List<string> result=new List<string>();
   foreach(HeldProcess row in rows)if(WaitForSingleObject(row.handle,0)==258)result.Add("{\\"pid\\":"+row.pid+",\\"parentPid\\":"+row.parent+",\\"name\\":"+Json(ImageName(row.launchImage))+",\\"image\\":"+Json(row.image)+",\\"launchImage\\":"+Json(row.launchImage)+",\\"startedAt\\":"+Json(row.created.ToString())+",\\"procStartFt\\":"+Json(row.created.ToString())+"}");
   Console.Write("["+String.Join(",",result.ToArray())+"]");return 0;
  }finally{if(rows!=null)foreach(HeldProcess row in rows)CloseHandle(row.handle);CloseHandle(job);}
 }
 public static int Main(string[] args) {
  if(args.Length>0&&args[0]=="run")return NxOwnedCommand.Run(args);
  Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
  if(args.Length!=1||args[0]!="serve")return Execute(args);
                                            
  TextWriter output=Console.Out,errors=Console.Error;string line;
  while((line=Console.ReadLine())!=null){
   string[] parts=line.Split(' ');int id;
   if(parts.Length!=3||!Int32.TryParse(parts[0],out id))return 1;
   using(StringWriter result=new StringWriter())using(StringWriter error=new StringWriter()){
    int code;Console.SetOut(result);Console.SetError(error);
    try{code=Execute(new string[]{parts[1],parts[2]});}finally{Console.SetOut(output);Console.SetError(errors);}
    output.WriteLine("{\\"id\\":"+id+",\\"result\\":"+(code==0?result.ToString():"null")+",\\"error\\":"+(code==0?"null":Json(error.ToString().Trim()))+"}");output.Flush();
   }
  }
  return 0;
 }
 static int Execute(string[] args) {
  List<IntPtr> handles=new List<IntPtr>();
  try {
   if(args.Length>0&&args[0]=="probe")return Probe(args);
   if(args.Length>0&&args[0]=="stop")return Stop(args);
   if(args.Length>0&&args[0]=="job-attach")return NxOwnedCommand.Attach(args);
   if(args.Length>0&&args[0]=="job-hold")return NxJobHolder.Run(args);
   if(args.Length>0&&args[0]=="job-root")return NxJobHolder.Declare(args);
   if(args.Length>0&&(args[0]=="job-members"||args[0]=="job-stop"))return Job(args);
   if(args.Length>0&&args[0]=="ancestors")return Ancestors(args);
   string host=args.Length==2?args[0]:"codex";bool hook=host=="codex-hook"||host=="claude-hook";if(hook)host=host.Substring(0,host.Length-5);bool exact=host=="process";if(!exact&&host!="codex"&&host!="claude")throw new ArgumentException("invalid native host");
   uint pid;if((args.Length!=1&&args.Length!=2)||!UInt32.TryParse(args[args.Length-1],out pid)||pid==0)throw new ArgumentException("invalid ancestor pid");
   HashSet<uint> seen=new HashSet<uint>();long childCreated=Int64.MaxValue;
   for(int depth=0;depth<(exact?1:hook?11:10)&&pid>0&&seen.Add(pid);depth++) {
    IntPtr handle=OpenProcess(0x101010,false,pid);if(handle==IntPtr.Zero)throw new InvalidOperationException("native ancestor handle unavailable");handles.Add(handle);
    Basic info;int returned;long created,exited,kernel,user;
    if(NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(Basic)),out returned)!=0||info.pid.ToUInt64()!=pid||info.parent.ToUInt64()>Int32.MaxValue)throw new InvalidOperationException("native ancestor information unavailable");
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)||created>childCreated||WaitForSingleObject(handle,0)!=258)throw new InvalidOperationException("native ancestor generation changed");
    string image=Image(handle),launch=exact?LaunchImage(image):hook&&depth==0?null:HostImage(image,host);
    if(launch!=null) {
     string command=Command(handle);foreach(IntPtr ancestor in handles)if(WaitForSingleObject(ancestor,0)!=258)throw new InvalidOperationException("native ancestor exited during query");
     Console.Write("{\\"pid\\":"+pid+",\\"parentPid\\":"+info.parent.ToUInt64()+",\\"image\\":"+Json(image)+",\\"launchImage\\":"+Json(launch)+",\\"procStart\\":"+Json(created.ToString())+",\\"procStartTicks\\":"+Json((DateTime.FromFileTime(created).Ticks/10*10).ToString())+",\\"commandLine\\":"+Json(command)+"}");return 0;
    }
    childCreated=created;pid=(uint)info.parent.ToUInt64();
   }
   throw new InvalidOperationException("native host ancestor not found");
  }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
  finally{foreach(IntPtr handle in handles)CloseHandle(handle);}
 }
}
                                                   
public static class NxOwnedCommand {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int cb;public string reserved,desktop,title;public int x,y,width,height,xchars,ychars,fill,flags;public short show,reservedSize;public IntPtr reservedBytes,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup startup;public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {public IntPtr reserved1,peb,reserved2a,reserved2b;public UIntPtr pid,parent;}
 [StructLayout(LayoutKind.Sequential)] struct JobBasic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct JobIo {public ulong r,w,o,rb,wb,ob;}
 [StructLayout(LayoutKind.Sequential)] struct JobLimits {public JobBasic basic;public JobIo io;public UIntPtr process,job,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint QueryDosDeviceW(string device,StringBuilder target,int length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint milliseconds);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,out Basic info,int size,out int returned);
 static Exception NativeError() {return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 static void Confirm(Stream status) {int value;do{value=status.ReadByte();if(value<0)throw new InvalidOperationException("command owner pipe closed");}while(value!=10);}
 static bool SystemConsoleHost(string image) {
  string expected=Path.Combine(Environment.SystemDirectory,"conhost.exe");
  if(String.Equals(image,expected,StringComparison.OrdinalIgnoreCase))return true;
                                                
  string root=Path.GetPathRoot(expected);StringBuilder device=new StringBuilder(32768);
  return QueryDosDeviceW(root.TrimEnd('\\\\'),device,device.Capacity)!=0&&String.Equals(image,device.ToString()+expected.Substring(root.Length-1),StringComparison.OrdinalIgnoreCase);
 }
 static bool SettleJob(IntPtr job,IntPtr parent) {
                                                             
  IntPtr accounting=Marshal.AllocHGlobal(48);System.Diagnostics.Stopwatch elapsed=System.Diagnostics.Stopwatch.StartNew();
  try{for(;;){
   if(WaitForSingleObject(parent,0)==0)return false;
   uint returned;if(!QueryInformationJobObject(job,1,accounting,48,out returned))throw NativeError();
   if(Marshal.ReadInt32(accounting,40)==0)return true;
   int remaining=2000-(int)elapsed.ElapsedMilliseconds;if(remaining<=0)return true;
   if(WaitForSingleObject(parent,(uint)Math.Min(50,remaining))==0)return false;
  }}finally{Marshal.FreeHGlobal(accounting);}
 }
 static string Survivors(IntPtr job) {
  int size=256;
  for(;;){IntPtr data=Marshal.AllocHGlobal(size);try{
   uint returned;if(!QueryInformationJobObject(job,3,data,(uint)size,out returned)){if(Marshal.GetLastWin32Error()==234){size*=2;continue;}throw NativeError();}
   List<string> images=new List<string>();int count=Marshal.ReadInt32(data,4);
   for(int index=0;index<count;index++){
    uint pid=(uint)Marshal.ReadIntPtr(data,8+index*IntPtr.Size).ToInt64();IntPtr process=OpenProcess(0x101000,false,pid);if(process==IntPtr.Zero)continue;
    try{bool inside;if(!IsProcessInJob(process,job,out inside)||!inside||WaitForSingleObject(process,0)!=258)continue;string image=NxHookIdentity.Image(process);if(!SystemConsoleHost(image))images.Add(NxHookIdentity.Json(image.Substring(image.LastIndexOf('\\\\')+1)));}finally{CloseHandle(process);}
   }
   return "["+String.Join(",",images.ToArray())+"]";
  }finally{Marshal.FreeHGlobal(data);}}
 }
 static string Argument(string value) {
  StringBuilder result=new StringBuilder("\\"");int slashes=0;
  foreach(char ch in value){if(ch=='\\\\'){slashes++;continue;}if(ch=='"'){result.Append('\\\\',slashes*2+1).Append(ch);slashes=0;continue;}result.Append('\\\\',slashes).Append(ch);slashes=0;}
  return result.Append('\\\\',slashes*2).Append('"').ToString();
 }
                                            
 public static int Attach(string[] args) {
  uint pid;long generation;
  if(args.Length!=4||!UInt32.TryParse(args[1],out pid)||!Int64.TryParse(args[2],out generation))throw new ArgumentException("invalid gated child");
  IntPtr child=OpenProcess(0x101101,false,pid);if(child==IntPtr.Zero)throw NativeError();IntPtr job=IntPtr.Zero;
  try {
   Basic own,target;int returned;long created,exited,kernel,user;
   if(NtQueryInformationProcess(GetCurrentProcess(),0,out own,Marshal.SizeOf(typeof(Basic)),out returned)!=0||NtQueryInformationProcess(child,0,out target,Marshal.SizeOf(typeof(Basic)),out returned)!=0||target.parent!=own.parent)throw new InvalidOperationException("gated child is not caller's direct child");
   if(!GetProcessTimes(child,out created,out exited,out kernel,out user)||created!=generation||WaitForSingleObject(child,0)!=258)throw new InvalidOperationException("gated child generation changed");
   string name="Global\\\\nxbridge-job-"+Guid.NewGuid().ToString("N");job=CreateJobObjectW(IntPtr.Zero,name);if(job==IntPtr.Zero)throw NativeError();
   JobLimits limits=new JobLimits();limits.basic.flags=0x0800;int size=Marshal.SizeOf(typeof(JobLimits));IntPtr data=Marshal.AllocHGlobal(size);
   try{Marshal.StructureToPtr(limits,data,false);if(!SetInformationJobObject(job,9,data,(uint)size))throw NativeError();}finally{Marshal.FreeHGlobal(data);}
   if(!AssignProcessToJobObject(job,child))throw NativeError();Console.Write(NxJobHolder.LaunchAttached(name,pid,generation,args[3]));return 0;
  }finally{if(job!=IntPtr.Zero)CloseHandle(job);CloseHandle(child);}
 }
 public static int Run(string[] args) {
  IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,attributes=IntPtr.Zero,list=IntPtr.Zero,jobList=IntPtr.Zero;Info child=new Info();bool initialized=false,assigned=false;string phase="ownership";
  System.IO.Pipes.NamedPipeClientStream status=null;StreamWriter report=null;
  List<IntPtr> inherited=new List<IntPtr>();
  try {
   uint parentPid;if(args.Length<4||!UInt32.TryParse(args[1],out parentPid)||parentPid==0)throw new ArgumentException("invalid command owner");
   status=new System.IO.Pipes.NamedPipeClientStream(".",args[2],System.IO.Pipes.PipeDirection.InOut);status.Connect(10000);report=new StreamWriter(status,new UTF8Encoding(false));report.AutoFlush=true;
   Basic own;int returned;IntPtr current=GetCurrentProcess();
   if(NtQueryInformationProcess(current,0,out own,Marshal.SizeOf(typeof(Basic)),out returned)!=0||own.parent.ToUInt64()!=parentPid)throw new InvalidOperationException("command owner changed");
   parent=OpenProcess(0x101000,false,parentPid);if(parent==IntPtr.Zero)throw NativeError();
   long parentCreated,ownCreated,exited,kernel,user;
   if(!GetProcessTimes(parent,out parentCreated,out exited,out kernel,out user)||!GetProcessTimes(current,out ownCreated,out exited,out kernel,out user)||parentCreated>ownCreated||WaitForSingleObject(parent,0)!=258)throw new InvalidOperationException("command owner exited");
   job=CreateJobObjectW(IntPtr.Zero,null);if(job==IntPtr.Zero)throw NativeError();
   JobLimits limits=new JobLimits();limits.basic.flags=0x2000;
   int size=Marshal.SizeOf(typeof(JobLimits));IntPtr data=Marshal.AllocHGlobal(size);
   try {Marshal.StructureToPtr(limits,data,false);if(!SetInformationJobObject(job,9,data,(uint)size))throw NativeError();}finally{Marshal.FreeHGlobal(data);}
   StartupEx startup=new StartupEx();startup.startup.cb=Marshal.SizeOf(typeof(StartupEx));startup.startup.flags=0x100;
   foreach(int kind in new int[]{-10,-11,-12}){IntPtr handle;if(!DuplicateHandle(current,GetStdHandle(kind),current,out handle,0,true,2))throw NativeError();inherited.Add(handle);}
   startup.startup.input=inherited[0];startup.startup.output=inherited[1];startup.startup.error=inherited[2];
   IntPtr needed=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref needed);attributes=Marshal.AllocHGlobal(needed);
   if(!InitializeProcThreadAttributeList(attributes,2,0,ref needed))throw NativeError();initialized=true;
   list=Marshal.AllocHGlobal(IntPtr.Size*3);for(int index=0;index<3;index++)Marshal.WriteIntPtr(list,index*IntPtr.Size,inherited[index]);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw NativeError();startup.attributes=attributes;
                                                          
   jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero))throw NativeError();
   StringBuilder command=new StringBuilder();for(int index=3;index<args.Length;index++){if(index>3)command.Append(' ');command.Append(Argument(args[index]));}
   phase="spawn";if(!CreateProcessW(args[3],command,IntPtr.Zero,IntPtr.Zero,true,0x08000000|0x00000004|0x00080000,IntPtr.Zero,null,ref startup,out child))throw NativeError();phase="ownership";
   assigned=true;
   if(WaitForSingleObject(parent,0)!=258)throw new InvalidOperationException("command owner exited before resume");
   report.WriteLine("{\\"kind\\":\\"started\\"}");Confirm(status);
   if(ResumeThread(child.thread)==0xffffffff)throw NativeError();
   uint wait=WaitForMultipleObjects(2,new IntPtr[]{child.process,parent},false,0xffffffff);
   if(wait>1)throw NativeError();
   if(wait==1){if(!TerminateJobObject(job,1))throw NativeError();return 1;}
   uint code;if(!GetExitCodeProcess(child.process,out code))throw NativeError();
   if(!SettleJob(job,parent)){if(!TerminateJobObject(job,1))throw NativeError();return 1;}
   string survivors=Survivors(job);if(survivors!="[]"){report.WriteLine("{\\"kind\\":\\"survivors\\",\\"images\\":"+survivors+"}");Confirm(status);}
                                            
   if(!TerminateJobObject(job,code))throw NativeError();return unchecked((int)code);
  }catch(Exception error){
   try{if(report!=null){System.ComponentModel.Win32Exception native=error as System.ComponentModel.Win32Exception;report.WriteLine("{\\"kind\\":"+NxHookIdentity.Json(phase)+",\\"code\\":"+(native!=null?native.NativeErrorCode:0)+",\\"command\\":"+NxHookIdentity.Json(args[3])+",\\"message\\":"+NxHookIdentity.Json(error.Message)+"}");Confirm(status);}}
   catch{}Console.Error.WriteLine("nxbridge command ownership: "+error.Message);return 125;
  }
  finally {
   if(child.process!=IntPtr.Zero&&!assigned){TerminateProcess(child.process,1);WaitForSingleObject(child.process,5000);}
   if(job!=IntPtr.Zero)CloseHandle(job);
   if(child.process!=IntPtr.Zero)CloseHandle(child.process);if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);
   if(parent!=IntPtr.Zero)CloseHandle(parent);foreach(IntPtr handle in inherited)CloseHandle(handle);
   if(report!=null)report.Dispose();else if(status!=null)status.Dispose();
   if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);
  }
 }
}`)+windowsJobHolderSource;
