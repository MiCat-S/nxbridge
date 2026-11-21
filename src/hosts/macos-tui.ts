import {execFile,type ExecFileOptionsWithStringEncoding} from 'node:child_process';
import {promisify} from 'node:util';
import {psEnvironment} from '../process/posix/posix-process.js';

const execute=promisify(execFile);
                                        
export function macosEvidenceIdentity(text:string):{pid:number;startedAt:string;image:string}|undefined{
  const row=/^\s*(\d+)\s+\d+\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+\S+\s+\S+\s+(.+?)\s*$/.exec(text);
  return row?{pid:Number(row[1]),startedAt:row[2]!.replace(/\s+/g,' '),image:row[3]!}:undefined;
}
interface File {pid:number;fd:string;type?:string;device?:string;name?:string}
export function parseLsofFields(text:string):File[]{
  const files:File[]=[];let pid=0,current:File|undefined;
  for(const line of text.split(/[\n\0]/)){const key=line[0],value=line.slice(1);if(key==='p'){pid=Number(value);current=undefined;}else if(key==='f'){current={pid,fd:value};files.push(current);}else if(current){if(key==='t')current.type=value;if(key==='d'||key==='D'&&!current.device)current.device=value.toLowerCase();if(key==='n')current.name=value;}}
  return files;
}
export async function readMacProcessOutput(binary:string,args:string[],run:(binary:string,args:string[],options:ExecFileOptionsWithStringEncoding)=>Promise<{stdout:string}>=execute):Promise<string>{
  try{return(await run(binary,args,{env:psEnvironment('darwin'),encoding:'utf8',timeout:2000,maxBuffer:1024*1024})).stdout;}
  catch(error){const value=error as {code?:unknown;stdout?:unknown;signal?:unknown;killed?:boolean};if(value.code===1&&!value.signal&&!value.killed&&typeof value.stdout==='string'&&value.stdout.trim())return value.stdout;throw error;}
}
