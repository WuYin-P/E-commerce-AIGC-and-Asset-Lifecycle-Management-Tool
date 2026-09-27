import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore, category, required, id, now, fail } from './store.mjs';
import { createJobs, sizes } from './provider.mjs';
import { imageOptions } from './image-options.mjs';
import { normalizeCustom, limits, validateDashscopeUrl } from './interface-config.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || path.join(root, 'data'));
const configPath = path.join(dataDir, 'api-settings.json');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
let settings = { baseUrl: '', apiKey: '', model: '' };
try { settings = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (settings.provider === 'aliyun') settings.provider = 'dashscope';
const store = await createStore(dataDir);
const jobs = createJobs(store, () => settings);
let lastCategory = 'model';
const downloads = new Map();
const publicSettings = () => ({ baseUrl: settings.baseUrl, model: settings.model, hasApiKey: Boolean(settings.apiKey), provider: settings.provider || 'openai', name: settings.name || '', custom: settings.custom });
function configuration(input) {
  let url;
  try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw fail('请输入有效的 API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('请填写 HTTP 或 HTTPS 地址，不包含账号、查询参数或锚点。');
  const baseUrl = url.href.replace(/\/+$/, '');
  const provider = input.provider || 'openai';
  if (!['openai', 'dashscope', 'custom'].includes(provider)) throw fail('请选择有效的服务类型。');
  if (provider === 'dashscope') validateDashscopeUrl(baseUrl);
  return { provider, name: String(input.name || '').trim().slice(0, 80), baseUrl, apiKey: String(input.apiKey || '').trim() || (baseUrl === settings.baseUrl && provider === (settings.provider || 'openai') ? settings.apiKey : ''), model: String(input.model || '').trim(), ...(provider === 'custom' ? { custom: normalizeCustom(input.custom) } : {}) };
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 JSON 请求。', 415);
  const chunks = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > 36 * 1024 * 1024) throw fail('上传图片超过大小限制。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail('请求格式无效。'); }
}
async function testSettings(candidate) {
  if (candidate.provider === 'custom' || candidate.provider === 'dashscope') {
    required(candidate.model, '图片模型');
    return { ok: true, models: [], localOnly: true, message: candidate.provider === 'dashscope' ? 'DashScope 原生配置格式检查通过，未读取模型列表。真实出图请在创作页测试。' : '配置格式检查通过，未联网或生成图片。真实出图请在创作页测试。' };
  }
  try {
    const response = await fetch(`${candidate.baseUrl}/models`, { headers: candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) {
      const errors = { 401: '认证失败，请检查 API Key。', 403: '服务拒绝访问，请检查密钥权限。', 404: '服务未提供模型列表，可手动填写模型后保存。', 429: '服务请求过于频繁或额度不足，请稍后重试。' };
      return { ok: false, message: errors[response.status] || `服务返回 HTTP ${response.status}。` };
    }
    const payload = await response.json();
    if (!Array.isArray(payload.data)) return { ok: false, message: '模型列表格式不兼容，请手动填写模型。' };
    return { ok: true, models: [...new Set(payload.data.map(item => item?.id).filter(value => typeof value === 'string' && value.length))] };
  } catch (error) { return { ok: false, message: error.name === 'TimeoutError' ? '连接超时，请检查服务是否可访问。' : '无法读取模型列表，请检查地址、网络和服务协议。' }; }
}
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/studio.css': ['studio.css', 'text/css'] };
staticFiles['/lucide.js'] = ['node_modules/lucide/dist/umd/lucide.min.js', 'text/javascript'];
staticFiles['/interface-config.js'] = ['interface-config.js', 'text/javascript'];
staticFiles['/settings.css'] = ['settings.css', 'text/css'];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
    if (req.method === 'GET' && staticFiles[route]) {
      const [file, mime] = staticFiles[route];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(path.join(root, file)));
    }
    if (req.method === 'GET' && route.startsWith('/media/')) {
      const asset = store.get('assets', route.slice(7));
      const thumb = url.searchParams.has('thumb');
      const bytes = await readFile(path.join(dataDir, thumb ? asset.thumbFile : asset.file));
      const headers = { 'Content-Type': thumb ? 'image/webp' : asset.mime, 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' };
      if (url.searchParams.has('download')) {
        const title = asset.threadId ? store.get('threads', asset.threadId).name : asset.name;
        const date = new Date(asset.createdAt); const pad = value => String(value).padStart(2, '0');
        const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
        const basename = `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80)}-${stamp}`;
        const n = (downloads.get(basename) || 0) + 1; downloads.set(basename, n);
        headers['Content-Disposition'] = `attachment; filename="image.${asset.extension}"; filename*=UTF-8''${encodeURIComponent(`${basename}${n > 1 ? `-${n}` : ''}.${asset.extension}`).replace(/'/g, '%27')}`;
        headers['Cache-Control'] = 'no-store';
      }
      res.writeHead(200, headers); return res.end(bytes);
    }
    if (req.method === 'GET' && route === '/api/settings') return json(res, 200, publicSettings());
    if (req.method === 'GET' && route === '/api/state') return json(res, 200, {
      assets: store.all('assets').map(store.publicAsset), tags: store.all('tags'), threads: store.all('threads'), jobs: jobs.state(), category: lastCategory, ratios: Object.keys(sizes), imageOptions: imageOptions(settings), configured: Boolean(settings.baseUrl && settings.model), limits: limits(settings)
    });
    if (!['POST', 'PATCH'].includes(req.method)) return json(res, 404, { error: '未找到此接口。' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw fail('请从工作台页面提交。', 403);
    const input = await body(req);
    if (route === '/api/settings/test') return json(res, 200, await testSettings(configuration(input)));
    if (route === '/api/settings') {
      const candidate = configuration(input); required(candidate.model, '图片模型');
      const temporary = `${configPath}.${id()}.tmp`;
      await writeFile(temporary, JSON.stringify(candidate, null, 2), { mode: 0o600 }); await rename(temporary, configPath);
      settings = candidate; return json(res, 200, publicSettings());
    }
    if (route === '/api/category') { lastCategory = category(input.category); return json(res, 200, { category: lastCategory }); }
    if (route === '/api/assets/import') {
      const type = category(input.category);
      if (typeof input.data !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(input.data)) throw fail('只支持 PNG、JPG 和 WebP 图片。');
      const asset = await store.image(Buffer.from(input.data.split(',')[1], 'base64'), { name: required(input.name, '图片名称'), category: type, inLibrary: true, libraryAt: now() });
      store.put('assets', asset); return json(res, 201, store.publicAsset(asset));
    }
    const assetRoute = route.match(/^\/api\/assets\/([^/]+)(?:\/(library))?$/);
    if (assetRoute) {
      let asset = store.get('assets', assetRoute[1]);
      if (assetRoute[2]) asset = store.addToLibrary(asset, input.category);
      else {
        if (input.name !== undefined) asset.name = required(input.name, '图片名称');
        if (input.inLibrary === false) asset.inLibrary = false;
        if (input.tags !== undefined) {
          if (!Array.isArray(input.tags) || input.tags.length > 30) throw fail('标签数量无效。');
          asset.tags = [...new Set(input.tags)].map(key => { const tag = store.get('tags', key); if (tag.category !== asset.category) throw fail('标签不属于当前分类。'); return key; });
        }
        store.put('assets', asset);
      }
      return json(res, 200, store.publicAsset(asset));
    }
    if (route === '/api/tags') {
      const name = required(input.name, '标签名称', 32); const type = category(input.category);
      if (['全部', '未分类'].includes(name)) throw fail('此名称用于系统筛选，请换一个标签名称。');
      const tag = store.all('tags').find(item => item.name === name && item.category === type) || store.put('tags', { id: id(), name, category: type });
      return json(res, 200, tag);
    }
    if (route === '/api/threads') return json(res, 201, store.put('threads', { id: id(), name: '新任务', named: false, createdAt: now(), updatedAt: now() }));
    const threadRoute = route.match(/^\/api\/threads\/([^/]+)$/);
    if (threadRoute) return json(res, 200, store.put('threads', { ...store.get('threads', threadRoute[1]), name: required(input.name, '任务名称', 80), named: true }));
    if (route === '/api/jobs') return json(res, 202, jobs.submit(input));
    const jobRoute = route.match(/^\/api\/jobs\/([^/]+)\/(cancel|retry)$/);
    if (jobRoute) return json(res, 200, jobs[jobRoute[2]](jobRoute[1]));
    return json(res, 404, { error: '未找到此接口。' });
  } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : '本地服务处理失败，请重试。' }); }
});
server.listen(Number(process.env.PORT || 64220), process.env.STUDIO_HOST || '127.0.0.1', () => console.log(`Studio: http://${process.env.STUDIO_HOST || '127.0.0.1'}:${server.address().port}`));
