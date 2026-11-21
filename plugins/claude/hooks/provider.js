                                          
                                                   
                                                                     
const clock=at=>new Date(at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'});
function cause(r){
  const code=r.statusCode?`返回 ${r.statusCode}`:'';
  if(r.kind==='auth')return`模型服务拒绝了登录凭据（${code||'认证失败'}）`;
  if(r.kind==='quota')return`模型服务限流或额度不足（${code||'限流'}）`;
  if(r.kind==='timeout')return'模型服务请求超时';
  if(r.kind==='network')return'连不上模型服务';
  if(r.kind==='request')return'模型请求失败';
  if(r.statusCode>=500)return`模型服务暂时不可用（${code}）`;
  return`模型服务拒绝了请求（${code||'请求失败'}）`;
}
                                                                                               
function rejection(error){
  const start=typeof error==='string'?error.indexOf('{'):-1;if(start<0)return;
  let value;try{value=JSON.parse(error.slice(start));}catch{return;}
  const status=Number(value?.status??value?.error?.status);
  if(!Number.isInteger(status)||status<400||status>599)return;
  return{status,message:String(value?.error?.message??value?.message??'')};
}
                                                                                     
const known=rejected=>rejected&&/requires a newer version of Codex/i.test(rejected.message)?`模型服务返回 ${rejected.status}，说当前模型要求更新版本的 Codex；持续出现就需要升级 Codex 或换用其他模型`:undefined;
                                                  
export function failedText(health){
  const r=health?.modelRequest,exhausted=/retry limit|retries exhausted/i.test(health?.error??''),rejected=rejection(health?.error),specific=known(rejected);
  if(specific)return`Codex 这一轮失败：${specific}（运行 nxbridge status 查看）`;
  if(r?.state==='failed'&&typeof r.at==='number')return`Codex 这一轮失败：${cause(r)}${exhausted?'，已重试到上限':''}，最近一次 ${clock(r.at)}（运行 nxbridge status 查看）`;
                                          
  if(rejected)return`Codex 这一轮失败：${cause({kind:rejected.status===429?'quota':[401,403].includes(rejected.status)?'auth':'http',statusCode:rejected.status})}（运行 nxbridge status 查看）`;
  return'Codex 这一轮执行失败（运行 nxbridge status 查看）';
}
export function providerText(health){
  const r=health?.modelRequest;
  if(r?.blocking!==true||typeof r.at!=='number')return;
  const next=r.kind==='auth'?'需要你检查 Codex 的登录或密钥':'等服务恢复，或到供应商那边查看';
  return r.state==='failed'
    ? `Codex 这一轮已停止：${cause(r)}，最近一次 ${clock(r.at)}；${next}`
    : `Codex 在等模型服务：${cause(r)}，正在自动重试，最近一次 ${clock(r.at)}；${next}`;
}
