#!/usr/bin/env node
import './sqlite-warning.js';
import {VERSION} from './version.js';
import {describeError} from './shared/errors.js';
import {HELP_INTRO,HELP_BODY} from './app/help.js';

async function main():Promise<void>{
  const [command,...args]=process.argv.slice(2);
  if(!command||command==='--help'||command==='help'){process.stdout.write(HELP_INTRO+HELP_BODY);return;}
  if(command==='--version'||command==='-V'){process.stdout.write(`nxbridge ${VERSION}\n`);return;}
  const {dispatchCommand}=await import('./app/dispatch.js');
  await dispatchCommand(command,args);
}

main().catch(async error=>{const {modelError}=await import('./integration/mcp/model-error.js');const detail=modelError(error);process.stderr.write(JSON.stringify({code:detail.code,message:describeError(error),...(['mod','question-control'].includes(process.argv[2]!)?{model_message:detail.message}:{}),...(typeof detail.uncertain==='boolean'?{uncertain:detail.uncertain}:{}),...(detail.phase?{phase:detail.phase}:{}),...(detail.operation?{operation:detail.operation}:{}),...(detail.sqliteCode===undefined?{}:{sqliteCode:detail.sqliteCode})})+'\n');process.exitCode=1;});
