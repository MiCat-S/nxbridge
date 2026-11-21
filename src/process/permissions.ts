import {embeddedSource} from "../shared/embedded-source.js";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../shared/errors.js';
import {windowsTool,windowsPowerShell} from '../shared/windows-tools.js';
import {windowsIntegritySource,windowsIntegrityScript} from './windows/windows-integrity.js';
const execute=promisify(execFile);
const privateDirectories=new Map<string,Promise<void>|null>();
let windowsSid:Promise<string>|undefined;
function currentWindowsSid():Promise<string>{
  return windowsSid??=execute(windowsTool('whoami.exe'),['/user','/fo','csv','/nh'],{windowsHide:true}).then(({stdout})=>{
    const sid=stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if(!sid)throw new BridgeError('identity_unavailable','无法取得当前 Windows 用户 SID。');
    return sid;
  }).catch(error=>{windowsSid=undefined;throw error;});
}

                                              
export async function privateDirectory(directory: string,repair=false,recursiveRepair=false): Promise<void> {
  const created=mkdirSync(directory,{recursive:true,mode:0o700}),key=path.resolve(directory),pending=privateDirectories.get(key);
  if(pending){if(repair)await pending.catch(()=>{});else await pending;}
  if(created===undefined&&!repair&&privateDirectories.get(key)!==null)return;
  const work=protectDirectory(directory,repair,recursiveRepair);privateDirectories.set(key,work);
  try{await work;if(privateDirectories.get(key)===work)privateDirectories.delete(key);}
                                                       
  catch(error){if(privateDirectories.get(key)===work)privateDirectories.set(key,null);throw error;}
}

async function protectDirectory(directory:string,repair:boolean,recursiveRepair:boolean):Promise<void>{
  if (process.platform === 'win32') {
    const sid=await currentWindowsSid();
                                                         
                                          
                                                                                               
    const aclScript =                                  embeddedSource("powershell", `$sid=[System.Security.Principal.SecurityIdentifier]::new($env:NXBRIDGE_ACL_SID); $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.DirectoryInfo]::new($env:NXBRIDGE_ACL_PATH).SetAccessControl($acl)`);
                                                 
                                                 
    const integrity=repair&&await isElevated();
    await execute(windowsPowerShell(), ['-NoLogo','-NoProfile','-NonInteractive','-Command',aclScript+(integrity?'\n'+windowsIntegrityScript:'')], { windowsHide:true,env:{...process.env,NXBRIDGE_ACL_PATH:directory,NXBRIDGE_ACL_SID:sid,...(integrity?{NXBRIDGE_INTEGRITY_SOURCE:windowsIntegritySource,NXBRIDGE_INTEGRITY_PATH:directory,NXBRIDGE_INTEGRITY_RECURSIVE:recursiveRepair?'yes':'no'}:{})} });
  } else chmodSync(directory, 0o700);
}

let elevated: Promise<boolean> | undefined;
export function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return elevated ??= execute(windowsTool('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true })
    .then(({ stdout }) => /S-1-16-(12288|16384)/.test(stdout));
}
