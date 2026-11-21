import test from 'node:test';
import { verifyNativeIdleNotice } from './idle-notice-fixture.js';

test('原生被动提醒只跟进明确待回复任务，broker 重启及十分钟限频到期仍保持同段工作静默',{skip:process.platform!=='win32',timeout:170000},async t=>{
  try{await verifyNativeIdleNotice(t,false,true);}catch(error){console.error(error);throw error;}
});
