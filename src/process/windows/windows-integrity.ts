import {embeddedSource} from "../../shared/embedded-source.js";
export const windowsIntegritySource=                             embeddedSource("csharp", `
using System;using System.IO;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class NxIntegrityRepair {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string value,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static IntPtr Label(string value,out IntPtr descriptor){uint size;bool present,defaulted;IntPtr acl;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(value,1,out descriptor,out size)||!GetSecurityDescriptorSacl(descriptor,out present,out acl,out defaulted))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return acl;
 }
 public static void Repair(string root,bool recursive){
  IntPtr directories=IntPtr.Zero,files=IntPtr.Zero;
  try{
   IntPtr directoryAcl=Label("S:(ML;CI;NW;;;ME)",out directories),fileAcl=Label("S:(ML;;NW;;;ME)",out files);
   var pending=new Stack<string>();pending.Push(root);
   while(pending.Count>0){
    string current=pending.Pop();FileAttributes attributes=File.GetAttributes(current);
                                       
    if((attributes&FileAttributes.ReparsePoint)!=0)continue;
    bool directory=(attributes&FileAttributes.Directory)!=0;
                                                   
    if(!directory&&String.Equals(Path.GetExtension(current),".exe",StringComparison.OrdinalIgnoreCase))continue;
    uint error=SetNamedSecurityInfoW(current,1,16,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,directory?directoryAcl:fileAcl);
    if(error!=0)throw new System.ComponentModel.Win32Exception((int)error,current);
    if(directory&&recursive)foreach(string child in Directory.EnumerateFileSystemEntries(current))pending.Push(child);
   }
  }finally{if(directories!=IntPtr.Zero)LocalFree(directories);if(files!=IntPtr.Zero)LocalFree(files);}
 }
}
`);
                                              
export const windowsIntegrityScript=                                 embeddedSource("powershell", `
$ErrorActionPreference='Stop'
$files=[CodeDom.Compiler.TempFileCollection]::new($env:TEMP,$false)
$compiler=[CodeDom.Compiler.CompilerParameters]::new();$compiler.GenerateInMemory=$true;$compiler.TempFiles=$files;$null=$compiler.ReferencedAssemblies.Add('System.dll')
try{Add-Type -TypeDefinition $env:NXBRIDGE_INTEGRITY_SOURCE -CompilerParameters $compiler;[NxIntegrityRepair]::Repair($env:NXBRIDGE_INTEGRITY_PATH,$env:NXBRIDGE_INTEGRITY_RECURSIVE -eq 'yes')}
finally{$files.Delete()}
`);
