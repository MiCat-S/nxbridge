import { z } from 'zod';
import type { Store } from '../../storage/store.js';
import {BridgeError,DeliveryError,describeError} from '../../shared/errors.js';
import {type BridgeConfig,type ModelProfile,type Peer} from '../../types.js';
import { captureFrozenProfile, profileDefaults } from './frozen-profile.js';

export const modelProfileSchema=z.object({model:z.string().trim().min(1).optional(),effort:z.union([z.string().trim().min(1),z.number().finite().nonnegative()]).optional()});
export const PARTNER_PROFILE_TOOL={name:'partner_profile',description:'view/change model + effort of your current partner (nxbridge-owned bg only; user windows refused). set: model and/or effort, any value host accepts (no list; strengths/cost: partner skill). never interrupts: busy -> pending, applied at idle. result = effective (host-reported) + requested + status + delivery_held. host rejects -> partner keeps current profile; uncertain/mismatch -> delivery held till reconciled or reset. model switch resets partner prompt cache -> switch only for real reason. claude native bg: live change unsupported -> create new partner w/ profile. reset: drop member choice, live profile kept. global defaults: config propose (user confirms)',inputSchema:{type:'object' as const,properties:{action:{type:'string',enum:['get','set','reset']},model:{type:'string'},effort:{anyOf:[{type:'string'},{type:'number',minimum:0}]}},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}};
export interface PartnerProfileIntent {
  requested:ModelProfile;source:'defaults'|'explicit';status:'pending'|'applied'|'failed';
  at:number;sessionId?:string;capture?:boolean;captureEffort?:false;explicitFields?:('model'|'effort')[];context?:string;failedAt?:number;blocked?:boolean;resolved?:ModelProfile;error?:{code:string;message:string};
}
export type EffectiveModelProfile=ModelProfile&{requestedModel?:string};
const key=(peer:Peer)=>'partnerProfile:'+peer.id;
export const profileMatches=(wanted:ModelProfile,actual:{model?:string|null;effort?:string|number|null})=>
  (wanted.model===undefined||wanted.model===actual.model)&&(wanted.effort===undefined||wanted.effort===actual.effort);
export const hasProfile=(profile:ModelProfile)=>profile.model!==undefined||profile.effort!==undefined;
const rejected=(code:string)=>['-32600','-32601','-32602','profile_change_unsupported','claude_control_rejected'].includes(code);
export function profileChangeFailure(error:unknown,submitted:boolean,accepted=false):DeliveryError{
  const failure=error as {code?:unknown;phase?:string;uncertain?:boolean},code=String(failure.code??'profile_change_failed');
                                              
  const uncertain=submitted&&(accepted||failure.uncertain===true||failure.phase==='enqueue'||failure.phase!=='prepare'&&!rejected(code));
  return Object.assign(new DeliveryError(code,describeError(error),uncertain),{phase:uncertain?'enqueue':'prepare'});
}

                                     
export class PartnerProfiles {
  constructor(private store:Store,private home:string,private config:BridgeConfig){}
  intent(peer:Peer):PartnerProfileIntent|undefined{return this.store.setting<PartnerProfileIntent>(key(peer))??undefined;}
  requested(peer:Peer):ModelProfile{return this.intent(peer)?.requested??{};}
  context(peer:Peer):string{const endpoint=this.store.endpoint(peer.id);return JSON.stringify([peer.sessionId,endpoint?.epoch,endpoint?.pid,endpoint?.procStart]);}
  clear(peer:Peer):void{this.store.setSetting(key(peer),null);}
  waiting(peer:Peer,error:unknown):void{const intent=this.intent(peer);if(intent)this.store.setSetting(key(peer),{...intent,error:{code:String((error as BridgeError).code??'profile_unverified'),message:describeError(error)}});}
  initialize(peer:Peer):void{
    if(peer.owner!=='nxbridge'||peer.sessionId||this.intent(peer))return;
    this.store.setSetting(key(peer),{requested:profileDefaults(this.home,this.config,peer.host),source:'defaults',status:'pending',...(this.config.partnerProfiles?.[peer.host]?.source==='frozen'?{capture:true}:{}),at:Date.now()} satisfies PartnerProfileIntent);
  }
  set(peer:Peer,profile:ModelProfile,reset=false):void{
    const old=this.intent(peer),defaults=old?.requested??(!peer.sessionId?profileDefaults(this.home,this.config,peer.host,profile):{}),requested=reset?(peer.sessionId?{}:profileDefaults(this.home,this.config,peer.host)):{...defaults,...profile};
    const explicitFields=reset?[]:[...new Set([...(old?.explicitFields??[]),...(['model','effort'] as const).filter(field=>profile[field]!==undefined)])];
    this.store.setSetting(key(peer),{requested,explicitFields,source:reset?'defaults':'explicit',status:hasProfile(requested)?'pending':'applied',at:Math.max(Date.now(),(old?.at??0)+1),...(peer.sessionId?{sessionId:peer.sessionId}:{}),...(!peer.sessionId&&this.config.partnerProfiles?.[peer.host]?.source==='frozen'&&!explicitFields.includes('model')?{capture:true,...(explicitFields.includes('effort')?{captureEffort:false as const}:{})}:{})} satisfies PartnerProfileIntent);
  }
  syncConfiguration():void{
    for(const peer of this.store.peers()){const intent=this.intent(peer);if(intent?.capture&&this.config.partnerProfiles?.[peer.host]?.source!=='frozen')this.store.setSetting(key(peer),{...intent,capture:false});}
  }
  observed(peer:Peer,observation?:{model?:string|null;effort?:string|number|null}):void{
    const intent=this.intent(peer);if(!intent||peer.owner!=='nxbridge')return;
    let changed=false;
    if(intent.capture&&observation?.model){
      captureFrozenProfile(this.home,this.config,peer.host,{model:observation.model,...(intent.captureEffort!==false&&observation.effort!==undefined&&observation.effort!==null?{effort:observation.effort}:{})});
      if(intent.captureEffort===false||observation.effort!==undefined&&observation.effort!==null){intent.capture=false;changed=true;}
    }
    const expected=intent.resolved??intent.requested;
    if((intent.status==='pending'||intent.status==='failed'&&intent.blocked)&&observation&&profileMatches(expected,observation)){intent.status='applied';intent.resolved={...expected};intent.sessionId=peer.sessionId??undefined;intent.error=undefined;intent.blocked=false;changed=true;}
    if(intent.status==='applied'&&hasProfile(expected)&&observation&&profileMatches(expected,observation)){const context=this.context(peer);if(intent.context!==context){intent.context=context;changed=true;}}
    if(intent.status==='applied'&&observation&&((observation.model&&expected.model!==undefined&&observation.model!==expected.model)||(observation.effort!==undefined&&observation.effort!==null&&expected.effort!==undefined&&observation.effort!==expected.effort))){
      intent.status='failed';intent.blocked=true;intent.failedAt=Date.now();intent.error={code:'profile_verification_failed',message:'后台搭档报告的模型或推理强度已经偏离所选设置；新消息暂缓投递，请核对或清除选择。'};changed=true;
    }
    if(changed)this.store.setSetting(key(peer),intent);
  }
  applied(peer:Peer,actual:EffectiveModelProfile):void{
    const intent=this.intent(peer);if(!intent)return;
    const expected={...(intent.resolved??intent.requested),...(intent.requested.model!==undefined&&actual.requestedModel===intent.requested.model&&actual.model?{model:actual.model}:{})};
    if(!profileMatches(expected,actual))throw new BridgeError('profile_verification_failed','后台搭档实际用的模型或推理强度和指定的不一致。指定的设置已保留，没有改用其他模型。');
    this.store.updatePeer(peer.id,{...(actual.model!==undefined?{model:actual.model}:{}),...(actual.effort!==undefined?{effort:actual.effort}:{})});
    this.store.setSetting(key(peer),{...intent,status:'applied',resolved:expected,sessionId:peer.sessionId??undefined,context:this.context(peer),blocked:false,failedAt:undefined,error:undefined});
    this.observed(this.store.peer(peer.id),actual);
  }
  failed(peer:Peer,error:unknown):void{
    const intent=this.intent(peer),code=String((error as BridgeError).code??'profile_change_failed');
    if(intent)this.store.setSetting(key(peer),{...intent,status:'failed',failedAt:Date.now(),blocked:code==='profile_verification_failed'||((error as {uncertain?:boolean}).uncertain??!rejected(code)),error:{code,message:describeError(error)}});
  }
  blocks(peer:Peer):boolean{if(peer.owner!=='nxbridge')return false;const intent=this.intent(peer);return !!intent&&hasProfile(intent.requested)&&(intent.status==='failed'?intent.blocked!==false:intent.status==='pending'||intent.context!==this.context(peer));}
  view(peer:Peer){const intent=this.intent(peer);return{effective:{...(peer.model?{model:peer.model}:{}),...(peer.effort!==undefined?{effort:peer.effort}:{})},delivery_held:this.blocks(peer),...(intent?{requested:intent.requested,status:intent.status,source:intent.source,at:intent.at,...(intent.error?{error:intent.error}:{})}:{status:'host' as const})};}
}
