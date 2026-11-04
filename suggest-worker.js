/* 灯塔导航页 · Bing 搜索联想代理（Cloudflare Worker）
 *
 * 作用：转发 api.bing.com/osjson.aspx 并补上 CORS 头，
 *       让 GitHub Pages 上的纯静态页直接拿到 Bing 联想（免浏览器跨域限制）。
 *
 * 部署（二选一）：
 *  A. Dashboard：dash.cloudflare.com → Workers & Pages → 创建 Worker →
 *     贴入本文件 → 部署 → 复制地址（形如 https://nav-suggest.你的子域.workers.dev）
 *  B. CLI：npx wrangler deploy suggest-worker.js --name nav-suggest
 *
 * 部署完成后，把 index.html 顶部的 SUGGEST_ENDPOINT 填成 Worker 根地址即可。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Accept-Language'
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...cors
        }
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ s: [] }, 405);

    const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
    if (!q) return json({ s: [] });

    // 按客户端语言推断 Bing 市场，取不到就用 zh-CN
    const al = request.headers.get('Accept-Language') || '';
    const m = /^[a-z]{2}(-[a-z]{2})?/i.exec(al);
    const market = m ? m[0] : 'zh-CN';

    // 边缘缓存 1 小时：同一个词只回源一次
    const cache = caches.default;
    const key = new Request(url.origin + '/?q=' + encodeURIComponent(q) + '&m=' + market);
    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const up = await fetch(
        'https://api.bing.com/osjson.aspx?query=' + encodeURIComponent(q) +
          '&market=' + encodeURIComponent(market),
        { headers: { 'Accept-Language': al || 'zh-CN,zh;q=0.9' } }
      );
      if (!up.ok) return json({ s: [] }, 502);
      const data = await up.json(); // 原生格式 ["词", ["联想1", "联想2", ...]]
      const s = Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
      const res = json({ s });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      return json({ s: [] }, 502);
    }
  }
};
