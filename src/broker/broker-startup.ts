import {embeddedSource} from "../shared/embedded-source.js";
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { processIdentity, probeProcesses } from '../process/process.js';
import {delay} from '../shared/time.js';
import {BridgeError} from '../shared/errors.js';
import {stateDirectory} from '../storage/state-directory.js';

type Owner={pid:number;startedAt:string};
type Reservation={pid:number;generation:string;token:string;expires_at?:number};
export type StartupReservation=(()=>Promise<void>)&{token:string;assertCurrent:()=>Promise<void>};
                                            
export const BROKER_STARTUP_LEASE_MS=120000;
const filename=(home:string)=>path.join(home,'run','broker-startup.db');
const active=new Map<string,{home:string;deadline:number}>();
const leaked=(row:Reservation)=>row.pid===process.pid&&!active.has(row.token);
const changed=Symbol('reservation_changed');
let ownIdentity:ReturnType<typeof processIdentity>|undefined;
function currentIdentity(){return ownIdentity??=processIdentity(process.pid).catch(error=>{ownIdentity=undefined;throw error;});}

async function retryBusy<T>(work:()=>T,deadline:number):Promise<T>{
  for(;;)try{return work();}catch(error){
    if((error as {errcode?:number}).errcode!==5)throw error;
    if(performance.now()>=deadline)throw new BridgeError('broker_startup_busy','协调器启动或交接仍在进行，未停止 Codex；请稍后重试。');
    await delay(50);
  }
}

                                     
                                        
async function locked<T>(home:string,work:(db:DatabaseSync)=>T|Promise<T>):Promise<T>{
  const filename=path.join(home,'run','broker-startup.db');
  stateDirectory(path.dirname(filename),0o700);
  const {DatabaseSync:Database}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const deadline=performance.now()+15000;
  const db=new Database(filename,{timeout:0});
  const exec=(sql:string)=>retryBusy(()=>db.exec(sql),deadline);
  try{
    const columns=await retryBusy(()=>db.prepare(                          embeddedSource("sql", `PRAGMA table_info(reservation)`)).all(),deadline);
    if(!columns.some(row=>row.name==='expires_at')){
      await exec(                          embeddedSource("sql", `BEGIN IMMEDIATE`));
      db.exec(                          embeddedSource("sql", `CREATE TABLE IF NOT EXISTS reservation(slot INTEGER PRIMARY KEY CHECK(slot=1),pid INTEGER NOT NULL,generation TEXT NOT NULL,token TEXT NOT NULL,expires_at INTEGER NOT NULL DEFAULT 0)`));
      if(!db.prepare(                          embeddedSource("sql", `PRAGMA table_info(reservation)`)).all().some(row=>row.name==='expires_at'))db.exec(                          embeddedSource("sql", `ALTER TABLE reservation ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`));
                                        
      await exec(                          embeddedSource("sql", `COMMIT`));
    }
    await exec(                          embeddedSource("sql", `BEGIN IMMEDIATE`));
    const result=await work(db);
                                            
                                                 
    if(Number(db.prepare(                          embeddedSource("sql", `SELECT total_changes() AS n`)).get()!.n))await exec(                          embeddedSource("sql", `COMMIT`));
    else db.exec(                          embeddedSource("sql", `ROLLBACK`));
    return result;
  }catch(error){if(db.isTransaction)db.exec(                          embeddedSource("sql", `ROLLBACK`));throw error;}
  finally{db.close();}
}

function snapshot(home:string):Reservation|undefined{
  if(!existsSync(filename(home)))return;
  const {DatabaseSync:Database}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
                                                   
  const db=new Database(filename(home),{timeout:0});
  try{return db.prepare(                          embeddedSource("sql", `SELECT * FROM reservation WHERE slot=1`)).get() as Reservation|undefined;}
  catch(error){if((error as {errcode?:number}).errcode===5||/no such table: reservation/.test(String(error)))return;throw error;}
  finally{db.close();}
}

async function checked<T>(home:string,work:(db:DatabaseSync,row:Reservation|undefined)=>T|Promise<T>,trustedToken?:string):Promise<T>{
  const deadline=performance.now()+15000;
  for(;;){
    const observed=snapshot(home),expired=!!observed?.expires_at&&observed.expires_at<=Date.now();
    let state:'alive'|'dead'|'unknown'|undefined;
    if(observed&&!expired){
      if(trustedToken===observed.token)state='alive';
      else if(observed.pid===process.pid)state=(await currentIdentity().catch(()=>undefined))?.startedAt===observed.generation?'alive':'unknown';
      else state=(await probeProcesses([{pid:observed.pid,procStart:observed.generation}]))[0];
    }
    const result=await locked(home,db=>{
      let row=db.prepare(                          embeddedSource("sql", `SELECT * FROM reservation WHERE slot=1`)).get() as Reservation|undefined;
      if(row?.token!==observed?.token||(row?.expires_at??0)!==(observed?.expires_at??0))return changed;
      if(row){
        if(expired||!!row.expires_at&&row.expires_at<=Date.now()||state==='dead'){
          db.prepare(                          embeddedSource("sql", `DELETE FROM reservation WHERE slot=1 AND token=?`)).run(row.token);return changed;
        }else{
                                             
                                                 
          if(!row.expires_at){db.prepare(                          embeddedSource("sql", `UPDATE reservation SET expires_at=? WHERE slot=1 AND token=?`)).run(Date.now()+BROKER_STARTUP_LEASE_MS,row.token);return changed;}
        }
      }
      return work(db,row);
    });
    if(result!==changed)return result as T;
    if(performance.now()>=deadline)throw new BridgeError('broker_startup_busy','协调器启动预约持续变化，请稍后重试。');
  }
}

                                  
export async function startupHeldElsewhere(home:string,timeout=1500):Promise<boolean>{
  const row=snapshot(home);if(!row||!row.expires_at||row.expires_at<=Date.now()||leaked(row))return false;
  if(row.pid===process.pid)return true;
  const [state]=await probeProcesses([{pid:row.pid,procStart:row.generation}],timeout);
  return state!=='dead';
}

                             
export async function assertStartupReservation(home:string,token?:string):Promise<void>{
  const local=token?active.get(token):undefined;
  if(local&&performance.now()>=local.deadline)throw new BridgeError('broker_reservation_lost','协调器启动预约已到期，本次未继续交接。');
  await checked(home,(_db,row)=>{if(row?.token!==token)throw new BridgeError('broker_reservation_lost','协调器启动预约已经改变，本次未继续交接。');},token);
}

export async function currentStartupToken(home:string):Promise<string>{
  const row=snapshot(home);
  if(!row||!active.has(row.token)||active.get(row.token)!.home!==path.resolve(home))throw new BridgeError('broker_reservation_lost','本调用方没有有效的协调器启动预约。');
  await assertStartupReservation(home,row.token);return row.token;
}

export async function reserveBrokerStartup(home:string,owner:Owner):Promise<StartupReservation>{
  const token=randomUUID();
  await checked(home,(db,current)=>{
    if(current&&!(owner.pid===process.pid&&current.generation===owner.startedAt&&leaked(current)))throw new BridgeError('restart_in_progress','另一个重启正在进行，未停止 Codex；请等它完成后再试。');
    db.prepare(                          embeddedSource("sql", `INSERT OR REPLACE INTO reservation(slot,pid,generation,token,expires_at) VALUES(1,?,?,?,?)`)).run(owner.pid,owner.startedAt,token,Date.now()+BROKER_STARTUP_LEASE_MS);
  });
  active.set(token,{home:path.resolve(home),deadline:performance.now()+BROKER_STARTUP_LEASE_MS});
  const filename=path.join(home,'run','broker-startup.db');
  const remove=async(attempt:number):Promise<void>=>{
    if(!existsSync(filename))return;
    try{await locked(home,async db=>{db.prepare(                          embeddedSource("sql", `DELETE FROM reservation WHERE slot=1 AND token=?`)).run(token);});}
    catch{
                                                 
      if(attempt<3)setTimeout(()=>void remove(attempt+1),500).unref();
    }
  };
  const release=async()=>{active.delete(token);await remove(0);};
  return Object.assign(release,{token,assertCurrent:()=>assertStartupReservation(home,token)});
}

export async function withBrokerStartup<T>(home:string,origin:Owner[],start:()=>Promise<T>,token?:string):Promise<T|undefined>{
  return checked(home,(_db,owner)=>{
    if(token&&owner?.token!==token)return;
    if(owner&&!origin.some(p=>p.pid===owner.pid&&p.startedAt===owner.generation))return;
    return start();
  },token);
}
