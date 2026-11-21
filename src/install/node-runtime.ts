import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { persistentEnvironment, temporaryPath } from '../process/environment.js';
import {BridgeError} from '../shared/errors.js';

export const supportedNode=(version:string)=>/^v?(?:24|25|26)\./.test(version);
export function resolveNodeRuntime(pinned:string,env=persistentEnvironment()):string{
  if(existsSync(pinned))return pinned;
  for(const directory of (env.PATH??'').split(path.delimiter).filter(value=>value&&!temporaryPath(value,env))){
    const file=path.join(directory,process.platform==='win32'?'node.exe':'node');
    if(!existsSync(file))continue;
    try{if(supportedNode(execFileSync(file,['--version'],{encoding:'utf8',windowsHide:true,timeout:3000,env})))return file;}catch{}
  }
  throw new BridgeError('node_missing','记录的 Node.js 已不存在，系统 PATH 中也没有 Node.js 24～26；请安装兼容版本，再用新 Node 运行私有目录 bin/nxbridge.cjs update 修复。');
}

                                              
export function windowsNodeDiscovery():string{
  return [
    "$ErrorActionPreference='Stop'; $nxVars=@{}; $nxPaths=@();",
    "foreach($nxScope in @(@([Microsoft.Win32.Registry]::LocalMachine,'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),@([Microsoft.Win32.Registry]::CurrentUser,'Volatile Environment'),@([Microsoft.Win32.Registry]::CurrentUser,'Environment'))){$nxKey=$nxScope[0].OpenSubKey($nxScope[1]);if($nxKey){try{foreach($nxName in $nxKey.GetValueNames()){$nxValue=$nxKey.GetValue($nxName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($nxValue -is [string]){if($nxName -ieq 'Path'){$nxPaths+=,$nxValue}else{$nxVars[$nxName]=$nxValue}}}}finally{$nxKey.Dispose()}}};",
    "foreach($nxName in @('USERPROFILE','SystemRoot','APPDATA','LOCALAPPDATA')){if(!$nxVars.ContainsKey($nxName)){$nxVars[$nxName]=[Environment]::GetEnvironmentVariable($nxName)}};",
    "function Expand-NxPath([string]$nxText){for($nxI=0;$nxI -lt 10;$nxI++){$nxNext=[regex]::Replace($nxText,'%([^%]+)%',{param($nxMatch) $nxName=$nxMatch.Groups[1].Value;if($nxVars.ContainsKey($nxName)){[string]$nxVars[$nxName]}else{$nxMatch.Value}});if($nxNext -eq $nxText){break};$nxText=$nxNext};return $nxText};",
    "$nxSearch='';foreach($nxPart in $nxPaths){$nxPart=Expand-NxPath ($nxPart -replace '(?i)%PATH%',$nxSearch);$nxSearch=(@($nxSearch,$nxPart)|Where-Object{$_}) -join ';'};",
    "foreach($nxDir in $nxSearch.Split(';')){if(!$nxDir){continue};$nxFile=Join-Path $nxDir.Trim('\"') 'node.exe';if(Test-Path -LiteralPath $nxFile -PathType Leaf){try{$nxVersion=& $nxFile --version;if($LASTEXITCODE -eq 0 -and $nxVersion -match '^v(24|25|26)\\.'){[Console]::WriteLine($nxFile);exit 0}}catch{}}};throw '系统保存的 PATH 中没有 Node.js 24～26；请安装兼容版本，再运行私有目录 bin/nxbridge.cjs update。';",
  ].join(' ');
}
export function encodedNodeDiscovery():string{return Buffer.from(windowsNodeDiscovery(),'utf16le').toString('base64');}
