import test from 'node:test';
import assert from 'node:assert/strict';
import {codexComposerReady} from '../native-tests/portable-terminal-fixture.js';

const footer='model-name low',banner='OpenAI Codex';

test('新会话的临时标题和提示框不能当作可提交输入的证据',()=>{
  assert.equal(codexComposerReady(banner+'\nAsk Codex to do anything',footer),false);
  assert.equal(codexComposerReady(footer+'\n'+banner+'\nAsk Codex to do anything',footer),false);
});

test('最新欢迎标题后出现配置状态栏才允许提交，忽略终端样式控制码',()=>{
  assert.equal(codexComposerReady('\x1b[1m'+banner+'\x1b[0m\n'+footer,footer),true);
  assert.equal(codexComposerReady(banner+'\n'+footer+'\n'+banner,footer),false);
});
