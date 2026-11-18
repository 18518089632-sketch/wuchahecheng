const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function jsonError(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS)
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env || {};

  if (!env.DEEPSEEK_API_KEY) {
    return jsonError("服务端未配置 DEEPSEEK_API_KEY", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError("请求体不是合法 JSON", 400);
  }

  body.model = env.MODEL || "deepseek-chat";
  body.stream = true;

  let upstream;
  try {
    upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.DEEPSEEK_API_KEY
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return jsonError("无法连接模型服务：" + e.message, 502);
  }

  const headers = new Headers(upstream.headers);
  for (const k in CORS) headers.set(k, CORS[k]);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("Content-Type");
  headers.set("Content-Type", "text/event-stream; charset=utf-8");

  return new Response(upstream.body, { status: upstream.status, headers: headers });
}
