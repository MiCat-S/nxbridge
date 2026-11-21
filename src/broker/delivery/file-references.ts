import type { Message, Peer } from '../../types.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export interface FileReference { path:string; start?:number; end?:number }
export type DeliveryMessage = Message & { hint?:string;notice?:boolean;noticeSource?:string;beforeSubmit?:(deadline?:number)=>Promise<boolean>;senderSnapshot?:()=>Peer };

                                  
export function parseFileReferences(body:string,cwd=process.cwd()):FileReference[]{
  const found=new Map<string,FileReference>();
  const add=(raw:string)=>{
    let filename=raw.trim().replace(/[.,;!?，；。！？]+$/u,'');
    if(!filename||/^[a-z][a-z\d+.-]*:\/\//i.test(filename)||/^(?:www\.|mailto:)/i.test(filename)||/^[^/\\\s]+@[^/\\\s]+\.[^/\\\s]+$/.test(filename))return;
    let start:number|undefined,end:number|undefined;
    const range=/(?::([1-9]\d*)(?:-([1-9]\d*))?|#L([1-9]\d*)(?:-L?([1-9]\d*))?)$/i.exec(filename);
    if(range){
      start=Number(range[1]??range[3]);end=range[2]||range[4]?Number(range[2]??range[4]):undefined;
      if(!Number.isSafeInteger(start)||(end!==undefined&&(!Number.isSafeInteger(end)||end<start)))return;
      filename=filename.slice(0,range.index);
    }
    if(/^(?:v?\d+\.)+\d+$/i.test(filename)||/[#?*|=<>\r\n]/.test(filename)||/:(?![\\/])/.test(filename))return;
                                        
    if(filename.includes(':')&&!/^[a-z]:[\\/][^:]+$/i.test(filename))return;
    const normalized=filename.replaceAll('\\','/').replace(/^(?:\.\/)+/,'');
    if(!normalized||/^(?:\.{1,2}|\/|~\/?)$/.test(normalized))return;
    const leaf=normalized.replace(/\/$/,'').split('/').at(-1)!;
    if(!/^[\p{L}\p{N}_.@~ /+\-:]+$/u.test(normalized)||!/[\p{L}\p{N}_]/u.test(leaf))return;
    if(!normalized.includes('/')&&!/\.[\p{L}\d]+$/u.test(leaf)&&start===undefined)return;
    const target=/^~[\\/]/.test(filename)?path.join(homedir(),filename.slice(2)):path.isAbsolute(filename)||path.win32.isAbsolute(filename)?filename:path.resolve(cwd,filename);
    if(!existsSync(target))return;
    const ref={path:filename,...(start===undefined?{}:{start}),...(end===undefined?{}:{end})};
    const pathKey=path.resolve(target).replaceAll('\\','/').replace(/\/$/,'');
    const key=JSON.stringify([process.platform==='win32'?pathKey.toLowerCase():pathKey,start,end??start]);
    if(!found.has(key))found.set(key,ref);
  };
  let fence:{char:string;length:number}|undefined;
  const prose=body.split(/\r?\n/).map(line=>{
    const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence){if(marker&&marker[1]![0]===fence.char&&marker[1]!.length>=fence.length&&!marker[2]!.trim())fence=undefined;return '';}
    if(marker){fence={char:marker[1]![0]!,length:marker[1]!.length};return '';}
    return line;
  }).join('\n');
  let rest=prose.replace(/\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s()]+))(?:\s+["'][^\r\n]*?["'])?\s*\)/g,(_all,angle:string|undefined,target:string|undefined)=>{add(angle??target!);return ' ';});
  rest=rest.replace(/(`+)([^`\r\n]+)\1/g,(_all,_ticks:string,code:string)=>{add(code);return ' ';});
  rest=rest.replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+/gi,' ');
  for(const token of rest.match(/[^\s`<>"'()[\]{},;，；。！？]+/gu)??[])add(token);
  return [...found.values()];
}

export function fileHintFields(body:string,cwd=process.cwd()):{hint?:string}{
  const count=parseFileReferences(body,cwd).length;
                                             
  return count<2?{}:{hint:`nxbridge: ${count} file refs; if reading: one parallel call, mind encoding`};
}
