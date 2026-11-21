import './sqlite-warning.js';
import { hookCommand } from './integration/hooks/hook-command.js';
import { hookClient } from './integration/hooks/hook-client.js';
                                       
await hookCommand(process.argv.slice(3),async(host,input,provided)=>hookClient(host,input,provided,async()=>(await import('./integration/hooks/hook-control.js')).hook(host,input,provided)));
