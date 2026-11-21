import type {DatabaseSync} from 'node:sqlite';
import {statement} from '../../storage/sql-statements.js';

export const messageFactColumns='id,pair_id,sender,recipient,state,created_at,updated_at,original_reply_to,in_reply_to,reply_expected';

                                          
export function expectedReplyRows(db:DatabaseSync,pairId:string,peerId:string,since=0,contract?:{at:number;boundary:string[]}):Record<string,unknown>[] {
  if(!contract){
    const row=statement(db,'SELECT value FROM settings WHERE key=?').get('replyContract:'+peerId);
    if(!row)return[];
    contract=JSON.parse(row.value as string) as {at:number;boundary:string[]};
  }
                                                 
  return statement(db,'SELECT '+messageFactColumns+" FROM messages m WHERE pair_id=? AND recipient=? AND reply_expected=1 AND state='contextObserved' AND updated_at>=? AND NOT(updated_at=? AND id IN (SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM messages r WHERE r.pair_id=m.pair_id AND r.sender=m.recipient AND (r.in_reply_to=m.id OR r.original_reply_to=m.id OR r.rowid>m.rowid AND r.created_at>=m.updated_at)) ORDER BY m.rowid DESC LIMIT 3").all(pairId,peerId,Math.max(since,contract.at),contract.at,JSON.stringify(contract.boundary));
}

export function deliveryIssueRows(db:DatabaseSync,pairId:string,recipient:string):Record<string,unknown>[] {
                                          
  return statement(db,'SELECT '+messageFactColumns+" FROM messages WHERE pair_id=? AND recipient=? AND (state IN ('accepted','sending','runtimeQueued','held') OR state IN ('unknown','refused','expired') AND rowid>COALESCE((SELECT MAX(rowid) FROM messages WHERE pair_id=? AND recipient=? AND state IN ('contextObserved','responded')),0)) ORDER BY rowid").all(pairId,recipient,pairId,recipient);
}
