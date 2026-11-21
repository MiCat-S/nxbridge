import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { profileState } from './launch-profiles.js';
import { desktopHostImages, relaunchHostImage } from './host-image.js';
import { sameHostImage } from './host-launch.js';
import { executableStamp, sessionEvidenceFile } from './session-launch.js';
import {sameDirectory} from '../shared/files.js';
import type { BridgeConfig, Peer } from '../types.js';
import { deterministicLaunchFailure } from './launch-failure.js';
export { deterministicLaunchFailure } from './launch-failure.js';

export interface LaunchPark {code:string;fingerprint:string;configHome?:string;proof?:{executable?:string;profileId?:string}}
const fileStamp=(file:string|undefined)=>{if(!file)return null;try{const s=statSync(file);return[file,s.size,s.mtimeMs];}catch{return[file,'missing'];}};
const claudePrerequisites=(home:string,cwd:string)=>{
  try{const value=JSON.parse(readFileSync(path.join(home,'.claude.json'),'utf8')),project=value.projects?.[cwd.replaceAll('\\','/')]??value.projects?.[cwd];return[value.hasCompletedOnboarding,project?.hasTrustDialogAccepted,value.bypassPermissionsModeAccepted];}
  catch(error){return[(error as NodeJS.ErrnoException).code??'invalid'];}
};
                                         
export function launchInputFingerprint(home:string,config:BridgeConfig,peer:Pick<Peer,'host'|'sessionId'|'cwd'>,configHome:string,proof:{executable?:string;profileId?:string}={}):string{
  const state=profileState(home),all=[...(state.observations??[]),...state.profiles].filter(value=>value.host===peer.host&&sameDirectory(value.configHome,configHome));
  const exact=all.filter(value=>value.sourceSession===peer.sessionId),records=exact.length?exact:proof.executable?all.filter(value=>value.id===proof.profileId||sameHostImage(value.exe,proof.executable!,peer.host)):all;
  const binary=peer.host==='codex'?config.codexBinary:config.claudeBinary,command=peer.host==='codex'?config.codexCommand:config.claudeCommand,pinHome=peer.host==='codex'?config.codexHome:config.claudeHome;
  const executables=[proof.executable,binary,...(command??[]).slice(0,2),...records.map(value=>value.exe)].filter((value):value is string=>!!value);
  let history:unknown;try{history=fileStamp(peer.sessionId?sessionEvidenceFile(peer.host,configHome,peer.sessionId):undefined);}catch(error){history=[(error as {code?:string}).code??'history_unavailable'];}
  const successors=executables.map(value=>desktopHostImages(value,peer.host)).map(value=>value?[value.version,value.images.map(executableStamp)]:null);
  const present=(directory:string)=>{try{return statSync(directory).isDirectory();}catch{return false;}};
  const input=[peer.host,peer.sessionId,peer.cwd,configHome,pinHome,binary,command,[proof.executable,proof.profileId],present(peer.cwd),present(configHome),records.map(value=>[value.id,value.exe,value.version,value.capturedAt]),executables.flatMap(value=>[executableStamp(value),executableStamp(relaunchHostImage(value,peer.host))]),successors,history,peer.host==='codex'?fileStamp(path.join(configHome,'config.toml')):claudePrerequisites(configHome,peer.cwd),fileStamp(path.join(configHome,'settings.json')),fileStamp(path.join(home,'run','background-state.json'))];
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
export function parkLaunchFailure(error:unknown,home:string,config:BridgeConfig,peer:Pick<Peer,'host'|'sessionId'|'cwd'>,configHome:string,proof:{executable?:string;profileId?:string}={}):LaunchPark|undefined{
  if(!deterministicLaunchFailure(error))return;
  const inputs={configHome,proof:{...(proof.executable?{executable:proof.executable}:{}),...(proof.profileId?{profileId:proof.profileId}:{})}};
  return{code:(error as {code:string}).code,...inputs,fingerprint:launchInputFingerprint(home,config,peer,inputs.configHome,inputs.proof)};
}
