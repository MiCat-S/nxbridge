import type { Peer, RegisterInput } from '../../types.js';

                                          
export function runtimeProfile(previous:Partial<Peer>,input:Pick<RegisterInput,'model'|'effort'>):Pick<Peer,'model'|'effort'>{
  const model=input.model===undefined?previous.model:input.model??undefined;
  const effort=input.effort===undefined?(model===previous.model?previous.effort:undefined):input.effort??undefined;
  return{...(model===undefined?{}:{model}),...(effort===undefined?{}:{effort})};
}
