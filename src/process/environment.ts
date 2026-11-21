import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { Host } from '../types.js';

export interface EnvironmentReport {source:string;dropped:string[];replaced:string[];inheritedLoopbackProxy:string[]}
export interface EnvironmentResult {env:NodeJS.ProcessEnv;report:EnvironmentReport}
export interface WindowsEnvironment {machine:Record<string,string>;user:Record<string,string>;volatile?:Record<string,string>}
const essential=['SYSTEMROOT','WINDIR','COMSPEC','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','TEMP','TMP','USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','LOGONSERVER','SESSIONNAME','PROGRAMDATA','ALLUSERSPROFILE','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','OS'];
const upper=(env:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==='string').map(([key,value])=>[key.toUpperCase(),value]));
let cachedWindows:NodeJS.ProcessEnv|undefined;
const sessionVariable=/^(?:CLAUDECODE(?:_|$)|CLAUDE_CODE_(?:SESSION|PARENT_SESSION|AGENT_ID|MESSAGING|PLUGIN_ROOT|HOOK|IPC|SSE|TASK_ID)|CODEX_(?:THREAD|SESSION|PARENT|PLUGIN_ROOT|HOOK|SANDBOX|INTERNAL_|MANAGED_BY_|MANAGED_PACKAGE_ROOT$|ORIGINATOR)|NXBRIDGE_(?!HOME$))/i;

                                            
export function environmentPath(env:NodeJS.ProcessEnv):string{
  return env.PATH??(process.platform==='win32'?Object.entries(env).find(([key])=>key.toUpperCase()==='PATH')?.[1]:undefined)??'';
}

                                                
export function foregroundEnvironment(input:NodeJS.ProcessEnv):EnvironmentResult{
  const env:NodeJS.ProcessEnv={},dropped:string[]=[];
  for(const [key,value]of Object.entries(input)){if(value===undefined)continue;if(sessionVariable.test(key))dropped.push(key);else env[process.platform==='win32'&&key.toUpperCase()==='PATH'?'PATH':key]=value;}
  return{env,report:{source:'foreground-terminal',dropped,replaced:[],inheritedLoopbackProxy:[]}};
}

export function mergeWindowsEnvironment(raw:WindowsEnvironment,current:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const machine=upper(raw.machine),user=upper(raw.user),dynamic=upper(raw.volatile??{}),input=upper(current);
  const values:Record<string,string>={...machine,...dynamic,...user};
  for(const key of essential)if(values[key]===undefined&&input[key]!==undefined)values[key]=input[key]!;
  const expand=(value:string,seen:Set<string>=new Set()):string=>value.replace(/%([^%]+)%/g,(original,key:string)=>{key=key.toUpperCase();if(seen.has(key)||values[key]===undefined)return original;return expand(values[key]!,new Set([...seen,key]));});
  const systemPath=expand(machine.PATH??'',new Set(['PATH']));
  values.PATH=[systemPath,expand((user.PATH??'').replace(/%PATH%/gi,systemPath),new Set(['PATH']))].filter(Boolean).join(';');
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,expand(value,new Set([key]))]));
}

export function persistentEnvironment(refresh=false):NodeJS.ProcessEnv{
  if(process.platform!=='win32')return cleanInstanceEnvironment(process.env).env;
  if(cachedWindows&&!refresh)return{...cachedWindows};
  const executable=path.win32.join(process.env.SystemRoot??process.env.SYSTEMROOT??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
                                             
  const script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); function Read-Env($root,$sub){$r=@{};$k=$root.OpenSubKey($sub);if($k){try{foreach($n in $k.GetValueNames()){$v=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($v -is [string]){$r[$n]=$v}}}finally{$k.Dispose()}};return $r}; @{machine=(Read-Env ([Microsoft.Win32.Registry]::LocalMachine) 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');user=(Read-Env ([Microsoft.Win32.Registry]::CurrentUser) 'Environment');volatile=(Read-Env ([Microsoft.Win32.Registry]::CurrentUser) 'Volatile Environment')} | ConvertTo-Json -Compress";
  const raw=JSON.parse(execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024}));
  cachedWindows=mergeWindowsEnvironment(raw,process.env);return{...cachedWindows};
}

export function temporaryPath(directory:string,env:NodeJS.ProcessEnv=process.env):boolean{
  const root=env.USERPROFILE??env.HOME??homedir();
  const roots=[env.TEMP,env.TMP,env.TMPDIR,tmpdir(),path.join(root,'.codex','tmp'),path.join(root,'.claude','tmp')].filter((value):value is string=>!!value);
  return roots.some(value=>{const relative=path.relative(path.resolve(value),path.resolve(directory));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);});
}

export function cleanInstanceEnvironment(input:NodeJS.ProcessEnv):EnvironmentResult{
  const env:NodeJS.ProcessEnv={},dropped:string[]=[],replaced:string[]=[];
  for(const [key,value]of Object.entries(input)){
    if(value===undefined)continue;
    if(sessionVariable.test(key)||/^(?:NODE_OPTIONS$|npm_)/i.test(key)){dropped.push(key);continue;}
    if(key.toUpperCase()==='PATH'){
      env[key]=value.split(path.delimiter).filter(directory=>directory&&!temporaryPath(directory,input)).join(path.delimiter);
      if(env[key]!==value)replaced.push(key);
    }else env[key]=value;
  }
  return{env,report:{source:'verified-user-profile',dropped,replaced,inheritedLoopbackProxy:[]}};
}

export function loopbackProxyNames(env:NodeJS.ProcessEnv):string[]{
  return Object.keys(env).filter(key=>/^(?:https?|all)_proxy$/i.test(key)&&/^https?:\/\/(?:localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i.test(env[key]??''));
}

export function neutralEnvironment(overrides:NodeJS.ProcessEnv={},refresh=false):EnvironmentResult{
  const input=process.env,ownership=Object.fromEntries(['NXBRIDGE_PROCESS_REGISTRY','NXBRIDGE_TEST_SCOPE'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]])),env=Object.fromEntries(Object.entries({...persistentEnvironment(refresh),...ownership,...overrides}).filter(([,value])=>value!==undefined));
                                              
  if(input.NXBRIDGE_TEST_SCOPE&&input.DISABLE_AUTOUPDATER==='1')env.DISABLE_AUTOUPDATER='1';
  const before=process.platform==='win32'?upper(input):input,after=process.platform==='win32'?upper(env):env;
  return{env,report:{source:process.platform==='win32'?'windows-persistent':'unix-inherited-filtered',dropped:Object.keys(before).filter(key=>after[key]===undefined),replaced:Object.keys(before).filter(key=>after[key]!==undefined&&after[key]!==before[key]),inheritedLoopbackProxy:loopbackProxyNames(input).filter(key=>{const name=process.platform==='win32'?key.toUpperCase():key;return after[name]!==before[name];})}};
}

export function configHomeFor(host:Host,env:NodeJS.ProcessEnv):string{return path.resolve((host==='codex'?env.CODEX_HOME:env.CLAUDE_CONFIG_DIR)??path.join(env.USERPROFILE??env.HOME??homedir(),host==='codex'?'.codex':'.claude'));}

export function referencedAuthEnvironment(host:Host,home:string,current=process.env):NodeJS.ProcessEnv{
  const names=new Set(host==='codex'?['OPENAI_API_KEY','OPENAI_ORG_ID','OPENAI_PROJECT_ID']:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','GOOGLE_APPLICATION_CREDENTIALS']);
  const walk=(value:unknown,key='')=>{
    if(typeof value==='string'){
      if(['env_key','bearer_token_env_var'].includes(key))names.add(value);
      for(const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|%([A-Za-z_][A-Za-z0-9_]*)%/g))names.add((match[1]??match[2])!);
    }else if(Array.isArray(value)){for(const item of value){if(key==='env_vars'&&typeof item==='string')names.add(item);else walk(item,key);}}
    else if(value&&typeof value==='object')for(const [field,item]of Object.entries(value)){if(key==='env_http_headers'&&typeof item==='string')names.add(item);else walk(item,field);}
  };
  for(const file of host==='codex'?['config.toml']:['settings.json','settings.local.json']){
    const filename=path.join(home,file);if(!existsSync(filename))continue;
    try{walk(file.endsWith('.toml')?parse(readFileSync(filename,'utf8')):JSON.parse(readFileSync(filename,'utf8')));}catch{                     }
  }
  return Object.fromEntries([...names].filter(name=>current[name]!==undefined).map(name=>[name,current[name]]));
}
