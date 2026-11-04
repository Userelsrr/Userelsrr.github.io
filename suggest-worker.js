/**
 * 搜索联想转发 · Cloudflare Worker
 *
 * 存在的理由：Bing 的 https://api.bing.com/osjson.aspx 不返回
 * Access-Control-Allow-Origin，浏览器里 fetch 和 <script> 注入都拿不到数据
 * （callback / cb 参数均被忽略，HPImageArchive 现在还会被 Chrome ORB 拦截）。
 * 服务端转发不受 CORS 限制，由本 Worker 补上响应头即可。
 *
 * 部署（二选一）
 *   A. Cloudflare 仪表盘 → Workers & Pages → Create → Paste code → Deploy
 *   B. 本地：npx wrangler deploy suggest-worker.js --name suggest
 *      （需先 npx wrangler login）
 *
 * 部署完把地址填进 index.html 的 SUGGEST_ENDPOINT，例如：
 *   var SUGGEST_ENDPOINT='https://suggest.YOUR_SUBDOMAIN.workers.dev';
 * 留空则前端只用本地联想（历史 + 站内直达），不发任何外部请求。
 */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 预检：跨域必需
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(req),
      });
    }

    if (url.pathname !== '/' && url.pathname !== '/suggest') {
      return json({ s: [], error: 'not found' }, 404, req);
    }

    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json({ s: [] }, 200, req);

    // 复用 Cloudflare 的边缘缓存：同词同市场 1 小时
    const cache = caches.default;
    const key = new Request(
      'https://suggest-cache.internal/' + encodeURIComponent(q) + '/' + market(req),
      { method: 'GET' }
    );
    const hit = await cache.match(key);
    if (hit) return withCors(hit, req);

    let list = [];
    try {
      const upstream =
        'https://api.bing.com/osjson.aspx?query=' +
        encodeURIComponent(q) +
        '&Market=' +
        market(req);

      const res = await fetch(upstream, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
      });

      if (res.ok) {
        // Bing 返回 ["输入", ["建议1", "建议2", ...]]
        const data = await res.json();
        if (Array.isArray(data) && Array.isArray(data[1])) list = data[1].slice(0, 8);
      }
    } catch (e) {
      // 上游失败时回空数组，前端自动退回本地联想
      list = [];
    }

    const body = json({ s: list }, 200, req);
    // 写入边缘缓存（无 Cache-Control 的响应不会被存，所以这里显式给）
    if (list.length) {
      const forCache = new Response(body.body, body);
      forCache.headers.set('Cache-Control', 'public, max-age=3600');
      ctx_waitUntil(cache.put(key, forCache.clone()));
    }
    return body;
  },
};

/* 按 Accept-Language 推断市场，拿不到就用 zh-CN */
function market(req) {
  const al = (req.headers.get('Accept-Language') || '').toLowerCase();
  if (al.startsWith('en')) return 'en-US';
  if (al.startsWith('ja')) return 'ja-JP';
  if (al.startsWith('zh-tw') || al.startsWith('zh-hk')) return 'zh-TW';
  return 'zh-CN';
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Language',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function withCors(res, req) {
  const clone = new Response(res.body, res);
  Object.assign(clone.headers, corsHeaders(req));
  return clone;
}

/* 缓存写入需要 ExecutionContext；模块 Worker 里通过全局获取 */
function ctx_waitUntil(p) {
  try {
    globalThis.__ctx && globalThis.__ctx.waitUntil(p);
  } catch (e) {
    /* 缓存失败不影响响应 */
  }
}
