import path from 'node:path';
import { existsSync, realpathSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import {BridgeError} from '../shared/errors.js';
import {type Host} from '../types.js';
import { profileVersionSupported } from './host-version.js';

const nativeVersion=/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
interface DesktopLocation {root:string;version:string;layout:'windows'|'macos'}
export interface DesktopHostImages {version:string;images:string[];architecture?:string;revision:string}
export interface VerifiedHostImage {image:string;version?:string}
type ImageProbe=(image:string)=>Promise<string>;

function desktopLocation(image:string,host:Host):DesktopLocation|undefined{
  if(host!=='claude')return;
  const normalized=image.replaceAll('\\','/');
  const windows=/^(.*\/AppData\/Roaming\/Claude\/claude-code)\/([^/]+)\/claude\.exe$/i.exec(normalized);
  if(windows&&nativeVersion.test(windows[2]!))return{root:windows[1]!,version:windows[2]!,layout:'windows'};
  const macos=/^(.*\/Library\/Application Support\/Claude\/claude-code)\/([^/]+)\/([a-fA-F0-9]+)\/claude\.app\/Contents\/MacOS\/claude$/.exec(normalized);
  if(macos&&nativeVersion.test(macos[2]!))return{root:macos[1]!,version:macos[2]!,layout:'macos'};
}

function samePath(a:string,b:string):boolean{
  const normalize=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  return normalize(a)===normalize(b);
}

                                        
function nativeImage(file:string):{format:'windows'|'macos';architecture?:string}|undefined{
  let fd:number|undefined;
  try{
    fd=openSync(file,'r');
    const read=(offset:number,size:number)=>{const value=Buffer.alloc(size);return readSync(fd!,value,0,size,offset)===size?value:undefined;};
    const header=read(0,32);if(!header)return;
    const cpu=(value:number)=>value===0x01000007?'x64':value===0x0100000c?'arm64':value===7?'ia32':value===12?'arm':undefined;
    const magic=header.readUInt32BE(0);
    if([0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe].includes(magic)){
      const integer=(offset:number)=>magic===0xcefaedfe||magic===0xcffaedfe?header.readUInt32LE(offset):header.readUInt32BE(offset);
      if(integer(12)!==2)return;
      return{format:'macos',architecture:cpu(integer(4))};
    }
    if(magic===0xcafebabe||magic===0xbebafeca||magic===0xcafebabf||magic===0xbfbafeca){
      const little=magic===0xbebafeca||magic===0xbfbafeca,wide=magic===0xcafebabf||magic===0xbfbafeca;
      const count=little?header.readUInt32LE(4):header.readUInt32BE(4);if(!count||count>64)return;
      const table=read(8,count*(wide?32:20));if(!table)return;
      const architectures:string[]=[];
      for(let index=0;index<count;index++){
        const position=index*(wide?32:20),integer=(at:number)=>little?table.readUInt32LE(at):table.readUInt32BE(at);
        const architecture=cpu(integer(position));if(!architecture)return{format:'macos'};
        architectures.push(architecture);
      }
      return{format:'macos',architecture:[...new Set(architectures)].sort().join('+')};
    }
    if(header.readUInt16LE(0)!==0x5a4d)return;
    const offset=read(60,4);if(!offset)return;
    const pe=read(offset.readUInt32LE(0),24);if(!pe||pe.readUInt32LE(0)!==0x4550)return;
    const machine=pe.readUInt16LE(4);
    return{format:'windows',architecture:machine===0x8664?'x64':machine===0xaa64?'arm64':machine===0x14c?'ia32':undefined};
  }catch{return;}
  finally{if(fd!==undefined)closeSync(fd);}
}

function desktopFile(root:string,realRoot:string,relative:string,layout:DesktopLocation['layout']):{image:string;architecture?:string;stamp:unknown[]}|undefined{
  try{
    const current=path.join(root,relative),stat=statSync(current);if(!stat.isFile())return;
    if(layout==='macos'&&(stat.size===0||process.platform!=='win32'&&(stat.mode&0o111)===0))return;
                                         
    if(!samePath(realpathSync(current),path.join(realRoot,relative)))return;
    const native=nativeImage(current);if(layout==='macos'&&native?.format!=='macos')return;
    return{image:path.normalize(current),architecture:native?.architecture,stamp:[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]};
  }catch{return;}
}

                                                    
export function desktopHostImages(image:string,host:Host):DesktopHostImages|undefined{
  const location=desktopLocation(image,host);if(!location)return;
  const {root,version,layout}=location;
  try{
    const realRoot=realpathSync(root),versions=readdirSync(root).filter(value=>nativeVersion.test(value)&&profileVersionSupported(value,version)).sort((a,b)=>profileVersionSupported(a,b)&&profileVersionSupported(b,a)?a.localeCompare(b):profileVersionSupported(a,b)?-1:1);
    for(const selected of versions){
      const candidates:NonNullable<ReturnType<typeof desktopFile>>[]=[];
      try{
        const versionDirectory=path.join(root,selected);
        if(layout==='windows'){
                                                    
          if(!statSync(path.join(versionDirectory,'.verified')).isFile())continue;
          const candidate=desktopFile(root,realRoot,selected+'/claude.exe',layout);if(candidate)candidates.push(candidate);
        }else for(const hash of readdirSync(versionDirectory).filter(value=>/^[a-fA-F0-9]+$/.test(value)).sort()){
          const candidate=desktopFile(root,realRoot,selected+'/'+hash+'/claude.app/Contents/MacOS/claude',layout);if(candidate)candidates.push(candidate);
        }
      }catch{                           }
      if(candidates.length){
        const original=candidates.findIndex(value=>samePath(value.image,image));
        if(original>0)candidates.unshift(candidates.splice(original,1)[0]!);
        const architectures=new Set(candidates.map(value=>value.architecture)),architecture=architectures.size===1?candidates[0]!.architecture:undefined;
        return{version:selected,images:candidates.map(value=>value.image),revision:JSON.stringify(candidates.map(value=>[value.image,...value.stamp])),...(architecture?{architecture}:{})};
      }
    }
  }catch{                                 }
}

function desktopProbeFailure(exe:string,cause:unknown):BridgeError{
  const detail=cause instanceof Error?cause.message:String(cause);
  return Object.assign(new BridgeError('launch_probe_unavailable',`暂时没能运行 ${exe} 核验版本（${detail}），所以没有启动，稍后会自动重试。一直不行的话，运行 nxbridge doctor 查看。`),{cause});
}

                                              
export async function verifyHostImage(candidates:DesktopHostImages,probe:ImageProbe):Promise<VerifiedHostImage>{
  const ambiguous=()=>new BridgeError('launch_image_ambiguous',`Claude 桌面端 ${candidates.version} 目录下有 ${candidates.images.length} 份程序，但报出的版本或架构不一致，没法判断该用哪一份，所以没有启动。通常是桌面端更新还没收尾：等它完成（必要时完全退出再打开一次 Claude 桌面端），目录变化后会自动重试；也可以在系统终端运行 nxbridge config set hosts.claude.binary <程序完整路径>，指定要用的那一份。`);
  if(candidates.images.length>1&&!candidates.architecture)throw ambiguous();
  let version:string|undefined;
  for(const candidate of candidates.images){
    let output:string;
    try{output=await probe(candidate);}catch(error){throw desktopProbeFailure(candidate,error);}
    const official=/^(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\s+\(Claude Code\)$/.exec(output.trim());
    if(!official||official[1]!==candidates.version)throw ambiguous();
    version=official[1];
  }
  return{image:candidates.images[0]!,version};
}

                                             
export function relaunchHostImage(image:string,host:Host,platform=process.platform):string{
  if(platform!=='win32')return updatedHostEntry(image,host)??image;
  const basename=path.win32.basename(image),prefix=host+'.exe.old.';
  return basename.toLowerCase().startsWith(prefix)&&/^\d+$/.test(basename.slice(prefix.length))?path.win32.join(path.win32.dirname(image),host+'.exe'):updatedHostEntry(image,host)??image;
}

                                           
export function updatedHostEntry(image:string,host:Host):string|undefined{
  const normalized=image.replaceAll('\\','/'),brew=/^(.*)\/(Cellar|Caskroom)\/(codex|claude-code)\/([^/]+)\/(.+)$/.exec(normalized);
  let base:string,candidates:string[],allowed:(relative:string)=>boolean;
  const daemon=host==='codex'?/^(.*)\/packages\/app-server-daemon\/releases\/[^/]+\/(.+)$/.exec(normalized):undefined;
  const extension=/^(.*)\/extensions\/((?:openai\.chatgpt|anthropic\.claude-code))-[^/]+\/(.+)$/.exec(normalized);
  const desktop=desktopLocation(image,host);
  if(daemon){
    base=daemon[1]!;
    const channel='packages/app-server-daemon',suffix=daemon[2]!;
    candidates=[base+'/'+channel+'/current/'+suffix];allowed=relative=>versionedEntry(relative,channel+'/releases/',suffix);
  }else if(desktop){
    return desktopHostImages(image,host)?.images[0];
  }else if(extension&&(extension[2]==='openai.chatgpt'?host==='codex':host==='claude')){
    base=extension[1]!;
    const root=base+'/extensions',id=extension[2]!,suffix=extension[3]!;
    candidates=[];
    try{
      const entries=JSON.parse(readFileSync(root+'/extensions.json','utf8'));
      for(const entry of Array.isArray(entries)?entries:[]){
        if(entry.identifier?.id?.toLowerCase()!==id||typeof entry.relativeLocation!=='string'||!entry.relativeLocation.startsWith(id+'-')||/[\\/]/.test(entry.relativeLocation))continue;
        const candidate=root+'/'+entry.relativeLocation+'/'+suffix;if(!candidates.includes(candidate))candidates.push(candidate);
      }
    }catch{                              }
    allowed=relative=>versionedEntry(relative,'extensions/'+id+'-',suffix);
                                   
    if(candidates.filter(existsSync).length!==1)return;
  }else if(brew&&(brew[3]==='codex'?host==='codex':host==='claude')){
    base=brew[1]!;
    const kind=brew[2]!,pkg=brew[3]!,suffix=brew[5]!;
    candidates=kind==='Cellar'?[base+'/opt/'+pkg+'/'+suffix,base+'/bin/'+host]:[base+'/bin/'+host];
    allowed=relative=>versionedEntry(relative,kind+'/'+pkg+'/',suffix);
  }else{
    const native=host==='claude'?/^(.*)\/\.local\/share\/claude\/versions\/([^/]+)$/.exec(normalized):undefined;
    if(!native)return;
    base=native[1]!;
    const prefix='.local/share/claude/versions/';
    candidates=[base+'/.local/bin/claude'];allowed=relative=>relative.startsWith(prefix)&&/^\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(relative.slice(prefix.length));
  }
                                      
  if(!path.isAbsolute(normalized))return;
  let realBase:string;
  try{realBase=realpathSync.native(base+'/');}catch{return;}
  for(const candidate of candidates)try{
    const relative=path.relative(realBase,realpathSync.native(candidate)).split(path.sep).join('/');
    if(allowed(relative))return path.normalize(candidate);
  }catch{                                  }
}

function versionedEntry(relative:string,prefix:string,suffix:string):boolean{
  if(!relative.startsWith(prefix))return false;
  const rest=relative.slice(prefix.length),slash=rest.indexOf('/');
  return slash>0&&rest.slice(slash+1)===suffix;
}
