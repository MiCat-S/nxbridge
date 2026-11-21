import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../storage/store.js';
import type { Endpoint, Host, Peer } from '../../types.js';

export type SessionHistoryState='present'|'missing'|'unknown';
export interface SessionHistoryOptions {fresh?:boolean}
export const sessionHistoryKey=(peerId:string):string=>'sessionHistory:'+peerId;

interface DirectoryIdentity {dev:string;ino:string;birthtime:string}
interface HistoryProof {host:Host;sessionId:string;configHome:string;realHome:string;file:string;observedFile?:string;compressedFile?:string;stores:string[];storePaths?:Record<string,string>;storeIdentities?:Record<string,DirectoryIdentity>}
interface AccessibleStores {names:string[];paths:Record<string,string>;identities:Record<string,DirectoryIdentity>}
interface NativeIdentity {ids:string[];unknown:boolean}
interface HistorySnapshot {sessions:Map<string,Set<string>>;compressed:Set<string>;unknown:boolean;complete:boolean;at:number}
interface HistoryCache {snapshot?:HistorySnapshot;failures:number;retryAt:number}
interface HistoryResult {state:SessionHistoryState;file?:string;compressedFile?:string}
type NativeEndpoint=Endpoint&{nativeSession?:{transcriptPath?:string}};
type Identity='match'|'other'|'unknown';
const HEAD_BYTES=64*1024,HEAD_LINES=64,SEARCH_ENTRIES=1024,SEARCH_BYTES=8*1024*1024,CACHE_HOMES=16,MISSING_TTL=30000;
const scans=new WeakMap<Store,Map<string,HistoryCache>>();
const verifications=new WeakMap<Store,Map<string,Promise<SessionHistoryState>>>();
const pathKey=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';
const storesFor=(host:Host)=>host==='codex'?['sessions','archived_sessions']:['projects'];
const nativeFile=(endpoint:Endpoint)=>(endpoint as NativeEndpoint).nativeSession?.transcriptPath;
const within=(root:string,file:string)=>{const relative=path.relative(root,file);return !!relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};

function context(peer:Peer,endpoint:Endpoint):{configHome:string;realHome:string}|undefined{
  if(!peer.sessionId||!['root','fork'].includes(peer.kind)||endpoint.peerId!==peer.id||!endpoint.configHome||!path.isAbsolute(endpoint.configHome))return;
  const configHome=pathKey(endpoint.configHome),realHome=pathKey(fs.realpathSync.native(configHome));
  if(!fs.statSync(realHome).isDirectory())return;
  return{configHome,realHome};
}

                                     
function readIdentity(file:string,host:Host,budget?:{bytes:number}):NativeIdentity{
  const fd=fs.openSync(file,'r');
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile())return{ids:[],unknown:true};
    const length=Math.min(stat.size,HEAD_BYTES);
    if(budget)budget.bytes-=length;
    const buffer=Buffer.alloc(length);let size=0;
    while(size<buffer.length){const read=fs.readSync(fd,buffer,size,buffer.length-size,size);if(!read)break;size+=read;}
    const text=buffer.toString('utf8',0,size),lines=text.split('\n');
    if(size<stat.size)lines.pop();
    const ids=new Set<string>();
    for(const line of lines.filter(line=>line.trim()).slice(0,HEAD_LINES)){
      let row:any;try{row=JSON.parse(line);}catch{return{ids:[...ids],unknown:true};}
      if(host==='codex')return row?.type==='session_meta'&&typeof row.payload?.id==='string'&&row.payload.id?{ids:[row.payload.id],unknown:false}:{ids:[],unknown:true};
      if(typeof row?.sessionId==='string'&&row.sessionId)ids.add(row.sessionId);
    }
    return{ids:[...ids],unknown:ids.size===0};
  }finally{fs.closeSync(fd);}
}

function historyIdentity(file:string,host:Host,sessionId:string):Identity{
  const identity=readIdentity(file,host);
  return identity.ids.includes(sessionId)?'match':identity.unknown?'unknown':'other';
}

                                                  
function accessibleStores(home:string,host:Host,previous:string[]=[]):AccessibleStores|undefined{
  const names:string[]=[],paths:Record<string,string>={},identities:Record<string,DirectoryIdentity>={};
  for(const name of storesFor(host)){
    const directory=path.join(home,name);let stat:fs.BigIntStats;
    try{stat=fs.statSync(directory,{bigint:true});}
    catch(error){if(name==='archived_sessions'&&missing(error)&&!previous.includes(name))continue;throw error;}
    if(!stat.isDirectory()||stat.ino===0n)return;
    names.push(name);paths[name]=pathKey(fs.realpathSync.native(directory));identities[name]={dev:String(stat.dev),ino:String(stat.ino),birthtime:String(stat.birthtimeNs)};
  }
  return{names,paths,identities};
}

const sameDirectory=(left:DirectoryIdentity|undefined,right:DirectoryIdentity|undefined)=>!!left&&!!right&&left.dev===right.dev&&left.ino===right.ino&&left.birthtime===right.birthtime;
const sameStores=(proof:HistoryProof,current:AccessibleStores)=>proof.stores.every(name=>sameDirectory(proof.storeIdentities?.[name],current.identities[name]));
const fileStamp=(stat:fs.BigIntStats)=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
                                               
const storeRoot=(proof:HistoryProof,name:string)=>proof.storePaths?.[name]??path.join(proof.realHome,name);
const withinStores=(proof:HistoryProof,file:string,directory=false)=>proof.stores.some(name=>within(storeRoot(proof,name),file)||directory&&pathKey(file)===storeRoot(proof,name));

function cacheFor(store:Store,proof:HistoryProof,stores:AccessibleStores):HistoryCache{
  let homes=scans.get(store);if(!homes){homes=new Map();scans.set(store,homes);}
  const original=path.basename(proof.file),extraName=/\.jsonl(?:\.|$)/i.test(original)?undefined:original;
  const key=JSON.stringify([proof.host,proof.realHome,stores.identities,extraName]);let cache=homes.get(key);
  if(!cache)cache={failures:0,retryAt:0};
  homes.delete(key);homes.set(key,cache);
  if(homes.size>CACHE_HOMES)homes.delete(homes.keys().next().value!);
  return cache;
}

                                                   
export function recordSessionHistory(store:Store,peer:Peer,endpoint:Endpoint,file=nativeFile(endpoint)):void{
  const key=sessionHistoryKey(peer.id),previous=store.setting<HistoryProof>(key);
  const same=previous&&previous.host===peer.host&&previous.sessionId===peer.sessionId&&endpoint.configHome&&path.isAbsolute(endpoint.configHome)&&previous.configHome===pathKey(endpoint.configHome)&&(!file||path.isAbsolute(file)&&previous.file===pathKey(file));
  if(previous&&!same)store.setSetting(key,null);
  let scope:ReturnType<typeof context>;
  try{scope=context(peer,endpoint);}catch{return;}
  if(!scope)return;
  if(same&&previous.realHome!==scope.realHome)store.setSetting(key,null);
  let proof:HistoryProof|undefined,invalid=false;
  try{
    if(!file||!path.isAbsolute(file))return;
    const filename=pathKey(file),realFile=fs.realpathSync.native(filename),stores=accessibleStores(scope.realHome,peer.host,same?previous.stores:[]);
    if(!stores)return;
    if(!stores.names.some(name=>within(stores.paths[name]!,realFile))){invalid=true;}
    else if(historyIdentity(filename,peer.host,peer.sessionId!)!=='match'){invalid=true;}
    else{
      proof={host:peer.host,sessionId:peer.sessionId!,...scope,file:filename,stores:stores.names,storePaths:stores.paths,storeIdentities:stores.identities};
    }
  }catch{                                           }
  if(proof){if(JSON.stringify(proof)!==JSON.stringify(previous))store.setSetting(key,proof);}
  else if(invalid&&same)store.setSetting(key,null);
}

function auxiliaryDirectory(proof:HistoryProof,file:string):boolean{
  if(proof.host!=='claude'||!['memory','tool-results'].includes(path.basename(file)))return false;
                                          
  const depth=path.relative(path.join(proof.realHome,'projects'),file).split(path.sep).length;
  return depth===2||depth===3&&path.basename(file)==='tool-results';
}

const yieldScan=()=>new Promise<void>(resolve=>setImmediate(resolve));

                                            
async function scanHistory(proof:HistoryProof,stores:AccessibleStores):Promise<HistorySnapshot>{
  const snapshot:HistorySnapshot={sessions:new Map(),compressed:new Set(),unknown:false,complete:false,at:Date.now()};
  const pending=stores.names.map(name=>path.join(proof.realHome,name)),directories=new Map<string,string>();
  let remaining=SEARCH_ENTRIES,budget={bytes:SEARCH_BYTES},started=performance.now();
  while(pending.length){
    const directory=pending.pop()!,stat=fs.statSync(directory,{bigint:true});
    if(!stat.isDirectory()||!withinStores(proof,fs.realpathSync.native(directory),true))throw new Error('历史目录身份无法确认');
    directories.set(directory,fileStamp(stat));
                                                 
    const entries=await fs.promises.readdir(directory,{withFileTypes:true});
    for(const entry of entries){
      if(remaining--<=0||budget.bytes<HEAD_BYTES||performance.now()-started>=20){await yieldScan();remaining=SEARCH_ENTRIES;budget={bytes:SEARCH_BYTES};started=performance.now();}
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){if(!auxiliaryDirectory(proof,file))pending.push(file);continue;}
      if(!entry.isFile()){snapshot.unknown=true;continue;}
      if(entry.name!==path.basename(proof.file)&&!/\.jsonl(?:\.|$)/i.test(entry.name))continue;
      if(/\.jsonl\.(?:gz|gzip|zst|zstd|xz|bz2|br|zip|lz4|lzma)$/i.test(entry.name)){snapshot.compressed.add(file);continue;}
      const stamp=fileStamp(fs.lstatSync(file,{bigint:true})),identity=readIdentity(file,proof.host,budget);
      if(fileStamp(fs.lstatSync(file,{bigint:true}))!==stamp)throw new Error('读取期间历史发生变化');
      snapshot.unknown||=identity.unknown;
      for(const id of identity.ids){let files=snapshot.sessions.get(id);if(!files){files=new Set();snapshot.sessions.set(id,files);}files.add(file);}
      if(identity.ids.includes(proof.sessionId)){snapshot.at=Date.now();return snapshot;}
    }
  }
  for(const [directory,stamp] of directories){
    if(remaining--<=0||performance.now()-started>=20){await yieldScan();remaining=SEARCH_ENTRIES;started=performance.now();}
    if(fileStamp(fs.statSync(directory,{bigint:true}))!==stamp)throw new Error('枚举期间历史目录发生变化');
  }
  snapshot.complete=true;snapshot.at=Date.now();return snapshot;
}

function scopedProof(store:Store,peer:Peer,endpoint:Endpoint):HistoryProof|undefined{
  const proof=store.setting<HistoryProof>(sessionHistoryKey(peer.id));
  if(!proof||proof.host!==peer.host||proof.sessionId!==peer.sessionId)return;
  const scope=context(peer,endpoint),current=nativeFile(endpoint);
  if(!scope||scope.configHome!==proof.configHome||scope.realHome!==proof.realHome||current&&(!path.isAbsolute(current)||pathKey(current)!==proof.file))return;
  return proof;
}

function plainHistory(proof:HistoryProof,file:string):HistoryResult|undefined{
  try{
    if(!withinStores(proof,fs.realpathSync.native(file)))return{state:'unknown'};
    return historyIdentity(file,proof.host,proof.sessionId)==='match'?{state:'present',file}:{state:'unknown'};
  }catch(error){if(!missing(error))throw error;}
}

function knownHistory(proof:HistoryProof):HistoryResult|undefined{
  for(const file of new Set([proof.file,proof.observedFile].filter((file):file is string=>!!file))){const result=plainHistory(proof,file);if(result)return result;}
  if(proof.compressedFile){
    try{
      if(!withinStores(proof,fs.realpathSync.native(proof.compressedFile))||!fs.statSync(proof.compressedFile).isFile())return{state:'unknown'};
      return{state:'present',compressedFile:proof.compressedFile};
    }catch(error){if(!missing(error))throw error;}
  }
}

function compressedMatches(proof:HistoryProof,file:string):boolean{
  const plain=path.basename(file).replace(/\.[^.]+$/,'');
  return plain===path.basename(proof.file)||plain===proof.sessionId+'.jsonl'||plain.endsWith('-'+proof.sessionId+'.jsonl');
}

function snapshotResult(proof:HistoryProof,snapshot:HistorySnapshot):HistoryResult{
  for(const file of snapshot.sessions.get(proof.sessionId)??[]){const result=plainHistory(proof,file);if(result)return result;}
  for(const file of snapshot.compressed){
    if(compressedMatches(proof,file)){
      try{if(fs.lstatSync(file).isFile())return{state:'present',compressedFile:pathKey(file)};}catch(error){if(!missing(error))throw error;}
    }
  }
  return{state:snapshot.complete&&!snapshot.unknown&&!snapshot.compressed.size?'missing':'unknown'};
}

function rememberFound(store:Store,peer:Peer,proof:HistoryProof,result:HistoryResult):HistoryResult{
  if(result.file||result.compressedFile){
    const observed=result.file&&pathKey(result.file),next={...proof,observedFile:observed===proof.file?undefined:observed,compressedFile:result.compressedFile};
    if(JSON.stringify(next)!==JSON.stringify(proof))store.setSetting(sessionHistoryKey(peer.id),next);
  }
  return result;
}

function rememberStores(store:Store,peer:Peer,proof:HistoryProof,stores:AccessibleStores):HistoryProof{
  if(!stores.names.some(name=>!proof.stores.includes(name)))return proof;
                                         
  const next={...proof,stores:stores.names,storePaths:stores.paths,storeIdentities:stores.identities};store.setSetting(sessionHistoryKey(peer.id),next);return next;
}

function evaluateSessionHistory(store:Store,peer:Peer,endpoint:Endpoint):HistoryResult{
  try{
    let proof=scopedProof(store,peer,endpoint);if(!proof)return{state:'unknown'};
    const known=knownHistory(proof);if(known)return rememberFound(store,peer,proof,known);
    const stores=accessibleStores(proof.realHome,peer.host,proof.stores);if(!stores||!sameStores(proof,stores))return{state:'unknown'};
    proof=rememberStores(store,peer,proof,stores);
    const snapshot=cacheFor(store,proof,stores).snapshot;
    if(!snapshot||Date.now()-snapshot.at>=MISSING_TTL)return{state:'unknown'};
    return rememberFound(store,peer,proof,snapshotResult(proof,snapshot));
  }catch{return{state:'unknown'};}
}

                                                   
export function sessionHistoryState(store:Store,peer:Peer,endpoint:Endpoint,_options:SessionHistoryOptions={}):SessionHistoryState{
  return evaluateSessionHistory(store,peer,endpoint).state;
}

                                         
export function sessionHistoryPath(store:Store,peer:Peer,endpoint:Endpoint,_options:SessionHistoryOptions={}):string|undefined{
  return evaluateSessionHistory(store,peer,endpoint).file;
}

                                                
export function sessionHistoryNeedsVerification(store:Store,peer:Peer,endpoint:Endpoint):boolean{
  try{
    let proof=scopedProof(store,peer,endpoint);if(!proof)return false;
    for(const file of new Set([proof.file,proof.observedFile,proof.compressedFile].filter((file):file is string=>!!file))){
      if(!path.isAbsolute(file))return false;
      try{fs.lstatSync(file);return false;}catch(error){if(!missing(error))return false;}
    }
    const stores=accessibleStores(proof.realHome,peer.host,proof.stores);if(!stores||!sameStores(proof,stores))return false;
    proof=rememberStores(store,peer,proof,stores);
    for(const name of stores.names)fs.accessSync(path.join(proof.realHome,name),fs.constants.R_OK);
    const cache=cacheFor(store,proof,stores),snapshot=cache.snapshot;
    const discovered=new Set(snapshot?.sessions.get(proof.sessionId));
    for(const file of snapshot?.compressed??[])if(compressedMatches(proof,file))discovered.add(file);
    for(const file of discovered){try{fs.lstatSync(file);return false;}catch(error){if(!missing(error))return false;}}
    return Date.now()>=cache.retryAt;
  }catch{return false;}
}

function verificationScope(peer:Peer,endpoint:Endpoint,proof:HistoryProof):string{
  return JSON.stringify([peer.id,peer.host,peer.sessionId,peer.kind,peer.owner,peer.rootPeerId,peer.rootBinding,proof,{
    peerId:endpoint.peerId,epoch:endpoint.epoch,mode:endpoint.mode,address:endpoint.address,pid:endpoint.pid,procStart:endpoint.procStart,
    configHome:endpoint.configHome,native:endpoint.native,bridge:endpoint.bridge,bindingEpoch:endpoint.bindingEpoch,runtimeId:endpoint.runtimeId,
    active:endpoint.active,launchProfileId:endpoint.launchProfileId,processKind:endpoint.processKind,daemon:endpoint.daemon,transcriptPath:nativeFile(endpoint),
  }]);
}

async function verifyScopedHistory(store:Store,peer:Peer,endpoint:Endpoint,proof:HistoryProof,stores:AccessibleStores,cache:HistoryCache,scope:string):Promise<SessionHistoryState>{
  try{
    const snapshot=await scanHistory(proof,stores),current=scopedProof(store,peer,endpoint),after=accessibleStores(proof.realHome,peer.host,proof.stores);
                                           
    if(!current||verificationScope(peer,endpoint,current)!==scope||!after||!sameStores(proof,after)||after.names.length!==stores.names.length)throw new Error('核验期间历史范围发生变化');
    const result=snapshotResult(current,snapshot);cache.snapshot=snapshot;
    if(result.state==='unknown'){cache.failures=Math.min(cache.failures+1,6);cache.retryAt=Date.now()+Math.min(15000*2**(cache.failures-1),300000);}
    else{cache.failures=0;cache.retryAt=0;}
    return rememberFound(store,peer,current,result).state;
  }catch{
    cache.snapshot=undefined;cache.failures=Math.min(cache.failures+1,6);cache.retryAt=Date.now()+Math.min(15000*2**(cache.failures-1),300000);
    return'unknown';
  }
}

                                                     
export function verifySessionHistory(store:Store,peer:Peer,endpoint:Endpoint,options:SessionHistoryOptions={}):Promise<SessionHistoryState>{
  try{
    let proof=scopedProof(store,peer,endpoint);if(!proof)return Promise.resolve('unknown');
    const known=knownHistory(proof);
    if(known&&(!options.fresh||!known.compressedFile))return Promise.resolve(rememberFound(store,peer,proof,known).state);
    const stores=accessibleStores(proof.realHome,peer.host,proof.stores);if(!stores||!sameStores(proof,stores))return Promise.resolve('unknown');
    proof=rememberStores(store,peer,proof,stores);
    const scope=verificationScope(peer,endpoint,proof);let pending=verifications.get(store);
    if(!pending){pending=new Map();verifications.set(store,pending);}
    const active=pending.get(scope);if(active)return active;
    const cache=cacheFor(store,proof,stores);if(!options.fresh&&Date.now()<cache.retryAt)return Promise.resolve('unknown');
    const jobs=pending,result=verifyScopedHistory(store,peer,endpoint,proof,stores,cache,scope).finally(()=>jobs.delete(scope));
    jobs.set(scope,result);return result;
  }catch{return Promise.resolve('unknown');}
}
