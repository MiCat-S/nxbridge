                                     
export function startProgress(context,turnId){
  const now=Date.now();
  context.nativeHealth={turnId:turnId??context.sessionId+':'+now,lastProgressAt:now,lastEventAt:now,state:'running',tools:[],source:'native-mod'};
                                                
  context.nativeBackground={observedAt:now};
}
export function progress(context,turnId,kind,toolId,work=true){
  if(!context.nativeHealth)startProgress(context,turnId);
  const value=context.nativeHealth;if(turnId&&value.turnId!==turnId)return;
  const now=Date.now();value.lastEventAt=now;
  if(kind==='tool_start'&&toolId)value.tools=[...new Set([...value.tools,toolId])];
  if(kind==='tool_end'&&toolId)value.tools=value.tools.filter(id=>id!==toolId);
  if(kind==='ready'||kind==='paused'||kind==='failed'){value.state=(kind==='failed'||(value.state==='failed'&&kind!=='paused'))?'failed':'ready';value.completion=kind==='paused'?'interrupted':kind==='failed'?'failed':'completed';value.tools=[];delete value.retry;}
  else if(kind==='human')value.state='needsHuman';
  else if(work){value.lastProgressAt=now;value.observedProgressAt=now;value.state='running';delete value.retry;}
}
export function streamProgress(context,turnId,chunk){
                                                                           
  if((['text','thinking'].includes(chunk?.kind)&&chunk.text?.length)||(chunk?.kind==='input'&&chunk.json?.length)||chunk?.kind==='tool')progress(context,turnId,'progress');
  const event=chunk?.type==='stream_event'?chunk.event:chunk;
  if(chunk?.type==='system'&&chunk.subtype==='api_retry'){
    if(!context.nativeHealth)startProgress(context,turnId);
    const value=context.nativeHealth;if(turnId&&value.turnId!==turnId)return;
    value.lastEventAt=Date.now();value.state='networkRetrying';value.retry={message:'Claude 原生 API 重试',since:value.retry?.since??Date.now()};return;
  }
  if(['content_block_start','content_block_delta','assistant'].includes(event?.type))progress(context,turnId,'progress');
}
