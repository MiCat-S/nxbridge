import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import {BridgeError} from '../shared/errors.js';

                                              
export function proxySocket(child:ChildProcess){
  const output=child.stdout! as Socket,stream=Duplex.from({readable:output,writable:child.stdin!}) as Duplex&{
    setNoDelay:()=>Duplex;setKeepAlive:()=>Duplex;setTimeout:(timeout:number,callback?:()=>void)=>Duplex;
  };
                                         
  stream.setNoDelay=stream.setKeepAlive=()=>stream;
  stream.setTimeout=(timeout,callback)=>{
    output.setTimeout(timeout);
    if(callback){if(timeout===0)stream.removeListener('timeout',callback);else stream.once('timeout',callback);}
    return stream;
  };
  output.on('timeout',()=>stream.emit('timeout'));
  child.once('error',error=>stream.destroy(error));
                                       
  child.once('exit',()=>stream.destroy(new BridgeError('proxy_closed','App Server proxy 已退出。')));
  return stream;
}
