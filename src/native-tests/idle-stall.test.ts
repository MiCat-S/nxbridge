import test from 'node:test';
import { verifyNativeIdleNotice } from './idle-notice-fixture.js';
test('实际 Codex 空闲待回复，提醒不自行唤醒并进入 Claude 正常下一轮',{skip:process.platform!=='win32',timeout:170000},async t=>verifyNativeIdleNotice(t,false));
