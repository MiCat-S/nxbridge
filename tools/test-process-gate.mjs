                                  
import {existsSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const filename=process.env.NXBRIDGE_TEST_START_GATE;
if(filename){
  delete process.env.NXBRIDGE_TEST_START_GATE;
  const deadline=Date.now()+180000;
  while(!existsSync(filename)){if(Date.now()>=deadline)throw Error('监督器未确认测试启动归属');await delay(25);}
  if(JSON.parse(readFileSync(filename,'utf8')).scope!==process.env.NXBRIDGE_TEST_SCOPE)throw Error('测试启动门与隔离范围不符');
}
