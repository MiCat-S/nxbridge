import type { ServerResponse } from 'node:http';

                                          
export async function holdModelStream(response:ServerResponse,milliseconds:number):Promise<boolean>{
  if(response.destroyed)return false;
  await new Promise<void>(resolve=>{
    const timer=setTimeout(finish,milliseconds),heartbeat=setInterval(()=>response.write(': keepalive\n\n'),5000);
    function finish(){clearTimeout(timer);clearInterval(heartbeat);response.off('close',finish);resolve();}
    response.once('close',finish);
  });
  return !response.destroyed;
}
