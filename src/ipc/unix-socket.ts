import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,readlinkSync,realpathSync,type Stats} from 'node:fs';
import path from 'node:path/posix';
import {parseLsofFields,readMacProcessOutput} from '../hosts/macos-tui.js';
import {processIdentity,type ProcessIdentity} from '../process/process.js';
import {BridgeError,describeError} from '../shared/errors.js';

type SocketStat=Pick<Stats,'dev'|'ino'|'uid'|'mode'|'isSocket'|'isDirectory'|'isSymbolicLink'>;
export interface UnixSocketIo {
  realpath:(file:string)=>string;lstat:(file:string)=>SocketStat;readlink:(file:string)=>string;uid:number;
  identity:(pid:number)=>Promise<ProcessIdentity>;listener:(file:string,pid:number)=>Promise<boolean>;
}
const uid=()=>process.geteuid?.()??process.getuid?.()??-1;
const filesystem=()=>({realpath:realpathSync.native,lstat:lstatSync,readlink:readlinkSync,uid:uid()});
const stamp=(stat:SocketStat)=>[stat.dev,stat.ino].join(':');

                                                                    
export function codexSocketTarget(filename:string,io:Pick<UnixSocketIo,'realpath'|'uid'>=filesystem()):string{
  const advertised=path.join(io.realpath(path.dirname(filename)),path.basename(filename));
  return path.join(io.realpath('/tmp'),'codex-daemon-'+io.uid,createHash('sha256').update(advertised).digest('hex'));
}

                                          
export function codexSocketAlias(filename:string,io:Pick<UnixSocketIo,'realpath'|'readlink'|'uid'>=filesystem()):string{
  const expected=codexSocketTarget(filename,io),target=path.resolve(path.dirname(filename),io.readlink(filename));
  if(target!==expected)throw new BridgeError('shared_backend','App Server socket 链接不符合原生入口派生规则，未授权停止或清理：'+JSON.stringify({requested:filename,resolved:target,expected}));
  return expected;
}

                                                           
export function linuxSocketListener(table:string,fds:string[],filename:string,canonical:(file:string)=>string=realpathSync.native):boolean{
  const held=new Set(fds.flatMap(value=>/^socket:\[(\d+)\]$/.exec(value)?.slice(1)??[]));
  return table.split('\n').some(line=>{
    const row=/^\s*\S+\s+\S+\s+\S+\s+([a-f0-9]+)\s+([a-f0-9]+)\s+\S+\s+(\d+)\s+(.+?)\s*$/i.exec(line);
    if(!row||!(parseInt(row[1]!,16)&0x10000)||parseInt(row[2]!,16)!==1||!held.has(row[3]!))return false;
    try{return canonical(row[4]!)===filename;}catch{return false;}
  });
}
export async function unixSocketListener(filename:string,pid:number):Promise<boolean>{
  if(process.platform==='linux'){
    const directory='/proc/'+pid+'/fd',fds=readdirSync(directory).flatMap(name=>{try{return[readlinkSync(path.join(directory,name))];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}});
    return linuxSocketListener(readFileSync('/proc/net/unix','utf8'),fds,filename);
  }
  if(process.platform==='darwin'){
    const files=parseLsofFields(await readMacProcessOutput('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-U','-F','pftn']));
    return files.some(file=>file.pid===pid&&file.type==='unix'&&(file.name===filename||file.name===filename+' type=STREAM'||file.name?.startsWith(filename+'->')));
  }
  return false;
}

export interface UnixSocketProof {requested:string;resolved:string;kind:'direct'|'codex-alias';pid:number;generation:string}
                                                 
export async function proveUnixCodexSocket(filename:string,native:ProcessIdentity,io:UnixSocketIo={...filesystem(),identity:processIdentity,listener:unixSocketListener}):Promise<UnixSocketProof>{
  const details:Record<string,unknown>={requested:filename,expectedPid:native.pid,expectedGeneration:native.startedAt};
  try{
    const before=await io.identity(native.pid);details.observedGeneration=before.startedAt;
    if(before.startedAt!==native.startedAt||before.image!==native.image)throw new Error('进程代次或映像已改变');
    const entry=io.lstat(filename),alias=entry.isSymbolicLink();
    details.resolved=alias?path.resolve(path.dirname(filename),io.readlink(filename)):io.realpath(filename);details.kind=alias?'codex-alias':'direct';
    if(alias)details.expectedTarget=codexSocketTarget(filename,io);
    const resolved=alias?codexSocketAlias(filename,io):io.realpath(filename);
    const socket=alias?io.lstat(resolved):entry;
                                        
    if(!socket.isSocket()||socket.isSymbolicLink())throw new Error('目标不是实际 socket');
    const entryStamp=stamp(entry),socketStamp=stamp(socket);
    details.listenerVerified=await io.listener(resolved,native.pid);
    if(!details.listenerVerified)throw new Error('记录的进程没有持有该监听 socket');
    const after=await io.identity(native.pid);details.observedGeneration=after.startedAt;
    if(after.startedAt!==native.startedAt||after.image!==native.image)throw new Error('监听核验期间进程代次或映像改变');
    if(stamp(io.lstat(filename))!==entryStamp||stamp(io.lstat(resolved))!==socketStamp||io.realpath(filename)!==resolved)throw new Error('监听核验期间端点或链接改变');
    return{requested:filename,resolved,kind:alias?'codex-alias':'direct',pid:native.pid,generation:native.startedAt};
  }catch(error){
    throw Object.assign(new BridgeError('shared_backend','无法核验专用 App Server socket：'+describeError(error)+'；核验信息：'+JSON.stringify(details)),{socketProof:details});
  }
}
