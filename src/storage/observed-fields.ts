export interface FieldObservation<T extends object> {value:T;source:string;context:string;observedAt:number}

                                            
export function mergeObservedFields<T extends object>(previous:FieldObservation<T>|undefined,incoming:Partial<T>,metadata:Omit<FieldObservation<T>,'value'>,dependencies:readonly (readonly [keyof T,keyof T])[]=[]):FieldObservation<T>|undefined{
  const current=previous?.context===metadata.context?previous:undefined;
  if(current&&metadata.observedAt<current.observedAt)return current;
  const entries=Object.entries(incoming).filter(([,value])=>value!==undefined);
  if(!entries.length)return current;
  const value={...current?.value} as T;
  for(const [parent,dependent]of dependencies)if(incoming[parent]!==undefined&&incoming[parent]!==value[parent]&&incoming[dependent]===undefined)delete value[dependent];
  Object.assign(value,Object.fromEntries(entries));
  return{value,...metadata};
}
