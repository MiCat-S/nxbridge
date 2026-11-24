import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import {atomicJson,readJson} from '../../shared/files.js';
import { normalizedHome, windowKey } from '../hooks/session-bindings.js';
import type {SessionRecord} from '../../hosts/claude/claude-inbox.js';
import { probeProcesses, type ProcessIdentity } from '../../process/process.js';
import { assertClaudeSession } from '../../hosts/claude/claude-session.js';
import {BridgeError} from '../../shared/errors.js';
import {type Actor} from '../../types.js';

const credentialSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),secret:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ModReadCredential=z.infer<typeof credentialSchema>;
export interface ModReadReceipt {
  protocol:1|2;scope:'mod-read';id:string;secret:string;windowId?:string;
  home:string;configHome:string;native:{pid:number;procStart:string};
  sessionId:string;revision?:string;binding?:Actor['binding'];openedAt:number;
}

function unavailable():never{throw new BridgeError('mod_read_unavailable','Mod 只读凭据不可用。');}
const directory=(home:string)=>path.join(home,'run','mod-read');
const filename=(home:string,id:string)=>path.join(directory(home),id+'.json');
const activationFile=(home:string,windowId:string)=>path.join(directory(home),'window-'+windowId+'.json');
function readReceipt(file:string):ModReadReceipt{
  const receipt=readJson<ModReadReceipt>(file);
  if(receipt.protocol!==1&&receipt.protocol!==2)unavailable();
  return receipt;
}
export function sameModReadSecret(left:string,right:string):boolean{
  return left.length===64&&right.length===64&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
}

                                                   
export async function openModReadReceipt(home:string,configHome:string,identity:{record:SessionRecord;pid:number;native:ProcessIdentity},revision?:string):Promise<ModReadCredential>{
  mkdirSync(directory(home),{recursive:true,mode:0o700});
  const procStart=(identity.record.procStartFt??identity.record.procStart)!;
  const window={host:'claude' as const,configHome:normalizedHome(configHome),pid:identity.pid,procStart};
  const id=createHash('sha256').update(windowKey(window)).digest('hex'),secret=randomBytes(32).toString('hex');
  const receipt:ModReadReceipt={protocol:2,scope:'mod-read',id,secret,home:normalizedHome(home),configHome:window.configHome,native:{pid:identity.pid,procStart},sessionId:identity.record.sessionId,...(revision?{revision}:{}),openedAt:Date.now()};
                                  
  atomicJson(filename(home,id),receipt,{durability:'buffered'});
  return{id,secret};
}

                                                 
export function readModReadReceipt(home:string,raw:unknown):ModReadReceipt{
  const parsed=credentialSchema.safeParse(raw);if(!parsed.success)unavailable();
  const credential=parsed.data;
  try{
    const receipt=readReceipt(filename(home,credential.id));
    if(receipt.home!==normalizedHome(home)||!sameModReadSecret(receipt.secret,credential.secret))unavailable();
                                        
    if(receipt.protocol===1&&readJson<{id:string}>(activationFile(home,receipt.windowId!)).id!==receipt.id)unavailable();
    assertClaudeSession(receipt.configHome,receipt.sessionId,receipt.native);
    return receipt;
  }catch{unavailable();}
}

export function bindModReadReceipt(home:string,credential:unknown,sessionId:string,binding:Actor['binding']):ModReadReceipt{
  const receipt=readModReadReceipt(home,credential);
  if(receipt.sessionId!==sessionId||!binding||binding.key!==windowKey({host:'claude',configHome:receipt.configHome,...receipt.native}))unavailable();
  return{...receipt,binding};
}

                                                 
export async function pruneModReadReceipts(home:string,probe=probeProcesses):Promise<void>{
  let names:string[];try{names=readdirSync(directory(home));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const receipts:ModReadReceipt[]=[];
  for(const name of names)if(!name.startsWith('window-'))try{receipts.push(readReceipt(path.join(directory(home),name)));}catch{}
  if(receipts.length){
    const states=await probe(receipts.map(receipt=>receipt.native));
    for(let index=0;index<receipts.length;index++)if(states[index]==='dead')try{unlinkSync(filename(home,receipts[index]!.id));}catch{}
  }
                                     
  for(const name of names)if(name.startsWith('window-'))try{
    const file=path.join(directory(home),name),{id}=readJson<{id:string}>(file);
    try{readReceipt(filename(home,id));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')unlinkSync(file);}
  }catch{}
}
