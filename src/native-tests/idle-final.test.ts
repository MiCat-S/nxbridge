import test from 'node:test';
import { verifyNativeIdleNotice } from './idle-notice-fixture.js';
test('实际 Codex 最终回复明确关联后，跨宽限窗口保持安静',{skip:process.platform!=='win32',timeout:170000},async t=>verifyNativeIdleNotice(t,true));
