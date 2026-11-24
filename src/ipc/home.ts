import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,unlinkSync,lstatSync,readdirSync} from 'node:fs';
import {userInfo} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {BridgeError} from '../shared/errors.js';
import {privateDirectory} from '../process/permissions.js';
import {sameDirectory} from '../shared/files.js';
import {windowsPowerShell} from '../shared/windows-tools.js';
import {bridgeHome,ownedSocketDirectory} from '../shared/local-paths.js';
import {atomicWriteText} from '../storage/atomic-file.js';
import {codexSocketAlias} from './unix-socket.js';
import {ipcTokenFile} from './token.js';
const execute=promisify(execFile);
export async function ensureHome(home = bridgeHome(),repair=false): Promise<void> {
  await privateDirectory(home,repair,repair);
  await privateDirectory(path.join(home, 'run'),repair);
  if((process.platform!=='win32'||repair)&&ownedSocketDirectory(home)!==path.join(home,'run'))await socketDirectory(home,repair);
  const tokenPath=ipcTokenFile(home);
  if(existsSync(tokenPath))return;
  try { atomicWriteText(tokenPath,randomBytes(32).toString('hex'),{exclusive:true}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export async function socketDirectory(home = bridgeHome(),repair=false): Promise<string> {
  const directory=ownedSocketDirectory(home);
  if(process.platform!=='win32'&&existsSync(directory)){
    const stat=lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==userInfo().uid)throw new BridgeError('socket_directory_conflict','Unix socket 目录不属于当前用户或不是实际目录，未修改。');
  }
  await privateDirectory(directory,repair,repair);return directory;
}

export function ownedSocketFile(home:string,endpoint:string):string|undefined{
  if(!endpoint.startsWith('unix://'))return;
  const filename=path.resolve(endpoint.slice(7)),directory=path.dirname(filename);
  if(!sameDirectory(directory,ownedSocketDirectory(home))||path.extname(filename)!=='.sock')return;
  return filename;
}

export async function removeOwnedSocket(home:string,endpoint:string):Promise<void>{
  const filename=ownedSocketFile(home,endpoint);if(!filename)return;
  if(process.platform!=='win32')try{
    const entry=lstatSync(filename);
    if(entry.isSymbolicLink()){
      if(entry.uid!==(process.geteuid?.()??process.getuid?.()))throw new BridgeError('socket_owner_changed','socket 入口已不属于当前用户，保留文件。');
      codexSocketAlias(filename);
    }else if(!entry.isSocket())throw new BridgeError('socket_type_changed','socket 入口已被其他文件替换，保留文件。');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
                                                                       
                                              
  try{unlinkSync(filename);}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT')return;
    if(process.platform!=='win32'||!['EACCES','EPERM'].includes(code??''))throw error;
    await execute(windowsPowerShell(),['-NoLogo','-NoProfile','-NonInteractive','-Command','Remove-Item -LiteralPath $env:NXBRIDGE_SOCKET_FILE -Force -ErrorAction Stop'],{windowsHide:true,timeout:10000,env:{...process.env,NXBRIDGE_SOCKET_FILE:filename},encoding:'utf8'});
  }
}

                                                       
export function removeDanglingCodexSockets(home:string):string[]{
  if(process.platform==='win32')return[];
  const directory=ownedSocketDirectory(home),removed:string[]=[];let names:string[];
  try{names=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  for(const name of names.filter(value=>/^cx-[a-f0-9]{16}\.sock$/.test(value))){
    const filename=path.join(directory,name);let entry;
    try{
      entry=lstatSync(filename);if(!entry.isSymbolicLink()||entry.uid!==(process.geteuid?.()??process.getuid?.()))continue;
      const target=codexSocketAlias(filename);
      try{lstatSync(target);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const current=lstatSync(filename);if(current.dev!==entry.dev||current.ino!==entry.ino||!current.isSymbolicLink())continue;
      unlinkSync(filename);removed.push(filename);
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof BridgeError&&error.code==='shared_backend')continue;throw error;}
  }
  return removed;
}
