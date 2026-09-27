import { id, now, fail, required } from './store.mjs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { Agent } from 'undici';
import { normalizeCustom, limits, renderCustom, parseObject, readPath, validateDashscopeUrl } from './interface-config.js';

import { sizes, resolveImageSize } from './image-options.mjs';
export { sizes };
// Keep slow generation connections open until a response, disconnection or user cancellation.
const generationConnections = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const isLongWaiting = job => job.status === 'running' && Date.now() - Date.parse(job.startedAt || job.createdAt) >= 180_000;

async function readLimited(response, limit = 36 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) throw fail('服务返回内容过大。');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw fail('服务返回内容过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function generate(store, job, config, controller) {
  const signal = controller.signal;
  let headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  let body, endpoint, method = 'POST', requestUrl;
  const custom = config.provider === 'custom' ? normalizeCustom(config.custom) : null;
  const files = await Promise.all(job.references.map(async reference => {
    const asset = store.get('assets', reference.id);
    return { asset, bytes: await store.readImage(asset) };
  }));
  if (config.provider === 'dashscope') {
    headers['Content-Type'] = 'application/json';
    const content = files.map(({ asset, bytes }) => ({ image: `data:${asset.mime};base64,${bytes.toString('base64')}` }));
    content.push({ text: job.providerPrompt });
    body = JSON.stringify({
      model: config.model,
      input: { messages: [{ role: 'user', content }] },
      parameters: { prompt_extend: true, n: 1, size: job.size.replace('x', '*') }
    });
    requestUrl = config.baseUrl;
  } else if (custom) {
    const images = files.map(({ asset, bytes }) => (custom.imageEncoding === 'data-url' ? `data:${asset.mime};base64,` : '') + bytes.toString('base64'));
    const rendered = renderCustom(custom, { model: config.model, prompt: job.providerPrompt, images, size: job.size, apiKey: config.apiKey });
    headers = rendered.headers; method = custom.method; requestUrl = config.baseUrl;
    if (custom.encoding === 'json') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(rendered.fields); }
    else {
      body = new FormData(); const template = parseObject(custom.body, '请求体');
      for (const [key, value] of Object.entries(rendered.fields)) {
        if (template[key] === '{{images}}') {
          files.forEach(({ asset, bytes }, index) => body.append(key, new Blob([bytes], { type: asset.mime }), `image-${index + 1}.${asset.extension}`));
        } else body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    }
  } else if (job.references.length) {
    body = new FormData(); endpoint = 'edits';
    body.set('model', config.model); body.set('prompt', job.providerPrompt); body.set('n', '1'); body.set('size', job.size);
    for (const [index, { asset, bytes }] of files.entries()) {
      body.append('image[]', new Blob([bytes], { type: asset.mime }), `image-${index + 1}.${asset.extension}`);
    }
  } else {
    endpoint = 'generations'; headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ model: config.model, prompt: job.providerPrompt, n: 1, size: job.size });
  }
  const response = await fetch(requestUrl || `${config.baseUrl}/images/${endpoint}`, { method, headers, body, signal, dispatcher: generationConnections, redirect: 'error' });
  let payload;
  try { payload = JSON.parse((await readLimited(response)).toString('utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; if (response.ok) throw fail('图片服务未返回兼容的 JSON 结果。'); }
  function safeError(value) {
    let message = String(value);
    for (const secret of [config.apiKey, ...Object.entries(headers).filter(([key]) => /authorization|key|token|secret/i.test(key)).map(([, value]) => value)]) if (secret) message = message.split(secret).join('[已隐藏]');
    return message.slice(0, 500);
  }
  const remoteError = custom?.errorPath ? readPath(payload, custom.errorPath) : config.provider === 'dashscope' ? (payload?.message || payload?.code) : payload?.error?.message;
  if (!response.ok) {
    if (typeof remoteError === 'string' && remoteError) throw fail(`图片服务 HTTP ${response.status}：${safeError(remoteError)}`);
    const errors = { 401: 'API Key 无效，请检查设置。', 403: '图片服务拒绝访问，请检查模型权限。', 404: '图片接口或模型不存在，请检查服务类型与地址。', 429: '服务限流或额度不足，请稍后重试。', 400: '图片服务拒绝了参数。请检查模型的参考图数量、图片比例/尺寸和内容要求。' };
    throw fail(errors[response.status] || `图片服务返回 HTTP ${response.status}，请重试。`);
  }
  const selected = custom ? readPath(payload, custom.imagePath) : null;
  const content = payload?.output?.choices?.[0]?.message?.content;
  const native = Array.isArray(content) ? content.find(item => typeof item?.image === 'string' && item.image) : null;
  const result = custom ? { [custom.resultType === 'base64' ? 'b64_json' : 'url']: selected } : config.provider === 'dashscope' ? { url: native?.image } : payload?.data?.[0];
  if (typeof result?.b64_json === 'string' && result.b64_json) return Buffer.from(result.b64_json.replace(/^data:image\/[\w.+-]+;base64,/, ''), 'base64');
  if (typeof result?.url === 'string') {
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('图片结果地址无效。');
    // Never forward API credentials to the image download host.
    const download = await fetch(url, { signal, dispatcher: generationConnections, redirect: 'error' });
    if (!download.ok) throw fail('结果图片下载失败，请重试。');
    return readLimited(download, 25 * 1024 * 1024);
  }
  if (typeof remoteError === 'string' && remoteError) throw fail(safeError(remoteError));
  throw fail(custom ? '未从配置的字段路径读取到图片，请检查返回解析设置。' : config.provider === 'dashscope' ? 'DashScope 没有返回图片，请检查模型、提示词和返回内容。' : '服务没有返回图片，需要 data[0].b64_json 或 data[0].url。');
}

export function createJobs(store, getSettings) {
  const active = new Map();
  const queue = [];
  for (const job of store.all('jobs')) {
    if (['queued', 'running'].includes(job.status)) store.put('jobs', { ...job, status: 'interrupted', error: job.status === 'running' ? '本地服务已重启，连接中断，生成结果未知；上游可能仍在处理。' : '本地服务已重启，排队任务尚未发送，可重试。', finishedAt: now() });
  }
  async function run(job, config) {
    const controller = new AbortController(); active.set(job.id, controller);
    job = { ...job, status: 'running', startedAt: now() };
    store.put('jobs', job);
    let received = false;
    try {
      const bytes = await generate(store, job, config, controller);
      received = true;
      if (controller.signal.aborted) return;
      const asset = await store.image(bytes, { name: `生成结果-${job.id.slice(0, 6)}`, jobId: job.id, threadId: job.threadId });
      if (controller.signal.aborted) return;
      store.transaction(() => {
        store.put('assets', asset);
        store.put('jobs', { ...job, status: 'succeeded', resultId: asset.id, finishedAt: now() });
        const thread = store.get('threads', job.threadId);
        if (!thread.named) {
          const first = store.all('jobs').find(item => item.threadId === thread.id) || job;
          thread.name = (first.references.length ? first.references.map(item => item.name).slice(0, 2).join(' · ') : first.prompt).slice(0, 36);
          thread.named = true; store.put('threads', thread);
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) store.put('jobs', { ...job, status: error.status || received ? 'failed' : 'interrupted', finishedAt: now(), error: error.status ? error.message : received ? '图片已返回，但本地保存失败，请检查磁盘空间后重试。' : '连接中断，生成结果未知；上游可能仍在处理，重试可能产生额外费用。' });
    } finally { active.delete(job.id); pump(); }
  }
  function pump() {
    while (active.size < 2 && queue.length) {
      const next = queue.shift();
      if (store.get('jobs', next.job.id).status === 'queued') void run(next.job, next.config);
    }
  }
  function submit(input, snapshot) {
    const thread = store.get('threads', input.threadId);
    const config = structuredClone(getSettings());
    if (!config.baseUrl || !config.model) throw fail('请先在设置中填写 API 地址和图片模型。');
    if (config.provider === 'dashscope') validateDashscopeUrl(config.baseUrl);
    if (!Object.hasOwn(sizes, input.ratio)) throw fail('请选择有效的图片比例。');
    const outputSize = resolveImageSize(config, input.ratio, input.resolution);
    if (snapshot?.size && snapshot.size !== outputSize.size) throw fail('当前模型不支持原任务尺寸，请修改参数后重新生成。');
    if (!Array.isArray(input.referenceIds) || input.referenceIds.length > 16) throw fail('每次最多引用 16 张图片。');
    const refs = [...new Set(input.referenceIds)].map(key => store.get('assets', key));
    const limit = limits(config);
    if (refs.length > limit.maxImages) throw fail(`当前接口最多支持 ${limit.maxImages} 张参考图，请减少引用或调整接口配置。`);
    for (const asset of refs) if (statSync(path.join(store.dir, asset.file)).size > limit.maxImageMB * 1024 * 1024) throw fail(`参考图「${asset.name}」超过当前接口的 ${limit.maxImageMB} MB 限制。`);
    if (!Array.isArray(input.parts) || input.parts.length > 1000) throw fail('提示词格式无效。');
    const parts = input.parts.map(part => {
      if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
      if (part.type === 'asset') {
        const asset = refs.find(item => item.id === part.assetId);
        if (!asset) throw fail('提示词中的图片引用无效，请重新选择资产。');
        return { type: 'asset', assetId: asset.id, name: asset.name };
      }
      throw fail('提示词包含无效内容。');
    });
    const prompt = required(parts.map(part => part.type === 'text' ? part.text : `@${part.name}`).join(''), '提示词', 12000);
    if (parts.some(part => part.type === 'text' && /@[^\s@]*/.test(part.text))) throw fail('有未绑定的 @ 引用，请点击上方图片插入引用，或删除多余的 @。');
    const providerPrompt = parts.map(part => part.type === 'text' ? part.text : `参考图片${refs.findIndex(item => item.id === part.assetId) + 1}`).join('') + (refs.length ? `\n\n参考图片按上传顺序：${refs.map((asset, index) => `图片${index + 1}=${asset.name}`).join('；')}。` : '');
    const job = { id: id(), threadId: thread.id, parts, prompt, providerPrompt, references: refs.map(asset => ({ id: asset.id, name: asset.name, version: asset.version })), ratio: input.ratio, model: config.model, provider: config.provider || 'openai', serviceName: config.name || '', status: 'queued', createdAt: now(), resultId: null, error: null, retryOf: input.retryOf || null };
    if (snapshot) Object.assign(job, { parts: snapshot.parts, prompt: snapshot.prompt, providerPrompt: snapshot.providerPrompt, references: snapshot.references });
    Object.assign(job, outputSize);
    store.transaction(() => { store.put('jobs', job); store.put('threads', { ...thread, updatedAt: job.createdAt }); });
    queue.push({ job, config }); setImmediate(pump);
    return job;
  }
  function cancel(key) {
    const job = store.get('jobs', key);
    if (['queued', 'running'].includes(job.status)) {
      active.get(key)?.abort();
      job.error = job.status === 'running' ? '已取消本地等待；上游可能仍在处理。' : '已取消排队。';
      job.status = 'cancelled'; job.finishedAt = now(); store.put('jobs', job);
    }
    return job;
  }
  function retry(key) {
    const job = store.get('jobs', key);
    const existing = store.all('jobs').findLast(item => item.retryOf === key);
    if (existing) return existing;
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status) && !isLongWaiting(job)) throw fail('生成等待满 3 分钟，或失败、中断、取消后才可以重试。');
    return submit({ threadId: job.threadId, parts: job.parts, ratio: job.ratio, resolution: job.resolution || 'standard', referenceIds: job.references.map(ref => ref.id), retryOf: job.id }, job);
  }
  function state() {
    const list = store.all('jobs');
    const retries = new Map(list.filter(job => job.retryOf).map(job => [job.retryOf, job.id]));
    return list.map(job => ({ ...job, waitingLong: isLongWaiting(job), retryId: retries.get(job.id) || null, canRetry: !retries.has(job.id) && (isLongWaiting(job) || ['failed', 'cancelled', 'interrupted'].includes(job.status)) }));
  }
  return { submit, cancel, retry, state };
}
