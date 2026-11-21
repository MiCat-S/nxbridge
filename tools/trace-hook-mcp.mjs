                                      
import {appendFileSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {codexProcessIdentity} from '../dist/process/process.js';
const log=process.env.NXBRIDGE_PROFILE_LOG,pending=new Map();
writeFileSync(log+'.native',JSON.stringify(await codexProcessIdentity()),'utf8');
let incoming='',outgoing='';
const emit=process.stdin.emit;
process.stdin.emit=function(event,...args){if(event==='data'){incoming+=String(args[0]);let end;while((end=incoming.indexOf('\n'))>=0){const raw=incoming.slice(0,end);incoming=incoming.slice(end+1);try{const message=JSON.parse(raw);if(message.method==='tools/call')pending.set(message.id,{params:message.params,began:performance.now()});}catch{}}}return emit.call(this,event,...args);};
const write=process.stdout.write;
process.stdout.write=function(chunk,...args){outgoing+=String(chunk);let end;while((end=outgoing.indexOf('\n'))>=0){const raw=outgoing.slice(0,end);outgoing=outgoing.slice(end+1);try{const message=JSON.parse(raw),call=pending.get(message.id);if(call){pending.delete(message.id);let output;try{output=JSON.parse(message.result?.content?.[0]?.text??'{}');}catch{}appendFileSync(log,JSON.stringify({params:call.params,pid:process.pid,businessMs:performance.now()-call.began,output,...(message.result?.isError?{error:JSON.stringify(output)}:{})})+'\n','utf8');}}catch{}}return write.call(this,chunk,...args);};
await import(existsSync(log+'.entry')?readFileSync(log+'.entry','utf8'):process.env.NXBRIDGE_PROFILE_MCP_ENTRY??'../publish/mcp-entry.mjs');
