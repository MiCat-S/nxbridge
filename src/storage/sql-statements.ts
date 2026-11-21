import type { DatabaseSync, StatementSync } from 'node:sqlite';

const statements=new WeakMap<DatabaseSync,Map<string,StatementSync>>();

                                      
export function statement(db:DatabaseSync,sql:string):StatementSync{
  let cache=statements.get(db);if(!cache){cache=new Map();statements.set(db,cache);}
  const known=cache.get(sql);if(known)return known;
  const prepared=db.prepare(sql);
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(sql,prepared);return prepared;
}
