import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bridgeHome } from '../shared/local-paths.js';
import { CLI_PATH } from '../shared/package-location.js';
import { readJson, sameDirectory } from '../shared/files.js';
import { BridgeError } from '../shared/errors.js';
import { publishSource, verifyPublish } from './runtime-install.js';
import type { setup } from './setup.js';

const HANDOFF='NXBRIDGE_SETUP_ENTRY';

// Run the selected build before preflight or mutations, including dry-run.
export async function handoffSetup(command:string,args:string[],options:NonNullable<Parameters<typeof setup>[0]>):Promise<boolean>{
  const delegated=process.env[HANDOFF];
  delete process.env[HANDOFF];
  if(delegated){
    if(!sameDirectory(delegated,CLI_PATH))throw new BridgeError('setup_handoff','安装入口与选定版本不一致，未继续安装。');
    return false;
  }
  if(options.prepareOnly)return false;
  const home=options.home??bridgeHome(),stateFile=path.join(home,'setup-state.json');
  const pending=existsSync(stateFile)?readJson<{pendingSetup?:{runtimeDirectory:string}}>(stateFile).pendingSetup:undefined;
  const directory=pending?.runtimeDirectory??publishSource(home,options.from).directory;
  const entry=path.join(directory,'nxbridge.mjs');
  if(sameDirectory(entry,CLI_PATH))return false;
  verifyPublish(directory);
  const child=spawn(process.execPath,[entry,command,...args],{stdio:'inherit',env:{...process.env,[HANDOFF]:entry},windowsHide:true});
  await new Promise<void>((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal)process.kill(process.pid,signal);else process.exitCode=code!;
      resolve();
    });
  });
  return true;
}
