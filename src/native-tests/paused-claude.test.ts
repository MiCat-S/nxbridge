import { overrideEnvironment } from '../tests/support/environment.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { temporaryDirectory } from '../tests/support/temporary.js';
import { setupPublish } from './publish-fixture.js';
import { NativeTerminal } from './terminal-fixture.js';
import { brokerCall } from '../ipc/ipc.js';
import {DEFAULT_CONFIG} from '../config/defaults.js';
import {resolveCli} from '../process/host-command.js';
import {delay} from '../shared/time.js';

test('前台 Claude：新提示中断旧轮次后恢复，单独中断保持暂停，下一次用户输入恢复', { skip: process.platform !== 'win32', timeout: 170000 }, async t => {
  const temp = temporaryDirectory(), root = temp.directory, home = path.join(root, 'bridge'), claudehome = path.join(root, 'claude'), codexhome = path.join(root, 'codex');
  for (const directory of [home, claudehome, codexhome]) mkdirSync(directory, { recursive: true });
                                           
  const overlay = path.join(root, 'observer'), eventsFile = path.join(root, 'events.json');
  mkdirSync(path.join(overlay, '.claude-plugin'), { recursive: true }); mkdirSync(path.join(overlay, 'hooks'));
  mkdirSync(path.join(overlay, 'commands')); writeFileSync(path.join(overlay, 'commands/resume.md'), '---\ndescription: 核验忙时原生命令恢复\n---\nPAUSE_RENDERED_COMMAND_BODY\n');
  writeFileSync(path.join(overlay, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'nxbridge-pause-observer', version: '0.0.1' }));
  writeFileSync(path.join(overlay, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }));
  const recorders = ['prompt.submit', 'turn.start', 'turn.complete'].map(event => `on(${JSON.stringify(event)},async($,e,next)=>{events.push({event:${JSON.stringify(event)},stage:'begin',at:Date.now(),turnId:e.turnId,text:e.text,isAborted:e.isAborted,agentId:e.agentId});const result=await next(e);events.push({event:${JSON.stringify(event)},stage:'end',at:Date.now(),turnId:e.turnId,text:e.text});await $.fs.write(${JSON.stringify(eventsFile)},JSON.stringify(events));return result;});`).join('');
  writeFileSync(path.join(overlay, 'hooks/register.js'), 'const events=[];export function register(on){' + recorders + '}');
  let hold = true, held = 0, done = 0, terminal: NativeTerminal | undefined, passed = false;
  const errors: string[] = [], states: { stage: string; state: string | undefined }[] = [];
  const model = http.createServer(async (req, res) => { try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1,"data":[]}'); return; }
    const body = JSON.parse(raw), main = body.tools?.some((tool: any) => tool.name === 'ListAgents');
    const message = { id: 'pause-' + Date.now(), type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: any) => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: main && hold ? '正在等待' : '完成' } });
    if (main && hold) { held++; return; }
    if (main) done++;
    for (const event of [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]) emit(event);
    res.end();
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(String(error)); } });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const env = { NXBRIDGE_HOME: home, CLAUDE_CONFIG_DIR: claudehome, CODEX_HOME: codexhome, ANTHROPIC_API_KEY: 'pause-local-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(model.address() as any).port}`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const restoreEnvironment=overrideEnvironment(env);
  const peer = async () => (await brokerCall<any>('status', {}, { home })).peers.find((value: any) => value.host === 'claude' && value.kind === 'root');
  t.after(async () => { try {
    if (!passed) t.diagnostic(JSON.stringify({ held, done, states, state: await peer().catch(() => undefined), events: existsSync(eventsFile) && JSON.parse(readFileSync(eventsFile, 'utf8')), errors, terminalOutputLength: terminal?.output.length, terminal: terminal?.output.slice(-3000) }));
    await terminal?.close(); await temp.cleanup();
  } finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); restoreEnvironment(); } });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, implicit: 'never', compatibilityWake: 'strict', claudeHome: claudehome, codexHome: codexhome }));
  writeFileSync(path.join(codexhome, 'config.toml'), 'web_search="disabled"\n[features]\napps=false\nremote_plugin=false\n');
  writeFileSync(path.join(claudehome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] }, projects: { [root.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }));
  writeFileSync(path.join(claudehome, 'settings.json'), JSON.stringify({ crossSessionInbound: 'accept', env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }));
  await setupPublish(); const cli = resolveCli('claude');
  terminal = await NativeTerminal.start(root, home, cli.command, [...cli.prefix, '--model', 'claude-sonnet-4-6', '--plugin-dir', overlay], root, { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const queuedPrompt=async(value:string)=>{
    const since=Date.now();terminal!.send(value);await delay(600);terminal!.send('\r');
                                                    
    await terminal!.wait(()=>{
      let events:any[];
      try{events=JSON.parse(readFileSync(eventsFile,'utf8'));}catch(error){
                                        
        if(error instanceof SyntaxError||(error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;
      }
      return events.some(event=>event.event==='prompt.submit'&&event.stage==='end'&&event.at>=since&&event.text?.includes(value));
    },'原生排队提示未提交：'+value,15000);
  };
  await terminal.prompt('PAUSE_OLD_TURN'); await terminal.wait(() => held > 0, '首轮未开始', 35000);
  hold = false; await queuedPrompt('PAUSE_QUEUE_ONE'); await queuedPrompt('PAUSE_NEW_USER_PROMPT'); await delay(150); terminal.send('\u0018\u0013');
  await terminal.wait(async () => done > 0 && (await peer())?.state === 'ready', '新用户轮次完成后仍显示中断暂停', 25000);
  states.push({ stage: 'interrupt-submit', state: (await peer())?.state });
  const events = JSON.parse(readFileSync(eventsFile, 'utf8'));
  const aborted = events.find((e: any) => e.event === 'turn.complete' && e.stage === 'begin' && e.isAborted);
  const submitted = events.find((e: any) => e.event === 'prompt.submit' && e.stage === 'end' && e.turnId === aborted?.turnId && e.text?.includes('PAUSE_NEW_USER_PROMPT'));
  const started = events.find((e: any) => e.event === 'turn.start' && e.stage === 'begin' && e.turnId !== aborted?.turnId);
  assert.ok(aborted && submitted && started && submitted.at <= aborted.at && aborted.at <= started.at, '未覆盖提交先于旧轮中断、新轮随后开始的竞态');
                                       
  hold = true; await terminal.prompt('PAUSE_BEFORE_COMMAND'); await terminal.wait(() => held > 1, '命令前等待未开始', 15000);
  hold = false; terminal.send('/nxbridge-pause-observer:resume'); await delay(150); terminal.send('\u0018\u0013');
  await terminal.wait(async () => done > 1 && (await peer())?.state === 'ready', '忙时原生命令未恢复暂停', 15000);
  states.push({ stage: 'command-resume', state: (await peer())?.state });
                                    
  hold = true; await terminal.prompt('PAUSE_WITHOUT_NEW_PROMPT'); await terminal.wait(() => held > 2, '第二次等待未开始', 15000);
  terminal.send('\u001b'); await terminal.wait(async () => (await peer())?.state === 'paused', '单独中断没有暂停', 15000);
  states.push({ stage: 'interrupt-only', state: (await peer())?.state });
  hold = false; await terminal.prompt('PAUSE_IDLE_RESUME');
  await terminal.wait(async () => done > 2 && (await peer())?.state === 'ready', '空闲处用户输入没有恢复', 15000);
  states.push({ stage: 'idle-resume', state: (await peer())?.state });
  assert.deepEqual(errors, []); passed = true;
  t.diagnostic(JSON.stringify({ states, ordering: { submit: submitted.at, abort: aborted.at, start: started.at } }));
});
