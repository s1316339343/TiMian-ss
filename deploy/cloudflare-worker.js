/**
 * 可选的 Cloudflare Worker 代理
 * ---------------------------------------------------------------------------
 * 很多 AI 官方接口（DeepSeek、OpenAI 等）不允许浏览器直接跨域调用。
 * 把这个 Worker 部署到 Cloudflare（免费额度足够个人使用），就能让静态站点
 * 通过代理调用它们，同时把 API Key 留在服务端，不暴露到浏览器。
 *
 * 部署步骤：
 *   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker；
 *   2. 把本文件内容粘贴进去并部署；
 *   3. 在 Worker 的 Settings → Variables 里配置：
 *        UPSTREAM_ORIGIN = https://api.deepseek.com   （不要带结尾斜杠和 /v1）
 *        UPSTREAM_API_KEY = sk-xxxx                   （可选，填了就不用在网页里填 Key）
 *        ALLOWED_ORIGIN  = https://你的用户名.github.io
 *   4. 在「题面」的管理后台 → AI 接口设置中：
 *        Base URL = https://<你的-worker>.workers.dev/v1
 *        API Key  = proxy （Worker 已注入真实 Key 时随便填一个非空值即可）
 *
 * 代理阿里云百炼（DashScope）时：
 *        UPSTREAM_ORIGIN = https://dashscope.aliyuncs.com
 *        Base URL        = https://<你的-worker>.workers.dev/compatible-mode/v1
 *        API Key         = proxy
 *
 * 注意：ALLOWED_ORIGIN 可以用逗号分隔多个来源，例如
 *   https://name.github.io,http://localhost:5173
 */

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get('Origin') || '';
    const allowedList = String(env.ALLOWED_ORIGIN || '*')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const allowOrigin = allowedList.includes('*')
      ? '*'
      : allowedList.includes(requestOrigin)
        ? requestOrigin
        : allowedList[0] || '';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const requestUrl = new URL(request.url);
    const upstreamOrigin = String(env.UPSTREAM_ORIGIN || 'https://api.deepseek.com').replace(/\/+$/, '');
    const targetUrl = upstreamOrigin + requestUrl.pathname + requestUrl.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');
    if (env.UPSTREAM_API_KEY) {
      headers.set('Authorization', `Bearer ${env.UPSTREAM_API_KEY}`);
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: { message: `代理请求失败：${error instanceof Error ? error.message : String(error)}` },
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        },
      );
    }
  },
};
