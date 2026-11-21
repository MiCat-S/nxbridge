import './sqlite-warning.js';
import { mod } from './integration/mod/mod-control.js';
import { modelError } from './integration/mcp/model-error.js';
import {describeError} from './shared/errors.js';
import { modInput } from './integration/mod/mod-protocol.js';

                                       
Promise.resolve().then(async()=>{
  const result=await mod(await modInput(process.argv[3]));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}).catch(error=>{
  const detail=modelError(error);
  process.stderr.write(JSON.stringify({code:detail.code,message:describeError(error),model_message:detail.message,...(typeof detail.uncertain==='boolean'?{uncertain:detail.uncertain}:{})})+'\n');process.exitCode=1;
});
