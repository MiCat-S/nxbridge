import {BridgeError,describeError} from '../../shared/errors.js';
import {isEmbeddedWake,type Host} from '../../types.js';
import { modelError, referenceDeny } from '../mcp/model-error.js';
import { codexSessionAnchor, hookTimeoutMessage } from './hook-output.js';

function hookErrorResult(rawHost:string|undefined,input:any,error:unknown):unknown{
  const control=input?.hook_event_name==='UserPromptSubmit'&&!input.agent_id&&!input.agent_transcript_path&&typeof input.prompt==='string'&&/^\s*nxbridge\s+(?:on|off|status)(?:\s+(?:self|codex|claude))?\s*$/.test(input.prompt);
  const result=control?{decision:'block',reason:'nxbridge 命令结果尚未确认：'+describeError(error)}:input?.hook_event_name==='UserPromptSubmit'&&isEmbeddedWake(input.prompt)?{continue:false}:input?.hook_event_name==='PreToolUse'&&typeof input?.tool_input?.message==='string'&&input.tool_input.message.includes('nxref:')?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:referenceDeny(modelError(error).message)}}:{};
  return rawHost==='codex'?codexSessionAnchor(input,result):result;
}

                                    
export async function hookCommand(args:string[],execute:(host:Host,input:any,provided:(ack:()=>Promise<void>)=>void)=>Promise<unknown>):Promise<void>{
  const hostIndex=args.indexOf('--host'),rawHost=hostIndex<0?undefined:args[hostIndex+1];let input:any,written=false,flushed=false,expired=false,exitCode=0,guard:NodeJS.Timeout|undefined,flushGuard:NodeJS.Timeout|undefined;
  const inheritedStart=Number(process.env.NXBRIDGE_HOOK_STARTED_AT),inheritedAge=performance.timeOrigin-inheritedStart,startedAt=Number.isFinite(inheritedStart)&&inheritedAge>=0&&inheritedAge<10000?inheritedStart:performance.timeOrigin;
  const write=(output:string)=>{
    written=true;
    return new Promise<void>((resolve,reject)=>process.stdout.write(output,error=>{flushed=true;if(expired)process.exit(exitCode);if(error)reject(error);else resolve();}));
  };
                                                
  const arm=(limit:number)=>{
    clearTimeout(guard);if(rawHost!=='codex')return;
    guard=setTimeout(()=>{
      expired=true;if(flushed){process.exit(0);return;}
                                                    
      flushGuard=setTimeout(()=>process.exit(exitCode),150);
      if(!written){
        const marker=hookTimeoutMessage(limit===2700?3:10);
        if(input?.hook_event_name==='SessionEnd'){exitCode=1;process.stderr.write(marker+'\n',()=>process.exit(1));return;}
        const error=new BridgeError('timeout','本次 hook 已到总时间上限，结果尚未确认。');
        process.stderr.write('nxbridge hook：'+error.message+'\n');
        void write(JSON.stringify({...hookErrorResult(rawHost,input,error) as object,systemMessage:marker})+'\n').catch(()=>process.exit(0));
      }
    },Math.max(0,limit-(performance.timeOrigin-startedAt)-performance.now()));
  };
  arm(2700);
  try{
    let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>2*1024*1024)throw new BridgeError('input_too_large','输入超过限制。');}input=JSON.parse(data);
    arm(['SessionEnd','Interrupt'].includes(input.hook_event_name)?2700:9400);
    let acknowledge:(()=>Promise<void>)|undefined;
    if(rawHost!=='claude'&&rawHost!=='codex')throw new BridgeError('invalid_arguments','hook 宿主必须为 claude 或 codex。');
    const host=rawHost,value=await execute(host,input,ack=>{acknowledge=ack;});
    if(written)return;
    const result=host==='codex'?codexSessionAnchor(input,value):value;
    await write(JSON.stringify(result,null,2)+'\n');
    try{await acknowledge?.();}catch(error){process.stderr.write('nxbridge 通知回执：'+describeError(error)+'\n');}
  }catch(error){
    process.stderr.write('nxbridge hook：'+describeError(error)+'\n');
    if(!written)await write(JSON.stringify(hookErrorResult(rawHost,input,error),null,2)+'\n');
  }finally{clearTimeout(guard);if(!expired)clearTimeout(flushGuard);}
}
