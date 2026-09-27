import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';

test('Studio: import, tags, multi-image generation, concurrency, history and restart', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-workflow-'));
  const png = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#78a696' } }).png().toBuffer();
  const calls = [];
  let child, base, delay = false;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test-image' }] })); }
    if (req.url === '/image.png') { assert.equal(req.headers.authorization, undefined); res.setHeader('Content-Type', 'image/png'); return res.end(png); }
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const body = Buffer.concat(bytes);
    if (req.url === '/v1/services/aigc/multimodal-generation/generation') {
      assert.equal(req.headers.authorization, `Bearer ${config.apiKey}`);
      const input = JSON.parse(body);
      calls.push({ endpoint: 'dashscope', content: input.input.messages[0].content, parameters: input.parameters });
      res.setHeader('Content-Type', 'application/json');
      if (input.model === 'native-error') { res.statusCode = 400; return res.end(JSON.stringify({ code: 'InvalidParameter', message: '原生模型参数不匹配 ' + config.apiKey })); }
      return res.end(JSON.stringify({ output: { choices: [{ message: { content: [{ text: '生成完成' }, { image: `http://127.0.0.1:${mock.address().port}/image.png` }] } }] } }));
    }
    if (req.url === '/v1/images/edits' || req.url === '/custom-upload') {
      const form = await new Request('http://mock', { method: 'POST', headers: req.headers, body }).formData();
      calls.push({ endpoint: 'edits', images: form.getAll('image[]').length, prompt: form.get('prompt').replace(/\r\n/g, '\n'), n: form.get('n'), size: form.get('size') });
      if (req.url === '/custom-upload') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ output: { image: png.toString('base64') } })); }
    } else calls.push({ endpoint: 'generations', ...JSON.parse(body) });
    if (req.url === '/custom-json') {
      assert.equal(req.headers['x-api-key'], config.apiKey);
      const input = JSON.parse(body); assert.equal(input.messages[0].content.length, 3);
      assert.equal(input.output_size, '1152*1536');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ output: { images: [`http://127.0.0.1:${mock.address().port}/image.png`] } }));
    }
    if (req.url === '/custom-error') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ problem: { detail: '模型参数不匹配 ' + config.apiKey } })); }
    if (delay) await new Promise(resolve => setTimeout(resolve, 350));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  t.after(async () => { await stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', STUDIO_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    base = await new Promise((resolve, reject) => {
      let output = ''; child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Studio: (http:\/\/[^\s]+)/); if (match) resolve(match[1]); });
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`)));
    });
  }
  async function api(route, value) {
    const response = await fetch(base + route, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  async function completed(id) {
    for (let i = 0; i < 100; i++) {
      const job = (await api('/api/state')).jobs.find(job => job.id === id);
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.fail('job did not finish');
  }
  await start();
  const config = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test-key-not-real', model: 'test-image' };
  assert.equal((await api('/api/settings/test', config)).ok, true);
  const saved = await api('/api/settings', config);
  assert.equal(saved.hasApiKey, true); assert.equal(saved.apiKey, undefined);
  const importImage = (name, category) => api('/api/assets/import', { name, category, data: `data:image/png;base64,${png.toString('base64')}` });
  const model = await importImage('小美', 'model'); const clothing = await importImage('白色上衣', 'clothing');
  const tag = await api('/api/tags', { name: '小美', category: 'model' });
  assert.deepEqual((await api(`/api/assets/${model.id}`, { tags: [tag.id] })).tags, [tag.id]);
  const thread = await api('/api/threads', {});
  const input = { threadId: thread.id, ratio: '3:4', referenceIds: [model.id, clothing.id], parts: [{ type: 'text', text: '让' }, { type: 'asset', assetId: model.id }, { type: 'text', text: '穿上' }, { type: 'asset', assetId: clothing.id }] };
  const job = await api('/api/jobs', input);
  await api(`/api/assets/${model.id}`, { name: '小美正面' });
  const result = await completed(job.id); assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.references[0].name, '小美');
  assert.deepEqual(calls[0], { endpoint: 'edits', images: 2, prompt: '让参考图片1穿上参考图片2\n\n参考图片按上传顺序：图片1=小美；图片2=白色上衣。', n: '1', size: '1152x1536' });
  const added = await api(`/api/assets/${result.resultId}/library`, { category: 'model' });
  const addedAgain = await api(`/api/assets/${result.resultId}/library`, { category: 'model' });
  assert.equal(added.libraryAt, addedAgain.libraryAt);
  const download = await fetch(base + added.url + '?download=1'); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  await api(`/api/assets/${model.id}`, { inLibrary: false });
  assert.equal((await fetch(base + model.url)).status, 200);
  delay = true;
  const plain = { ...input, referenceIds: [], parts: [{ type: 'text', text: '一件白色上衣' }] };
  const second = await api('/api/jobs', plain); const third = await api('/api/jobs', plain); const fourth = await api('/api/jobs', plain);
  const statuses = (await api('/api/state')).jobs.filter(job => [second.id, third.id, fourth.id].includes(job.id)).map(job => job.status);
  assert.deepEqual(statuses, ['running', 'running', 'queued']);
  assert.equal((await api(`/api/jobs/${fourth.id}/cancel`, {})).status, 'cancelled');
  assert.equal((await completed(second.id)).status, 'succeeded'); assert.equal((await completed(third.id)).status, 'succeeded');
  const retry = await api(`/api/jobs/${fourth.id}/retry`, {}); assert.equal(retry.retryOf, fourth.id); assert.equal((await completed(retry.id)).status, 'succeeded');
  assert.ok(calls.some(call => call.endpoint === 'generations' && call.n === 1));
  delay = false;
  const invalidNative = await fetch(base + '/api/settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, provider: 'dashscope', baseUrl: config.baseUrl + '/compatible-mode/v1' }) });
  assert.equal(invalidNative.status, 400);
  assert.match((await invalidNative.json()).error, /完整/);
  const dashscope = await api('/api/settings', { ...config, provider: 'dashscope', baseUrl: `http://127.0.0.1:${mock.address().port}/v1/services/aigc/multimodal-generation/generation` });
  assert.equal(dashscope.provider, 'dashscope');
  assert.equal((await api('/api/settings/test', { ...config, provider: 'dashscope', baseUrl: dashscope.baseUrl })).localOnly, true);
  const dashJob = await api('/api/jobs', input); assert.equal((await completed(dashJob.id)).status, 'succeeded');
  assert.equal(calls.at(-1).endpoint, 'dashscope'); assert.equal(calls.at(-1).content.length, 3);
  assert.ok(calls.at(-1).content[0].image.startsWith('data:image/png;base64,'));
  assert.equal(calls.at(-1).content[2].text, input.parts[0].text + '参考图片1' + input.parts[2].text + '参考图片2\n\n参考图片按上传顺序：图片1=小美正面；图片2=白色上衣。');
  assert.deepEqual(calls.at(-1).parameters, { prompt_extend: true, n: 1, size: '1152*1536' });
  const dashText = await api('/api/jobs', plain); assert.equal((await completed(dashText.id)).status, 'succeeded');
  assert.equal(calls.at(-1).endpoint, 'dashscope'); assert.equal(calls.at(-1).content.length, 1); assert.equal(calls.at(-1).content[0].text, '一件白色上衣');
  await api('/api/settings', { ...config, provider: 'dashscope', baseUrl: dashscope.baseUrl, model: 'native-error' });
  const nativeFailure = await completed((await api('/api/jobs', plain)).id);
  assert.equal(nativeFailure.status, 'failed'); assert.match(nativeFailure.error, /原生模型参数不匹配/); assert.equal(nativeFailure.error.includes(config.apiKey), false);
  await api('/api/settings', { ...config, provider: 'dashscope', baseUrl: dashscope.baseUrl, model: 'qwen-image-3.0-pro' });
  const capabilities = (await api('/api/state')).imageOptions;
  assert.equal(capabilities.adapted, true);
  assert.deepEqual(capabilities.resolutions.map(item => item.label), ['1K', '2K']);
  assert.equal(capabilities.resolutions.find(item => item.id === 'high').sizes['3:4'], '1536x2048');
  for (const preset of capabilities.resolutions) for (const [ratio, size] of Object.entries(preset.sizes)) {
    const [w, h] = size.split('x').map(Number); const [rw, rh] = ratio.split(':').map(Number);
    assert.equal(w * rh, h * rw);
    assert.ok(w * h >= 512 * 512 && w * h <= 2048 * 2048);
  }
  const hdJob = await completed((await api('/api/jobs', { ...input, resolution: 'high' })).id);
  assert.equal(hdJob.status, 'succeeded'); assert.equal(hdJob.size, '1536x2048'); assert.equal(hdJob.resolution, 'high');
  assert.equal(calls.at(-1).parameters.size, '1536*2048');
  const hdPlain = await completed((await api('/api/jobs', { ...plain, ratio: '16:9', resolution: 'high' })).id);
  assert.equal(hdPlain.size, '2560x1440'); assert.equal(calls.at(-1).parameters.size, '2560*1440');
  const queuedHd = await api('/api/jobs', { ...input, resolution: 'high' });
  await api(`/api/jobs/${queuedHd.id}/cancel`, {});
  const hdRetry = await api(`/api/jobs/${queuedHd.id}/retry`, {});
  assert.equal(hdRetry.size, queuedHd.size); assert.equal(hdRetry.resolution, 'high');
  await completed(hdRetry.id);
  const invalidResolution = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, resolution: '4k' }) });
  assert.equal(invalidResolution.status, 400);
  const custom = { provider: 'custom', name: '测试网关', baseUrl: `http://127.0.0.1:${mock.address().port}/custom-json`, apiKey: config.apiKey, model: config.model,
    custom: { method: 'POST', encoding: 'json', headers: '{"X-API-Key":"{{apiKey}}"}', body: '{"model":"{{model}}","messages":[{"role":"user","content":"{{content}}"}],"output_size":"{{size}}"}', imageEncoding: 'data-url', maxImages: 3, sizeSeparator: '*', resultType: 'url', imagePath: 'output.images[0]', errorPath: 'problem.detail' } };
  const beforeCheck = calls.length;
  assert.equal((await api('/api/settings/test', custom)).ok, true); assert.equal(calls.length, beforeCheck);
  const customSaved = await api('/api/settings', custom); assert.equal(customSaved.name, '测试网关'); assert.equal(customSaved.apiKey, undefined);
  const customJob = await api('/api/jobs', input); assert.equal((await completed(customJob.id)).status, 'succeeded');
  const fileConfig = { ...custom, baseUrl: `http://127.0.0.1:${mock.address().port}/custom-upload`, custom: { ...custom.custom, encoding: 'multipart', resultType: 'base64', imagePath: 'output.image', body: '{"model":"{{model}}","prompt":"{{prompt}}","image[]":"{{images}}","size":"{{size}}","n":1}' } };
  await api('/api/settings', fileConfig); const fileJob = await api('/api/jobs', input); assert.equal((await completed(fileJob.id)).status, 'succeeded'); assert.equal(calls.at(-1).images, 2);
  await api('/api/settings', { ...custom, baseUrl: `http://127.0.0.1:${mock.address().port}/custom-error` });
  const errorJob = await api('/api/jobs', input); const failed = await completed(errorJob.id); assert.equal(failed.status, 'failed'); assert.match(failed.error, /模型参数不匹配/); assert.equal(failed.error.includes(config.apiKey), false);
  await api('/api/settings', custom);
  await api('/api/category', { category: 'scene' }); await stop(); await start();
  const state = await api('/api/state'); assert.equal(state.category, 'model');
  assert.equal(state.jobs.find(item => item.id === job.id).resultId, result.resultId);
  assert.equal(state.assets.find(item => item.id === model.id).inLibrary, false);
  assert.equal(state.tags[0].id, tag.id); assert.equal(state.threads.length, 1);
  const restored = await api('/api/settings'); assert.equal(restored.provider, 'custom'); assert.equal(restored.custom.imagePath, 'output.images[0]'); assert.equal(restored.apiKey, undefined);
});
