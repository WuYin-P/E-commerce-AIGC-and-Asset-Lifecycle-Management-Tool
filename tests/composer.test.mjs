import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function composer() {
  const elements = new Map(), storage = new Map(), listeners = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      childNodes: [], dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, setAttribute() {}, focus() {},
      replaceChildren(...nodes) { this.childNodes = nodes; },
      append(...nodes) { this.childNodes.push(...nodes); },
      querySelectorAll() { return this.childNodes.filter(node => node.dataset?.assetId); },
    });
    return elements.get(id);
  };
  const state = { assets: [{ id: 'model', name: '小美', thumb: '/test.webp', tags: [], inLibrary: true, category: 'model', libraryAt: '2026-09-19' }], tags: [], threads: [], jobs: [], ratios: ['3:4'], category: 'model', configured: true };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], createTextNode: text => ({ nodeType: 3, textContent: text }), addEventListener(type, fn) { listeners.set(type, [...listeners.get(type) || [], fn]); } },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { lucide: { createIcons() {} }, addEventListener() {} },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    innerWidth: 1280, getComputedStyle: () => ({ display: 'block' }),
    setInterval() {}, setTimeout() {}, clearTimeout() {}, initSettings() {},
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body); requests.push({ url, body });
      let result = state;
      if (url === '/api/threads') result = { id: 'thread', name: '新任务', updatedAt: '2026-09-19' };
      if (url === '/api/jobs') result = { ...body, id: `job-${requests.length}`, status: 'queued', createdAt: '2026-09-19', references: body.referenceIds.map(id => ({ id, name: '小美' })) };
      return { ok: true, json: async () => result };
    },
  });
  const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace("import { initSettings } from './settings.js';", '');
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  const button = { dataset: { action: 'reference', id: 'model' }, closest: selector => selector === '[data-action]' ? button : null };
  for (const handler of listeners.get('click')) await handler({ target: button });
  const prompt = element('prompt');
  const mention = { nodeType: 1, tagName: 'SPAN', dataset: { assetId: 'model' }, remove() { prompt.childNodes = prompt.childNodes.filter(node => node !== this); } };
  prompt.childNodes = [{ nodeType: 3, textContent: '让' }, mention, { nodeType: 3, textContent: '穿白色西装' }];
  return { element, requests, storage };
}

test('sending twice preserves prompt, image references and the saved draft', async () => {
  const app = await composer();
  await app.element('sendButton').onclick();
  assert.equal(app.element('prompt').childNodes.length, 3);
  assert.match(app.element('references').innerHTML, /model/);
  await app.element('sendButton').onclick();
  const jobs = app.requests.filter(item => item.url === '/api/jobs');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].body, jobs[1].body);
  const draft = JSON.parse(app.storage.get('studio-drafts')).thread;
  assert.deepEqual(draft.refs, ['model']);
  assert.equal(draft.parts.length, 3);
});

test('clear references removes chips and mentions but keeps text and sent snapshots', async () => {
  const app = await composer();
  await app.element('sendButton').onclick();
  assert.equal(app.element('clearReferences').disabled, false);
  app.element('clearReferences').onclick();
  assert.equal(app.element('references').innerHTML, '');
  assert.equal(app.element('prompt').childNodes.map(node => node.textContent).join(''), '让穿白色西装');
  assert.equal(app.element('clearReferences').disabled, true);
  const sent = app.requests.find(item => item.url === '/api/jobs').body;
  assert.deepEqual(sent.referenceIds, ['model']);
  assert.equal(sent.parts[1].assetId, 'model');
  assert.deepEqual(JSON.parse(app.storage.get('studio-drafts')).thread.refs, []);
});
