import {BridgeError} from './errors.js';

                                               
export function remainingTime(deadline:number|undefined,limit:number):number{
  const left=deadline===undefined?limit:Math.min(limit,Math.floor(deadline-performance.now()));
  if(left<=0)throw new BridgeError('timeout','本次操作的总时间预算已用完。');
  return left;
}
