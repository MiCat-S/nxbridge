import { VERSION } from '../version.js';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { SetupServices } from '../install/setup.js';
import { RpcClient } from '../ipc/rpc.js';
import {CLI_PATH} from '../shared/package-location.js';
import {readJson} from '../shared/files.js';
import { temporary } from './support/temporary.js';

export function fixture(t:Parameters<typeof temporary>[0]){
  const directory=temporary(t),home=path.join(directory,'bridge'),codex=path.join(directory,'codex'),claude=path.join(directory,'claude'),bin=path.join(directory,'fake-bin');
  for(const dir of [codex,claude,bin])mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(claude,'settings.json'),JSON.stringify({skipDangerousModePermissionPrompt:true}),'utf8');
  const registry={claude:{installed:false,market:false,enabled:true as boolean|undefined,version:VERSION},codex:{installed:false,market:false,enabled:true as boolean|undefined,version:VERSION}},calls:{host:string;args:string[]}[]=[],edits:any[]=[];
  let fail='',marketSource=path.join(home,'marketplace'),retainCache=false,hookTrust:string|undefined='trusted';
  const cache=(host:'claude'|'codex')=>path.join(host==='claude'?claude:codex,'plugins','cache','nxbridge-local','nxbridge',registry[host].version);
  const services:Partial<SetupServices>={codexDirectory:codex,claudeDirectory:claude,binDirectories:[bin],pathValue:bin,nodeVersion:'24.14.0',entry:CLI_PATH,nativeProcesses:async()=>[],
    run:async(host,args)=>{
      calls.push({host,args});const state=registry[host];
      if(fail&&host+' '+args.slice(0,2).join(' ')===fail)throw Error('隔离故障');
      if(args[0]==='--version')return host==='codex'?'codex-cli 0.166.0':'2.1.316 (Claude Code)';
      if(args[0]==='agents')return '[]';
      if(args[1]==='marketplace'&&args[2]==='list')return JSON.stringify(state.market?[{name:'nxbridge-local',path:marketSource}]:[]);
      if(args[1]==='list')return JSON.stringify(state.installed?[{id:'nxbridge@nxbridge-local',installed:true,enabled:state.enabled,version:state.version,scope:'user',installPath:cache(host)}]:[]);
      if(args[1]==='marketplace'){state.market=args[2]==='add';return '{}';}
      if(args[1]==='install'||args[1]==='add'){state.installed=true;state.enabled=true;state.version=readJson<{version:string}>(path.join(home,'marketplace','plugins',host,host==='claude'?'.claude-plugin':'.codex-plugin','plugin.json')).version;cpSync(path.join(home,'marketplace','plugins',host),cache(host),{recursive:true});return '{}';}
      if(args[1]==='uninstall'||args[1]==='remove'){state.installed=false;if(!retainCache)rmSync(cache(host),{recursive:true,force:true});return '{}';}
      if(args[1]==='update')return '{}';
      throw Error('未处理的隔离命令 '+args.join(' '));
    },
    control:async()=>{
      const rpc=new RpcClient(message=>{
        try{
          if(message.method==='config/read'){const file=path.join(codex,'config.toml');queueMicrotask(()=>rpc.receive({id:message.id,result:{config:existsSync(file)?parse(readFileSync(file,'utf8')):{},layers:[{name:{type:'user',file}}]}}));return;}
          if(message.method==='configRequirements/read'){queueMicrotask(()=>rpc.receive({id:message.id,result:{requirements:null}}));return;}
          if(message.method==='hooks/list'){if(hookTrust===undefined)throw Error('隔离宿主无法读取 hook 元数据');queueMicrotask(()=>rpc.receive({id:message.id,result:{data:[{hooks:[{pluginId:'nxbridge@nxbridge-local',trustStatus:hookTrust}]}]}}));return;}
          assert.equal(message.method,'config/batchWrite');edits.push(...message.params.edits);
          const file=message.params.filePath,current:any=existsSync(file)?parse(readFileSync(file,'utf8')):{};
          for(const edit of message.params.edits){const keys=edit.keyPath.split('.'),last=keys.pop()!;let parent=current;for(const key of keys)parent=parent[key]??={};if(edit.value===null)delete parent[last];else parent[last]=edit.value;}
          writeFileSync(file,stringify(current),'utf8');queueMicrotask(()=>rpc.receive({id:message.id,result:{}}));
        }catch(error){queueMicrotask(()=>rpc.receive({id:message.id,error:{code:'test',message:String(error)}}));}
      },()=>{});return rpc;
    },
    broker:async()=>{throw Object.assign(Error('隔离 broker 不存在'),{code:'ENOENT'});},
    backgroundPreflight:async()=>{},
  };
  return{directory,home,codex,claude,bin,cache,registry,calls,edits,services,fail:(value:string)=>fail=value,marketSource:(value:string)=>marketSource=value,retainCache:()=>retainCache=true,trust:(value:string|undefined)=>hookTrust=value};
}


export const autonomousNext=process.platform==='linux'&&process.getuid?.()===0?['Claude 原生禁止 root/sudo 使用无人审批模式。请以普通 Linux 用户运行 nxbridge；原草稿已保留。']:[];
