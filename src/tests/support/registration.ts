import type { Host, RegisterInput } from '../../types.js';

export const codexInitializeResult={userAgent:'codex-tui/0.166.0 (test; test) test (codex-tui; 0.166.0)'};

export function registration(host:Host,id:string,overrides:Partial<RegisterInput>={}):RegisterInput{
  return{host,sessionId:id,cwd:process.cwd(),name:id,kind:'root',permission:'prompting',replyContract:1,endpoint:{mode:host==='codex'?'app-server':'claude-inbox',address:host==='codex'?'unix://test-server':'test-inbox',epoch:id,pid:process.pid,procStart:'test'},...overrides};
}
