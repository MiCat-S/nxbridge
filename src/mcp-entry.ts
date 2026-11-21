import './sqlite-warning.js';
import { serveMcp } from './integration/mcp/server.js';
import {BridgeError,describeError} from './shared/errors.js';
import { modelError } from './integration/mcp/model-error.js';

                                      
const args=process.argv.slice(2),host=args[args.indexOf('--host')+1];
Promise.resolve().then(()=>{
  if(args[0]!=='mcp'||!args.includes('--host')||host!=='claude'&&host!=='codex')throw new BridgeError('invalid_arguments','MCP 入口需要 mcp --host claude 或 codex。');
  return serveMcp(host);
}).catch(error=>{const detail=modelError(error);process.stderr.write(JSON.stringify({code:detail.code,message:describeError(error)})+'\n');process.exitCode=1;});
