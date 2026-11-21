import { z } from 'zod';
import type { Store } from '../../storage/store.js';
import { References } from './references.js';
import {BridgeError} from '../../shared/errors.js';
import {type Peer} from '../../types.js';
import { modelPeerName } from '../../integration/mcp/model-output.js';

export const readMessagesSchema=z.object({message_ids:z.array(z.string().min(1).max(128)).min(1).max(20)}).strict();
export const READ_MESSAGES_TOOL={name:'read_messages',description:"re-read pair msgs by id (read-only; both directions; this member's pairs incl archived); after compact re-read task ids before asking partner to resend",inputSchema:{type:'object' as const,properties:{message_ids:{type:'array',items:{type:'string',minLength:1,maxLength:128},minItems:1,maxItems:20}},required:['message_ids'],additionalProperties:false},annotations:{readOnlyHint:true,openWorldHint:false}};

                                    
export function readMessages(store:Store,peer:Peer,input:unknown){
  const {message_ids}=readMessagesSchema.parse(input),references=new References(store),messages=[],unavailable:string[]=[];
  for(const id of message_ids){
    try{
      const message=store.message(id),pair=store.pairById(message.pairId);
      if(!pair||pair[peer.host]!==peer.id||message.from!==peer.id&&message.to!==peer.id){unavailable.push(id);continue;}
      messages.push({message_id:id,pair_id:pair.id,from:modelPeerName(store.peer(message.from)),to:modelPeerName(store.peer(message.to)),direction:message.from===peer.id?'outgoing':'incoming',message:references.message(message),state:message.state,created_at:new Date(message.createdAt).toISOString(),...(message.inReplyTo?{in_reply_to:message.inReplyTo}:{})});
    }catch(error){
      if(!(error instanceof BridgeError)||!['message_missing','ref_missing'].includes(error.code))throw error;
      unavailable.push(id);
    }
  }
  return{messages,unavailable};
}
