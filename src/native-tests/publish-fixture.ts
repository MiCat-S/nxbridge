import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import {PACKAGE_ROOT} from '../shared/package-location.js';
import {bridgeHome} from '../shared/local-paths.js';
import {loadConfig} from '../config/load.js';
import {readJson} from '../shared/files.js';
import {resolveCli} from '../process/host-command.js';
import { CONFIG_FIELDS, configValue } from '../config/config-schema.js';
import { writeConfiguration } from '../config/configuration.js';
import { ownsFile } from '../install/installation.js';
import { liveProcess, processIdentity } from '../process/process.js';

const execute=promisify(execFile);
export function publishEnvironment(home:string,bin:string,input:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const config=loadConfig(home);
  if(input.CODEX_HOME)config.codexHome=input.CODEX_HOME;
  if(input.CLAUDE_CONFIG_DIR)config.claudeHome=input.CLAUDE_CONFIG_DIR;
                                                        
  const catalog=path.join(homedir(),'.codex','.tmp'),isolated=path.join(input.CODEX_HOME??config.codexHome??path.join(homedir(),'.codex'),'.tmp');
  if(path.resolve(catalog)!==path.resolve(isolated))for(const name of ['plugins','plugins.sha','app-server-remote-plugin-sync-v1']){
    const source=path.join(catalog,name),target=path.join(isolated,name);
    if(existsSync(source)&&!existsSync(target)){mkdirSync(isolated,{recursive:true});cpSync(source,target,{recursive:true});}
                                                        
    if(process.platform==='win32'&&name==='plugins'&&path.resolve(catalog)!==path.resolve(isolated)&&existsSync(path.join(target,'.git')))
      execFileSync('git',['-C',target,'config','--local','core.longpaths','true'],{windowsHide:true,timeout:5000,stdio:'pipe'});
  }
  for(const host of ['codex','claude'] as const){
    const key=host==='codex'?'codexBinary':'claudeBinary',resolved=resolveCli(host,config[key]);
    config[key]=resolved.prefix[0]??resolved.command;
  }
  writeConfiguration(home,CONFIG_FIELDS.filter(field=>!field.immutable&&configValue(config,field.internal)!==undefined).map(field=>({key:field.key,value:configValue(config,field.internal)})),'setup');
                                               
  const directories=(input.PATH??'').split(path.delimiter).filter(directory=>!['nxbridge','nxbridge.cmd','nxbridge.ps1','nxbridge.cjs','nxbridge.exe'].some(name=>{const file=path.join(directory,name);return existsSync(file)&&!ownsFile(file,home);}));
  return{...input,PATH:[bin,...directories].join(path.delimiter)};
}
                                            
export async function setupPublish():Promise<any>{
  const bin=path.join(path.dirname(bridgeHome()),'fixture-bin');mkdirSync(bin,{recursive:true});
  const {stdout}=await execute(process.execPath,['--no-warnings',path.join(PACKAGE_ROOT,'publish','nxbridge.mjs'),'setup','--bin-dir',bin],{env:publishEnvironment(bridgeHome(),bin),windowsHide:true,timeout:90000,maxBuffer:8*1024*1024});
  return JSON.parse(stdout);
}
export async function uninstallPublish():Promise<any>{
  const home=bridgeHome(),{stdout}=await execute(process.execPath,['--no-warnings',path.join(home,'bin','nxbridge.cjs'),'uninstall'],{env:process.env,windowsHide:true,timeout:90000,maxBuffer:8*1024*1024}),result=JSON.parse(stdout);
  if(!result.removed){
    const run=path.join(home,'run');result.runtimeReferences=[];
    if(existsSync(run))for(const file of readdirSync(run).filter(name=>/^runtime-.*\.json$/.test(name))){const record=readJson<any>(path.join(run,file));let identity;try{identity=await processIdentity(record.pid);}catch{}result.runtimeReferences.push({record,live:liveProcess(record.pid),identity});}
  }
  return result;
}
