import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {atomicJson,readJson} from '../shared/files.js';
import {bridgeHome} from '../shared/local-paths.js';
import {CLI_PATH} from '../shared/package-location.js';
import {BridgeError} from '../shared/errors.js';
import { installShim, ownsFile, planShim } from '../install/installation.js';
import { encodedNodeDiscovery } from '../install/node-runtime.js';

export type WrapperShell = 'powershell' | 'bash' | 'zsh';
interface WrapperRecord {file:string;shell:WrapperShell;block:string;prefix:string;created:boolean}
interface WrapperState {version:1;profiles:WrapperRecord[]}
interface Profile {text:string;encoding:'utf8'|'utf16le';bom:Buffer;exists:boolean}
const BEGIN='# nxbridge begin',END='# nxbridge end';
const psQuote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const shQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const key=(filename:string)=>process.platform==='win32'?path.resolve(filename).toLowerCase():path.resolve(filename);
const stateFile=(home:string)=>path.join(home,'shell-wrappers.json');
const readState=(home:string):WrapperState=>existsSync(stateFile(home))?readJson<WrapperState>(stateFile(home)):{version:1,profiles:[]};
function stableEntry(home:string):string{
  const entry=path.join(home,'bin','nxbridge.cjs'),pointer=path.join(home,'bin','runtime.json');
  if(!existsSync(entry)||!existsSync(pointer)){
    const previous=existsSync(pointer)&&ownsFile(pointer,home)?readJson<Record<string,any>>(pointer):undefined;
    installShim(planShim(home,{directories:[],pathValue:'',entry:previous?.entry??CLI_PATH,node:previous?.node,runtime:previous}));
  }else if(!ownsFile(entry,home)||!ownsFile(pointer,home))throw new BridgeError('launcher_conflict','稳定入口存在非 nxbridge 文件，未修改 shell 包装。');
  return entry;
}

function saveState(home:string,state:WrapperState):void{
  if(state.profiles.length){mkdirSync(home,{recursive:true});atomicJson(stateFile(home),state);}
  else if(existsSync(stateFile(home)))unlinkSync(stateFile(home));
}

function readProfile(filename:string,shell:WrapperShell):Profile{
  if(!existsSync(filename))return{text:'',encoding:'utf8',bom:shell==='powershell'?Buffer.from([0xef,0xbb,0xbf]):Buffer.alloc(0),exists:false};
  const bytes=readFileSync(filename);
  if(bytes[0]===0xff&&bytes[1]===0xfe)return{text:bytes.subarray(2).toString('utf16le'),encoding:'utf16le',bom:bytes.subarray(0,2),exists:true};
  const bom=bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]))?bytes.subarray(0,3):Buffer.alloc(0);
  try{return{text:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(bom.length)),encoding:'utf8',bom,exists:true};}
  catch{throw new BridgeError('profile_encoding','shell profile 需要 UTF-8 或带 BOM 的 UTF-16LE 编码；原文件未修改。');}
}

function writeProfile(filename:string,profile:Profile,text:string):void{
  mkdirSync(path.dirname(filename),{recursive:true});
  writeFileSync(filename,Buffer.concat([profile.bom,Buffer.from(text,profile.encoding)]));
}

function managedBlock(text:string):{start:number;end:number}|undefined{
  const starts=[...text.matchAll(/^# nxbridge begin\r?$/gm)],ends=[...text.matchAll(/^# nxbridge end\r?$/gm)];
  if(!starts.length&&!ends.length)return undefined;
  if(starts.length!==1||ends.length!==1||starts[0]!.index>=ends[0]!.index)throw new BridgeError('wrapper_markers','shell profile 的 nxbridge 标记不完整或重复；原文件未修改。');
  const start=starts[0]!.index,lineEnd=ends[0]!.index+ends[0]![0].length;
  return{start,end:lineEnd+(text[lineEnd]==='\n'?1:0)};
}

export function wrapperBlock(shell:WrapperShell,node=process.execPath,entry=CLI_PATH,eol='\n'):string{
                                                        
  const command=shell==='powershell'?[
    'function global:codex {',
    `    $nxbridgeNode = ${psQuote(node)}`,
    `    if (-not (Test-Path -LiteralPath $nxbridgeNode -PathType Leaf)) { $nxbridgeNode = & "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedNodeDiscovery()}; if ($LASTEXITCODE -ne 0 -or -not $nxbridgeNode) { throw '找不到 Node.js 24～26；请安装兼容版本后运行 nxbridge 私有目录中的 bin/nxbridge.cjs update。' } }`,
    '    $nxbridgeArguments = @($args | ForEach-Object { [string]$_ })',
    '    $nxbridgeJson = ConvertTo-Json -InputObject $nxbridgeArguments -Compress',
    '    $nxbridgeEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nxbridgeJson))',
    '    if ($MyInvocation.ExpectingInput) {',
    '        $OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `        $input | & $nxbridgeNode ${psQuote(entry)} shell-codex $nxbridgeEncoded`,
    '    } else {',
    `        & $nxbridgeNode ${psQuote(entry)} shell-codex $nxbridgeEncoded`,
    '    }',
    '}',
  ].join(eol):`codex() { local nxbridge_node=${shQuote(node)}; [ -x "$nxbridge_node" ] || nxbridge_node=node; "$nxbridge_node" ${shQuote(entry)} codex "$@"; }`;
  return[BEGIN,command,END,''].join(eol);
}

export function installWrapper(options:{file:string;shell:WrapperShell;home?:string}):{installed:true;changed:boolean;file:string;shell:WrapperShell}{
  if(!['powershell','bash','zsh'].includes(options.shell))throw new BridgeError('wrapper_shell','仅支持 powershell、bash、zsh。');
  const home=options.home??bridgeHome(),file=path.resolve(options.file),state=readState(home),profile=readProfile(file,options.shell);
  const previous=state.profiles.find(record=>key(record.file)===key(file)),span=managedBlock(profile.text);
  const eol=profile.text.includes('\r\n')?'\r\n':profile.text.includes('\n')?'\n':options.shell==='powershell'?'\r\n':'\n';
  const block=wrapperBlock(options.shell,process.execPath,stableEntry(home),eol);
  const prefix=span?previous?.prefix??'':profile.text&&!profile.text.endsWith('\n')?eol:'';
  const text=span?profile.text.slice(0,span.start)+block+profile.text.slice(span.end):profile.text+prefix+block;
  const changed=text!==profile.text;
  if(changed)writeProfile(file,profile,text);
  const record:WrapperRecord={file,shell:options.shell,block,prefix,created:previous?.created??!profile.exists};
  state.profiles=state.profiles.filter(item=>key(item.file)!==key(file));state.profiles.push(record);saveState(home,state);
  return{installed:true,changed,file,shell:options.shell};
}

function removeProfile(record:WrapperRecord):{removed:boolean;notice?:string}{
  const profile=readProfile(record.file,record.shell),span=managedBlock(profile.text);
  if(!span)return{removed:false};
  if(profile.text.slice(span.start,span.end)!==record.block)return{removed:false,notice:`${record.file} 的 nxbridge 包装已被修改，保留当前内容。`};
  const start=record.prefix&&profile.text.slice(span.start-record.prefix.length,span.start)===record.prefix?span.start-record.prefix.length:span.start;
  const text=profile.text.slice(0,start)+profile.text.slice(span.end);
  if(!text&&record.created)unlinkSync(record.file);else writeProfile(record.file,profile,text);
  return{removed:true};
}

export function removeWrapper(options:{file:string;home?:string}):{removed:boolean;file:string;notice?:string}{
  const home=options.home??bridgeHome(),file=path.resolve(options.file),state=readState(home);
  const record=state.profiles.find(item=>key(item.file)===key(file));
  if(!record)return{removed:false,file,notice:'此文件没有 nxbridge 包装安装记录。'};
  const result=removeProfile(record);
  if(!result.notice){state.profiles=state.profiles.filter(item=>key(item.file)!==key(file));saveState(home,state);}
  return{...result,file};
}

export function removeInstalledWrappers(home=bridgeHome()):{removed:string[];notes:string[]}{
  const state=readState(home),removed:string[]=[],notes:string[]=[],keep:WrapperRecord[]=[];
  for(const record of state.profiles){
    try{
      const result=removeProfile(record);
      if(result.notice){keep.push(record);notes.push(result.notice);}
      else if(result.removed)removed.push(record.file);
    }catch(error){keep.push(record);notes.push(`保留 ${record.file}：${String(error)}`);}
  }
  state.profiles=keep;saveState(home,state);
  return{removed,notes};
}

export function updateInstalledWrappers(home=bridgeHome()):{updated:string[];notes:string[]}{
  const updated:string[]=[],notes:string[]=[];
  for(const record of readState(home).profiles){
    try{
      const profile=readProfile(record.file,record.shell),span=managedBlock(profile.text);
      if(!span||profile.text.slice(span.start,span.end)!==record.block){notes.push(`${record.file} 的 nxbridge 包装已被修改或移除，保留当前内容。`);continue;}
      if(installWrapper({home,file:record.file,shell:record.shell}).changed)updated.push(record.file);
    }catch(error){notes.push(`保留 ${record.file}：${String(error)}`);}
  }
  return{updated,notes};
}
