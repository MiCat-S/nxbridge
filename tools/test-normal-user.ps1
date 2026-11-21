param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Worker,[Parameter(Mandatory=$true)][string]$Fixture)
chcp 65001 > $null
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
$ErrorActionPreference = 'Stop'
                                    
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class NxbridgeNormalUser {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {public int cb; public string reserved; public string desktop; public string title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {public IntPtr process,thread;public uint pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES {public IntPtr sid;public uint attributes;}
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferCreateLevel(uint scope,uint level,uint flags,out IntPtr handle,IntPtr reserved);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferComputeTokenFromLevel(IntPtr level,IntPtr input,out IntPtr token,uint flags,IntPtr reserved);
  [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr level);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref SID_AND_ATTRIBUTES value,uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
  public static int Run(string node,string worker,string fixture){
    IntPtr level=IntPtr.Zero,token=IntPtr.Zero,sid=IntPtr.Zero;PROCESS_INFORMATION process=new PROCESS_INFORMATION();
    try {
      Check(SaferCreateLevel(1,0x20000,1,out level,IntPtr.Zero));Check(SaferComputeTokenFromLevel(level,IntPtr.Zero,out token,0,IntPtr.Zero));
      Check(ConvertStringSidToSid("S-1-16-8192",out sid));var label=new SID_AND_ATTRIBUTES{sid=sid,attributes=0x20};Check(SetTokenInformation(token,25,ref label,(uint)Marshal.SizeOf(label)+GetLengthSid(sid)));
      var startup=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFO)),flags=1,show=0};
      var command=new StringBuilder("\""+node+"\" \""+worker+"\" \""+fixture+"\"");
      Check(CreateProcessAsUser(token,node,command,IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,System.IO.Path.GetDirectoryName(fixture),ref startup,out process));
      if(WaitForSingleObject(process.process,175000)!=0){TerminateProcess(process.process,124);throw new TimeoutException("非提权安装验收超过 175 秒。");}
      uint code;Check(GetExitCodeProcess(process.process,out code));return (int)code;
    } finally {if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);if(sid!=IntPtr.Zero)LocalFree(sid);if(token!=IntPtr.Zero)CloseHandle(token);if(level!=IntPtr.Zero)SaferCloseLevel(level);}
  }
}
'@
exit [NxbridgeNormalUser]::Run($Node,$Worker,$Fixture)
