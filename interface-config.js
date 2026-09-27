// Shared by the settings preview and backend. Templates are data, never executable code.
const error = message => Object.assign(new Error(message), { status: 400 });
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const bodyVariables = ['model', 'prompt', 'images', 'size', 'content'];
const pretty = value => JSON.stringify(value, null, 2);
export const templates = {
  openai: { body: pretty({ model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: 1 }), imagePath: 'data[0].url', errorPath: 'error.message', sizeSeparator: 'x', encoding: 'json' },
  dashscope: { body: pretty({ model: '{{model}}', input: { messages: [{ role: 'user', content: '{{content}}' }] }, parameters: { prompt_extend: true, n: 1, size: '{{size}}' } }), imagePath: 'output.choices[0].message.content[0].image', errorPath: 'message', sizeSeparator: '*', encoding: 'json' },
  multipart: { body: pretty({ model: '{{model}}', prompt: '{{prompt}}', 'image[]': '{{images}}', size: '{{size}}', n: 1 }), imagePath: 'data[0].b64_json', errorPath: 'error.message', sizeSeparator: 'x', encoding: 'multipart', resultType: 'base64' }
};
export const defaultCustom = { method: 'POST', encoding: 'json', headers: pretty({ Authorization: 'Bearer {{apiKey}}' }), ...templates.dashscope, imageEncoding: 'data-url', maxImages: 3, maxImageMB: 10, resultType: 'url' };

export function validateDashscopeUrl(baseUrl) {
  if (!new URL(baseUrl).pathname.replace(/\/+$/, '').endsWith('/services/aigc/multimodal-generation/generation')) throw error('DashScope 原生需要完整的 /api/v1/services/aigc/multimodal-generation/generation 地址，不能使用 compatible-mode 基础地址。');
}

export function readPath(value, path) {
  if (typeof path !== 'string' || !/^[\w-]+(?:(?:\.[\w-]+)|(?:\[\d+\]))*$/.test(path) || path.length > 300) throw error('字段路径请使用 data[0].url 这样的格式。');
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (unsafe.has(key)) throw error('不支持的字段路径。');
    value = value != null && Object.hasOwn(Object(value), key) ? value[key] : undefined;
  }
  return value;
}
export function parseObject(text, label) {
  if (typeof text !== 'string' || text.length > 32000) throw error(`${label}内容过长或格式无效。`);
  let value;
  try { value = JSON.parse(text); } catch { throw error(`${label}不是有效的 JSON，请检查引号和逗号。`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw error(`${label}必须是 JSON 对象。`);
  return value;
}
export function expand(value, variables, depth = 0) {
  if (depth > 30) throw error('模板嵌套过深。');
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{(\w+)\}\}$/);
    if (exact) {
      if (!Object.hasOwn(variables, exact[1])) throw error(`未知变量：${exact[0]}`);
      return variables[exact[1]];
    }
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, name) => {
      if (!Object.hasOwn(variables, name)) throw error(`未知变量：{{${name}}}`);
      if (typeof variables[name] !== 'string') throw error(`{{${name}}} 必须单独作为字段值。`);
      return variables[name];
    });
  }
  if (Array.isArray(value)) return value.map(item => expand(item, variables, depth + 1));
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [key, item] of Object.entries(value)) {
      if (unsafe.has(key) || key.includes('{{')) throw error('模板字段名无效。');
      // APIs such as Qwen reject image: []; leave the image field out for text-only input.
      if (item === '{{images}}' && !variables.images.length) continue;
      entries.push([key, expand(item, variables, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}
export function normalizeCustom(input = {}) {
  const config = Object.fromEntries(Object.keys(defaultCustom).map(key => [key, input[key] ?? defaultCustom[key]]));
  if (!['POST', 'PUT'].includes(config.method) || !['json', 'multipart'].includes(config.encoding) || !['data-url', 'base64'].includes(config.imageEncoding) || !['url', 'base64'].includes(config.resultType) || !['x', '*'].includes(config.sizeSeparator)) throw error('自定义接口选项无效。');
  if (!Number.isInteger(config.maxImages) || config.maxImages < 0 || config.maxImages > 16 || !Number.isFinite(config.maxImageMB) || config.maxImageMB < 1 || config.maxImageMB > 25) throw error('参考图限制应为 0–16 张、单张 1–25 MB。');
  const body = parseObject(config.body, '请求体');
  const variables = Object.fromEntries(bodyVariables.map(name => [name, ['images', 'content'].includes(name) ? ['example'] : 'example']));
  expand(body, variables);
  if (config.encoding === 'multipart') {
    for (const item of Object.values(body)) if (JSON.stringify(item).includes('{{images}}') && item !== '{{images}}') throw error('文件上传的 {{images}} 必须直接作为一个表单字段的值。');
    if (config.body.includes('{{content}}')) throw error('消息数组 {{content}} 只用于 JSON 请求；文件上传请使用 {{images}}。');
  }
  const headers = parseObject(config.headers, '请求头');
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw error('请求头名称或内容无效。');
    if (['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) throw error('请移除请求头 ' + key + '；请求格式由系统设置。');
    if (/authorization|api.?key|token|secret/i.test(key) && value.trim() && !value.includes('{{apiKey}}')) throw error('认证请求头请使用 {{apiKey}}，将真实密钥填入 API Key。');
    expand(value, { apiKey: 'example' });
  }
  readPath({}, config.imagePath);
  if (config.errorPath) readPath({}, config.errorPath);
  return config;
}
export function limits(config) {
  if (config.provider === 'dashscope') return { maxImages: 3, maxImageMB: 10 };
  if (config.provider === 'custom') {
    const custom = normalizeCustom(config.custom);
    return { maxImages: /\{\{(?:images|content)\}\}/.test(custom.body) ? custom.maxImages : 0, maxImageMB: custom.maxImageMB };
  }
  return { maxImages: 16, maxImageMB: 25 };
}
export function renderCustom(config, { model, prompt, images, size, apiKey }) {
  const content = [...images.map(image => ({ image })), { text: prompt }];
  return { headers: expand(parseObject(config.headers, '请求头'), { apiKey }), fields: expand(parseObject(config.body, '请求体'), { model, prompt, images, size: size.replace('x', config.sizeSeparator), content }) };
}
