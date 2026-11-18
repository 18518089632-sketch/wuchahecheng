function error(message, status) {
  return new Response(JSON.stringify({error:message}), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
export async function onRequestPost({request,env}) {
  // Authentication and same-origin checks run in functions/_middleware.js.
  if (!env.DEEPSEEK_API_KEY) return error('模型服务尚未配置',503);
  let body;
  try {
    const text = await request.text();
    if(text.length>100000) return error('请求过大',413);
    body=JSON.parse(text);
  } catch {return error('无效 JSON',400);}
  if (!body || !Array.isArray(body.messages) || !body.messages.length || body.messages.length>60 || body.messages.some(m=>!m || !['system','user','assistant'].includes(m.role) || typeof m.content!=='string' || m.content.length>30000)) return error('无效消息',400);
  let upstream;
  try {
    upstream=await fetch('https://api.deepseek.com/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.DEEPSEEK_API_KEY},
      body:JSON.stringify({model:env.MODEL || 'deepseek-chat',messages:body.messages.map(({role,content})=>({role,content})),stream:true,temperature:0.3,max_tokens:body.max_tokens===700?700:1800}),
      signal:AbortSignal.timeout(120000)
    });
  } catch {return error('暂时无法连接模型服务',502);}
  if(!upstream.ok) { await upstream.body?.cancel(); return error('模型服务暂不可用，请稍后再试',502); }
  return new Response(upstream.body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'}});
}
