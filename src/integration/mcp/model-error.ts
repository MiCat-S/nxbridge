import {BridgeError,DeliveryError} from '../../shared/errors.js';
import { storageError, type StoragePhase } from '../../storage/storage-errors.js';

                                           
export const errors:Record<string,string>={
  shared_runtime:'runtime also hosts another Codex root session; restart refused; nothing stopped; tell user',
  subagent_active:'own subagent thread(s) still running on this runtime; restart refused; nothing stopped; retry once after they finish; no loop',
  storage_busy:'nxbridge storage busy; retry only when uncertain=false and phase=prepare|enqueue; otherwise check delivery before retry',
  member_disabled:'nxbridge is off for this member; nothing sent or started; pair + queued msgs kept. Human re-enables from either window: Claude /nxbridge on <host>, Codex nxbridge on <host>; independent terminal nxbridge on <host> --member <id>',
  member_enable_human_required:'only human input can enable either side: Claude /nxbridge on [codex|claude|self], Codex nxbridge on [codex|claude|self], or independent terminal nxbridge on <host> --member <id>',
  unregistered:'session not registered',unverified_identity:'cant verify root/fork/subagent identity; human: attach native app-server or trusted hooks',
  pair_lost:'former pair ended; no new partner started; inspect status for restore command or explicitly choose a new partner',pair_restore_unavailable:'original session history missing or changed; no new session created; inspect status/config home, or explicitly choose a new partner',
                                                                              
  subagent_denied:'root-session-only op (cfg subagent_send=deny may also apply); nothing done; if subagent -> report to parent',unverified_parent:'subagent parent chain unverified',not_current_partner:'nothing sent: several unpaired windows here; ask user which; commit only explicit choice via select_partner; never choose yourself',
  ambiguous_partner:'nothing sent: several unpaired windows here; ask user which; commit only explicit choice via select_partner; never choose yourself',partner_missing:'no partner; implicit start disabled',unpaired:'this window not paired',
  selection_required:'nothing sent: existing unpaired window(s) require user confirmation, even a single candidate; show candidates + delivery limits; commit only explicit user choice via select_partner (selection_id + key); never choose yourself',
  selection_expired:'selection expired/changed; nothing sent; resend for fresh choices',selection_declined:'nothing sent: user declined; dont resend unless user asks',
  bootstrap_required:'nothing sent/started: AI may run `nxbridge bootstrap`; it proves independent launch before handover. if refused, tell user: open normal PowerShell outside Claude/Codex, run `nxbridge bootstrap`, then resend',
  lineage_unverified:'held: this window has an earlier partner whose state cant be verified yet; nxbridge retries, msg kept; still unverified -> user picks via nxbridge pair',
  lineage_choice:'nothing sent: this conversation still runs in another window paired with your earlier partner (or several match); no new partner started. tell user to pick via nxbridge pair, or close the other window',
  stale_context:'native context changed; old callback rejected; use current conversation',obsolete_form:'native form obsolete; old answer/cancel rejected; pending q kept in current context',
  ambiguous_context:'same history in several windows; reload plugin for verified window identity',pair_selector_required:'several pairs; human must select pair/member/session explicitly',
  plugin_unavailable:'partner plugin unavailable',unknown_turn_source:'task origin not verified as current codex partner',
  not_uncertain:'only unknown delivery can be retried',session_changed:'session changed; retry once; repeats -> tell user',receipt_target:'receipt target mismatch',
  unknown_method:'unsupported operation',starting:'broker starting; retry',broker_timeout:'broker connect timeout',uninstalled:'nxbridge uninstalled; human re-enables via nxbridge setup',
  broker_start_failed:'broker start failed; log: ~/.nxbridge/run/broker.log',already_running:'broker already running',invalid_socket:'invalid broker socket',
  invalid_arguments:'invalid args',token_missing:'auth token env missing',partner_starting:'partner not ready',embedded_active:'embedded session active; release before remote resume',
  inbox_unavailable:'claude inbox unavailable',unknown_tool:'unknown partner tool',invalid_inbox:'invalid claude inbox',stale_session:'stale session process',
  claude_identity_missing:'claude process identity unavailable',offline:'partner offline',stale_endpoint:'stale endpoint; re-register',peer_key_mismatch:'peer key/process mismatch',
  inbox_preflight:'inbox preflight failed',inbox_timeout:'inbox timeout',inbox_write:'inbox write failed',
  inbox_error:'inbox connect failed',inbox_closed:'inbox closed; check auth/policy before retry',ambiguous_implicit:'multiple background sessions; human must select',
  claude_start_pending:'claude start pending; check cwd trust/plugin',ambiguous_background:'background handle not unique',ambiguous_endpoint:'multiple live endpoints; human must select',
  claude_background_unavailable:'claude launcher cannot control bg sessions; human: open claude normally in same cwd; queued msgs kept, delivered after registration',
  resume_identity_mismatch:'resume identity mismatch; keep pair, check duplicate session',invalid_endpoint:'endpoint must be unix:// or ws(s)://',
  app_server_start_failed:'app-server start failed; see codex log',invalid_config:'invalid nxbridge config',identity_unavailable:'OS identity unavailable',
  cli_shim:'use native binary or JS entry, not shell shim',cli_missing:'native CLI missing',process_missing:'session process exited',codex_process_missing:'codex process identity unavailable',
  input_too_large:'input too large',disconnected:'connection lost; check delivery before retry',timeout:'confirmation timeout; check delivery before retry',
  idempotency_conflict:'same call id has different input',paused:'pair paused',question_pending:'q already pending in pair (max 1): yours -> wait for result; partner\'s -> answer_question or escalate, no counter-ask',
  ambiguous_questions:'question ids/text must be unique',not_question_party:'not a question party',not_question_respondent:'only respondent can answer',
  question_expired:'q ended or pair changed/paused; no late answers',question_mismatch:'question echo differs from saved snapshot',invalid_upgrade:'invalid escalation: omit answers; codex answering -> needs_user + rationale; claude answering codex q -> ask_user',
  awaiting_user:'native user answer pending; dont answer or reopen',invalid_answer:'all answers + rationale required',invalid_source:'user answer requires active native escalation',
  incomplete_answer:'answer every question, no extras',invalid_choice:'answer must be exact listed option label',question_missing:'question not found',peer_missing:'session not found',
  peer_already_paired:'session already paired',invalid_pair:'pair independent claude/codex roots only',pair_exists:'pair exists; human must explicitly replace',
  invalid_message:'msg empty or >256 KiB; long content -> summary + file refs',invalid_reply:'in_reply_to must be id of a msg current partner sent you',message_missing:'msg not found',
  ref_invalid:'invalid nxref; need standalone nxref:msg:<id> or nxref:agent:<id>; literal syntax -> wrap in backticks or quotes',ref_missing:'nxref not found: msg must be in current pair; agent must be own finished subagent (id, not name)',ref_cycle:'cyclic nxref',ref_too_large:'expanded text exceeds 256 KiB',
  agent_incomplete:'subagent final answer unavailable',
  pair_changing:'pair switching/closing; retry after it settles',peer_releasing:'this session is being unpaired + its bg processes released; wait',
  claude_launch_unverified:'bg claude launch unverifiable; nothing adopted/stopped; human: nxbridge doctor / nxbridge pair',claude_release_pending:'bg claude launch result unconfirmed; release retried later',
  host_update_unverified:'running host has an update-renamed image, but the current executable in the same directory is missing; tell user to reopen the original session at a safe point; plugin reload cannot fix host identity',
  native_identity_unavailable:'Windows native identity helper unavailable; inspect nxbridge doctor in the originating window',
  process_owned_by_user:'session handed to user window; nxbridge wont restore/stop it',process_identity_unknown:'native process identity could not be verified; operation unconfirmed; inspect nxbridge doctor in the originating window',process_record_changed:'ownership record changed/unverifiable; nothing stopped',
};
export const MODEL_ERROR_FALLBACK='call failed (unmapped nxbridge error); tell user (originating window)';
export const referenceDeny=(reason:string)=>`nxref not expanded: ${reason}; fix ref or inline text`;

export function modelError(error:unknown):{code:string;message:string;uncertain?:boolean;phase?:StoragePhase;operation?:string;sqliteCode?:number;enable_command?:string}{
  error=storageError(error,'sqlite');
  const detail=error as {code?:unknown;message?:unknown;uncertain?:boolean;phase?:StoragePhase;operation?:string;sqliteCode?:number;enable_command?:unknown;issues?:{path:unknown[];message:string}[]};
  const code=error instanceof BridgeError?error.code:typeof detail?.code==='string'?detail.code:detail?.issues?'invalid_arguments':'tool_error';
  const enable_command=code==='member_disabled'&&typeof detail.enable_command==='string'?detail.enable_command:undefined;
  const message=detail?.issues?'invalid args: '+detail.issues.map(i=>`${i.path.join('.')||'$'}: ${i.message.replace(/\s+/g,' ')}`).join('; '):['disconnected','timeout'].includes(code)?
    `${code==='disconnected'?'connection lost':'confirmation timeout'}; ${detail?.uncertain===true?'outcome unknown, may have applied; resend may duplicate':'no unconfirmed write; retry ok'}`:enable_command?`nxbridge is off for this member; nothing sent or started; pair + queued msgs kept; human re-enables in an independent terminal: ${enable_command}`:code==='process_identity_unknown'&&typeof detail.message==='string'?errors[code]+'; '+detail.message:errors[code]??MODEL_ERROR_FALLBACK;
  return{code,message,...(enable_command?{enable_command}:{}),...(code==='storage_busy'?{uncertain:detail.uncertain!==false}:error instanceof DeliveryError||typeof detail?.uncertain==='boolean'?{uncertain:detail.uncertain===true}:{}),...(detail.phase?{phase:detail.phase}:{}),...(detail.operation?{operation:detail.operation}:{}),...(detail.sqliteCode===undefined?{}:{sqliteCode:detail.sqliteCode})};
}
