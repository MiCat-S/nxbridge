import { z } from 'zod';
import { nativeHealthSchema } from '../../broker/health/foreground-health.js';
import { nativeAutoModeSchema, nativeBackgroundSchema } from '../../hosts/claude/claude-auto-mode.js';
import {BridgeError} from '../../shared/errors.js';

export interface ModContext {sessionId:string;binding?:unknown}

                                                           
export async function modInput(argument:string|undefined,stdin:AsyncIterable<Uint8Array>=process.stdin):Promise<unknown>{
  if(argument!=='-')return JSON.parse(argument??'{}');
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const chunk of stdin){bytes+=chunk.byteLength;if(bytes>2*1024*1024)throw new BridgeError('input_too_large','Mod 输入超过限制。');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export const nativeInboundSchema=z.object({policy:z.enum(['accept','hold','refuse','default','unknown']),source:z.enum(['policy','flag','user','project','local','invalid','default']).optional(),dialogExpiry:z.string().max(20).optional(),dialogTimeoutMs:z.number().int().positive().optional(),observedAt:z.number().finite().nonnegative()});
                                             
const profileValues=z.object({model:z.string().min(1).max(200).optional(),effort:z.union([z.string().min(1).max(40),z.number().finite()]).optional()}).strict();
export const nativeProfileSchema=z.object({model:z.string().min(1).max(200).optional(),flag:profileValues.optional(),effective:profileValues.optional(),effortOverride:z.string().min(1).max(40).optional(),runtimeEffort:profileValues.shape.effort.nullable(),effortUnverified:z.boolean().optional(),observedAt:z.number().finite().nonnegative()}).strict();
export type NativeProfile=z.infer<typeof nativeProfileSchema>;
export const nativeProfileEffort=(profile:NativeProfile)=>profile.effortOverride??(profile.effortUnverified?undefined:profile.runtimeEffort!==undefined?profile.runtimeEffort??undefined:profile.effective?.effort);
export const nativeDecisionSchema=z.object({bash:z.enum(['allow','ask','deny']),rule:z.string().max(200).optional(),observedAt:z.number().finite().nonnegative()});
export const nativeSessionSchema=z.object({transcriptPath:z.string().min(1).max(4096).optional(),interactive:z.boolean().optional()});
export type NativeDecision=z.infer<typeof nativeDecisionSchema>;

                                            
export const modContextSchema=z.object({
  sessionId:z.string(),inbox:z.string().min(1),cwd:z.string().optional(),
  binding:z.object({key:z.string(),epoch:z.string()}).optional(),contextStart:z.boolean().optional(),
  contextReason:z.enum(['reset','switch','fork','unknown']).optional(),
  nativePermission:z.object({mode:z.string(),observedAt:z.number().finite().nonnegative()}).optional(),
  nativeDecision:nativeDecisionSchema.optional(),
  nativeInbound:nativeInboundSchema.optional(),
  nativeProfile:nativeProfileSchema.optional(),
  nativeAutoMode:nativeAutoModeSchema.optional(),
  nativeBackground:nativeBackgroundSchema.optional(),
  nativeHealth:nativeHealthSchema.optional(),
  nativeSession:nativeSessionSchema.optional(),
});

                                        
export function modResponse(input:{contextStart?:unknown;binding?:unknown},value:unknown,context:ModContext):unknown{
  return Object.hasOwn(input,'contextStart')||input.binding!==undefined?{value,context}:value;
}

                                                   
export function modMonitorAdmission(input:{operation:string;mod_revision?:unknown}):boolean{
  return input.operation==='monitor-prepare'||typeof input.mod_revision!=='string'||!/^[a-f0-9]{16}$/.test(input.mod_revision);
}
