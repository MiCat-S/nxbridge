import { modelMessage } from './errors.js';
import { call, captureContext, unpackContext } from './mod-control.js';
import { nativeForm, isNativeForm } from './native-form.js';

const peerOrigin = origin => ['peer', 'peer-send-message'].includes(origin?.kind);
const messageId = text => typeof text === 'string' && /\[nxbridge message_id=([0-9a-f-]+)/.exec(text)?.[1];

                                                                        
                                                                       
const trace=[];
const note=entry=>{trace.push({at:Date.now(),...entry});if(trace.length>12)trace.shift();};
                                     
export class TurnSources {
  candidate;
  current;
  submit(e) {
    const id = peerOrigin(e.origin) && messageId(e.text);
    note({p:'submit',kind:e.origin?.kind??'none',inTurn:!!e.turnId,...(id?{id}:{})});
    if (e.turnId) return;
    this.candidate = id ? { id } : undefined;
  }
  append(id, uuid, text) {
    const evidence = { id, text };
    const candidate = this.candidate?.id === id ? this.candidate : this.current?.candidate?.id === id ? this.current.candidate : undefined;
    if (candidate) { candidate.uuid = uuid; candidate.evidence = evidence; }
    if (candidate && this.current?.candidate === candidate) this.current.source = candidate.uuid ? id : undefined;
    note({p:'append',id,r:candidate?(candidate.uuid?'ok':'no_uuid'):'no_candidate'});
    return evidence;
  }
  start(e) {
    if (e.agentId) return;
    const candidate = this.candidate;
    this.current = { turnId: e.turnId, candidate, source: candidate?.uuid ? candidate.id : undefined };
    note({p:'start',candidate:!!candidate,uuid:!!candidate?.uuid,source:!!this.current.source});
    this.candidate = undefined;
  }
  source(agentId) { return agentId ? undefined : this.current?.source; }
  clear() { this.candidate = undefined; this.current = undefined; }
}

async function input($, operation, payload) {
  const {context,...data}=payload;
  return { operation,...(context??await captureContext($)),...data };
}
async function control($, operation, payload = {}) {
  const context=payload.context??await captureContext($);
  const result = await $.process.run(['node', '--no-warnings', $.plugin.root + '/bridge.cjs', 'question-control'], { stdin: JSON.stringify(await input($, operation, {...payload,context})) });
  if (result.exitCode !== 0) {
    let detail; try { detail = JSON.parse(result.stderr.trim()); } catch {}
    throw Object.assign(new Error(detail?.message || result.stderr || 'question control failed'             ), { code: detail?.code, model_message: detail?.model_message, uncertain: detail ? detail.uncertain === true : true });
  }
  return unpackContext(JSON.parse(result.stdout),context);
}
                                          
const verifications = new WeakMap();
function verifySource($, evidence, context) {
  if (!verifications.has(evidence)) verifications.set(evidence, (async () => {
    try {
      const original = await control($, 'origin', { message_id: evidence.id, context });
      if (evidence.text.includes(original.body.replaceAll('</cross-session-message>', '&lt;/cross-session-message&gt;'))) return true;
      note({p:'append',id:evidence.id,r:'body_mismatch'});
    } catch (error) { note({p:'append',id:evidence.id,r:'origin_error',code:typeof error?.code==='string'?error.code.slice(0,64):'unknown'}); }
    return false;
  })());
  return verifications.get(evidence);
}
async function wait($, requestId,context) {
  let stdout = '', stderr = '';
  const stream = $.process.spawn({ argv: ['node', '--no-warnings', $.plugin.root + '/bridge.cjs', 'question-control'], input: JSON.stringify(await input($, 'wait', { request_id: requestId,context })) });
  for await (const piece of stream) {
    if (piece.stream === 'stdout') stdout += piece.text;
    else stderr += piece.text;
  }
  if (!stdout.trim()) throw new Error(stderr || 'partner wait interrupted'              );
  return unpackContext(JSON.parse(stdout),context);
}
async function human($, next, run,context) {
  try { await call($,'state',{state:'needsHuman',context}); } catch {}
  try { return await run(); }
  finally { if (!next.signal.aborted) try { await call($,'state',{state:'busy',context}); } catch {} }
}

const option = { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' }, preview: { type: 'string' } }, required: ['label', 'description'], additionalProperties: false };
const question = { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, header: { type: 'string' }, options: { type: 'array', items: option }, multiSelect: { type: 'boolean' }, isOther: { type: 'boolean' } }, required: ['question', 'header'], additionalProperties: false };
export const ANSWER_SPEC = {
  name: 'answer_question', isDeferred: false,
                                                                                                                                                                  
                                      
  description: 'answer pending codex q: request_id, answers for every q {exact question text: answer}, rationale. user must decide -> action=ask_user, omit answers -> mod shows native form w/ saved questions. optional: questions (exact echo), annotations. no counter-ask',
  inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, questions: { type: 'array', items: question }, annotations: { type: 'object' }, action: { type: 'string', enum: ['answer', 'ask_user'] }, answers: { type: 'object', additionalProperties: { type: 'string' } }, rationale: { type: 'string' } }, required: ['request_id'], additionalProperties: false },
};

const sources = new TurnSources();
let answerTool;
let sourceSession;
async function questionContext($){const context=await captureContext($);if(sourceSession!==context){if(sourceSession)note({p:'reset'});sources.clear();sourceSession=context;}return context;}
export async function questionSubmit($, e, next) { await questionContext($);sources.submit(e); return next(e); }
                                                        
export async function questionCall($, e, next) {
    const context=await questionContext($);
    if (answerTool && e.tool === answerTool) {
      const args = Object.fromEntries(['request_id', 'questions', 'annotations', 'action', 'answers', 'rationale'].filter(key => e[key] !== undefined).map(key => [key, e[key]]));
      let escalating = false, nativeAnswers, nativeAnnotations,formLease;
      try {
        const receipt = await control($, 'answer', { callId: e.tool_use_id, input: args,context });
        if (args.action !== 'ask_user' || receipt.status !== 'awaiting_user' || receipt.replayed) return { result: JSON.stringify(receipt) };
        escalating = true;
        formLease=receipt.form_lease;
        const native = await human($, next, () => nativeForm($,receipt.questions),context);
        nativeAnswers = native.result?.answers; nativeAnnotations = native.result?.annotations;
        if (!native.result?.answers) throw Object.assign(new Error('native ask returned incomplete answers'                   ), { model_message: 'native form returned no full answers' });
                                   
        const result = await control($, 'answer_user', { callId: e.tool_use_id + ':user',context,form_lease:formLease, input: { request_id: args.request_id, answers: native.result.answers, rationale: 'answered by user via claude native form', ...(native.result.annotations ? { annotations: native.result.annotations } : {}) } });
        return { result: JSON.stringify({ ...result, user_answers: nativeAnswers, ...(nativeAnnotations ? { user_annotations: nativeAnnotations } : {}) }) };
      } catch (error) {
        if (escalating || args.action === 'ask_user' && error?.uncertain === true) try {
          const ended = await control($, 'cancel', { request_id: args.request_id,context,...(formLease?{form_lease:formLease}:{}) });
          if (ended.status === 'answered') return { result: JSON.stringify({ ...ended, ...(nativeAnswers ? { user_answers: nativeAnswers } : {}), ...(nativeAnnotations ? { user_annotations: nativeAnnotations } : {}) }) };
        } catch {}
        if (next.signal.aborted) throw error;
        return { deny: 'answer to codex q not completed: '                         + modelMessage(error) + (nativeAnswers ? '\n' + JSON.stringify({ request_id: args.request_id, user_answers: nativeAnswers, ...(nativeAnnotations ? { user_annotations: nativeAnnotations } : {}) }) : '') };
      }
    }
    if (e.tool !== 'AskUserQuestion') return next(e);
    if(isNativeForm(e))return next(e);
    const evidence = turnSource(e.agentId, context);
    let task;
    if(evidence){
      const turn=sources.current,verified=await verifySource($,evidence,context);
      if((await captureContext($))!==context||sources.current!==turn||turn.candidate.evidence!==evidence)return{deny:'origin context changed; old native question canceled'};
      if(verified)task=evidence.id;else turn.source=undefined;
    }
    if (!task) {
                                      
      if (!e.agentId && trace.slice(trace.findLastIndex(entry => entry.p === 'reset') + 1).some(entry => entry.id)) { note({ p:'ask', source:false }); try { await call($, 'register', { context, question_diagnostics: trace.slice() }); } catch {} }
      return human($, next, () => next(e),context);
    }
    let requestId;
    try {
      const created = await control($, 'create', { callId: e.tool_use_id, questions: e.questions, turn_id: sources.current?.turnId, tool_use_id: e.tool_use_id, task_message_id: task,context });
      requestId = created.request_id;
      const result = created.status === 'pending' ? await wait($, requestId,context) : created;
      if((await captureContext($))!==context)throw new Error('origin context changed');
      if (next.signal.aborted) throw new Error('user interrupted'            );
                                                       
      if (result.status === 'answered') return { result: { questions: e.questions, answers: result.answers, ...(result.annotations ? { annotations: result.annotations } : {}) }, context: [`answered by codex partner, not user; request ${requestId}; rationale: ${result.rationale}`] };
    } catch (error) {
      if (error.code === 'question_pending') return { deny: modelMessage(error) };
      if (next.signal.aborted) throw error;
      if (requestId) try { await control($, 'cancel', { request_id: requestId,context }); } catch {}
    }
    if((await captureContext($))!==context)return{deny:'origin context changed; old native question canceled'};
    return human($, next, () => next(e),context);
}
                                                                                                                                         
                                                     
export const QUESTION_NOTE = "your q in codex-given task -> AskUserQuestion as usual (mod asks codex first; unresolved -> user)";
export async function questionStart($) { sources.clear();note({p:'reset'});sourceSession=await captureContext($); answerTool = (await $.tool.register(ANSWER_SPEC)).tool; }
export async function questionAppend($, e, result,context) {
      const current=await questionContext($);
      if(context&&current!==context)return;
      if (e.agentId || result?.message?.role !== 'user') return;
      if (!peerOrigin(e.origin)) { if (result.message.content?.some?.(c => c.type === 'text' && messageId(c.text))) note({ p:'append', kind:e.origin?.kind??'none', r:'not_peer' }); return; }
      const text = result.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      const id = messageId(text); if (!id) return;
                                               
      return sources.append(id, result.uuid || e.uuid, text);
}
export function questionTurn(e) { sources.start(e); }
                                           
export function turnSource(agentId,context) { return sourceSession===context&&sources.source(agentId)?sources.current.candidate.evidence:undefined; }
export async function questionComplete($, e,context) { if (!e.agentId) { if (e.isAborted) try { await control($, 'cancel_turn', { turn_id: e.turnId,context }); } catch {} if(sourceSession===context&&(!sources.current||sources.current.turnId===e.turnId))sources.clear(); } }
export function questionReset(){sources.clear();sourceSession=undefined;}
