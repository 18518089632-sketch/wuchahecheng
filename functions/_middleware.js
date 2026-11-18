const enc = new TextEncoder();
const cookieName = '__Host-session';
const ttl = 8 * 3600;
async function key(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET + ':' + env.ACCESS_PASSWORD), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
}
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function sign(value, env) { return hex(await crypto.subtle.sign('HMAC', await key(env), enc.encode(value))); }
async function valid(request, env) {
  const token = (request.headers.get('Cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1) || '';
  const [expires, signature] = token.split('.');
  const now = Math.floor(Date.now()/1000);
  if (!/^\d+$/.test(expires || '') || +expires <= now || +expires > now+ttl || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  return crypto.subtle.verify('HMAC', await key(env), Uint8Array.from(signature.match(/../g), x=>parseInt(x,16)), enc.encode(expires));
}
function reply(body, status=200, extra={}) {
  return new Response(body, {status, headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",...extra}});
}
function login(message='请输入访问密码后继续。', status=200) {
  return reply(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>误差合成 · 登录</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fb;color:#24314b;font-family:system-ui}main{width:min(360px,80vw);padding:36px;background:white;border-radius:20px;box-shadow:0 12px 45px #24314b12}h1{font-size:26px}p{color:#607089;line-height:1.6}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:16px;border:1px solid #ccd3df;border-radius:9px;font-size:16px}button{background:#345be6;color:white;cursor:pointer}</style><main><h1>误差合成</h1><p>${message}</p><form action="/login" method="post"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required autofocus><button>登录</button></form></main></html>`,status);
}
export async function onRequest(context) {
  const {request, env} = context;
  const url = new URL(request.url);
  if (!env.ACCESS_PASSWORD || env.ACCESS_PASSWORD.length<16 || !env.SESSION_SECRET || env.SESSION_SECRET.length<32 || !env.AUTH_DB) return reply('服务尚未配置，请联系管理员。',503);
  if (!['GET','HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) return reply('不允许跨站请求。',403);
  if (url.pathname === '/login') {
    if (request.method === 'GET') return login();
    if (request.method !== 'POST') return reply('Method not allowed',405);
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return reply('无效请求',400);
    // D1 performs an atomic per-IP fixed-window count shared across isolates.
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const id = await sign('login:' + ip, env);
      const window = Math.floor(Date.now()/600000);
      const row = await env.AUTH_DB.prepare('INSERT INTO login_limits (id, window, count) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window RETURNING count').bind(id,window).first();
      if (!row || row.count>10) return login('尝试次数过多，请十分钟后重试。',429);
      context.waitUntil(env.AUTH_DB.prepare('DELETE FROM login_limits WHERE window < ?').bind(window-2).run());
    } catch { return reply('登录服务暂不可用。',503); }
    const text = await request.text();
    if (text.length>2048) return reply('请求过大',413);
    const password = new URLSearchParams(text).get('password') || '';
    const digest = async v=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(v)));
    const a=await digest(password), b=await digest(env.ACCESS_PASSWORD);
    let diff=0; for(let i=0;i<a.length;i++) diff |= a[i]^b[i];
    if(diff) return login('密码不正确，请重试。',401);
    const expires=String(Math.floor(Date.now()/1000)+ttl);
    return reply('',303,{'Location':'/','Set-Cookie':`${cookieName}=${expires}.${await sign(expires,env)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ttl}`});
  }
  if (!await valid(request,env)) {
    if(url.pathname.startsWith('/api/')) return reply(JSON.stringify({error:'请先登录'}),401,{'Content-Type':'application/json'});
    return reply('',303,{'Location':'/login'});
  }
  if (url.pathname === '/logout' && request.method === 'POST') return reply('',303,{'Location':'/login','Set-Cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});
  const upstream = await context.next();
  const response = new Response(upstream.body, upstream);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}
