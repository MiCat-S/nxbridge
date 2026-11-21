import '../../sqlite-warning.js';
import { randomUUID } from 'node:crypto';
import {claudeIdentity,claudeRegistration} from '../../hosts/claude/identity.js';
import { brokerCall } from '../../ipc/ipc.js';
import {BridgeError} from '../../shared/errors.js';
import {type Actor} from '../../types.js';
import { z } from 'zod';
import { modelError } from './model-error.js';
import { modContextSchema } from '../mod/mod-protocol.js';
import { claudeObservedPermission } from '../../hosts/claude/claude-inbound.js';

                                                   
async function main():Promise<void>{
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw new BridgeError('input_too_large','问题控制输入超过限制。');}
  const p=modContextSchema.extend({operation:z.enum(['create','get','answer','answer_user','cancel','cancel_turn','origin','wait']),form_lease:z.string().optional(),callId:z.string().optional(),request_id:z.string().optional(),message_id:z.string().optional(),questions:z.unknown().optional(),turn_id:z.string().optional(),tool_use_id:z.string().optional(),task_message_id:z.string().optional(),input:z.unknown().optional()}).strict().parse(JSON.parse(raw));
  const identity=await claudeIdentity(p.sessionId);
  const registration=claudeRegistration(identity,p.inbox,true);registration.expectedBinding=p.binding;registration.contextStart=p.contextStart;registration.contextReason=p.contextReason;
  if(p.nativePermission||p.nativeDecision){registration.permission=claudeObservedPermission(p.nativePermission?.mode,p.nativeDecision);registration.endpoint.nativePermission={permission:registration.permission,mode:p.nativePermission?.mode??'unknown',observedAt:Math.max(p.nativePermission?.observedAt??0,p.nativeDecision?.observedAt??0)};}
  if(p.nativeDecision)registration.endpoint.nativeDecision=p.nativeDecision;
  if(p.nativeInbound)registration.endpoint.nativeInbound={...p.nativeInbound,...(p.nativePermission||p.nativeDecision?{permission:registration.permission}:{})};
  if(p.nativeProfile)registration.endpoint.nativeProfile=p.nativeProfile;
  const registered=await brokerCall<{binding?:Actor['binding']}>('register',registration);
  const actor:Actor={host:'claude',sessionId:identity.record.sessionId,callId:p.callId??randomUUID(),...(registered.binding?{binding:registered.binding}:{})};
  const methods={create:'question.create',get:'question.get',answer:'question.answer',answer_user:'question.answer_user',cancel:'question.cancel',cancel_turn:'question.cancel_turn',origin:'question.origin',wait:'question.wait'};
  const params={actor,...(p.form_lease?{form_lease:p.form_lease}:{}),...(p.operation==='create'?{questions:p.questions,turn_id:p.turn_id,tool_use_id:p.tool_use_id,task_message_id:p.task_message_id}:p.operation==='origin'?{message_id:p.message_id}:p.operation==='cancel_turn'?{turn_id:p.turn_id}:p.operation==='answer'||p.operation==='answer_user'?{input:p.input}:{request_id:p.request_id})};
  let value=await brokerCall<any>(methods[p.operation],params,{mutation:['create','answer','answer_user','cancel','cancel_turn'].includes(p.operation)});
  if(p.operation==='wait')while(value.status==='pending'||value.status==='awaiting_user')value=await brokerCall(methods.wait,params,{start:false});
  process.stdout.write(JSON.stringify({value,context:{sessionId:identity.record.sessionId,binding:registered.binding}})+'\n');
}
main().catch(error=>{const detail=modelError(error);process.stderr.write(JSON.stringify({...detail,model_message:detail.message})+'\n');process.exitCode=1;});
