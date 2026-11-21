                                            
export function loopbackAllowed(values,url){
  if(!['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','all_proxy','ALL_PROXY'].some(key=>values[key]))return true;
  const port=/^http:\/\/127\.0\.0\.1:([0-9]+)\//.exec(url)?.[1];
  return String(values.no_proxy??values.NO_PROXY??'').split(/[\s,]+/).some(rule=>{
    if(rule==='*')return true;
    const [host,onlyPort]=rule.split(':');
    return host==='127.0.0.1'&&(!onlyPort||onlyPort===port);
  });
}
export async function proxyEnvironment($){
                            
  return{http_proxy:await $.env.get('http_proxy'),HTTP_PROXY:await $.env.get('HTTP_PROXY'),https_proxy:await $.env.get('https_proxy'),HTTPS_PROXY:await $.env.get('HTTPS_PROXY'),all_proxy:await $.env.get('all_proxy'),ALL_PROXY:await $.env.get('ALL_PROXY'),no_proxy:await $.env.get('no_proxy'),NO_PROXY:await $.env.get('NO_PROXY')};
}
