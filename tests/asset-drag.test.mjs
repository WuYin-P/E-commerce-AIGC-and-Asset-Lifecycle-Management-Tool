import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadApp() {
  const elements = new Map(), listeners = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, childNodes: [], dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
      querySelectorAll: () => [],
    });
    return elements.get(id);
  };
  const state = { assets: [], tags: [], threads: [], jobs: [], ratios: [], category: 'model', configured: false };
  const context = vm.createContext({
    document: {
      getElementById: element, querySelectorAll: () => [], createTextNode: text => text,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
    },
    window: { lucide: { createIcons() {} }, addEventListener() {} },
    sessionStorage: { getItem: () => null }, innerWidth: 1280,
    getComputedStyle: () => ({ display: 'block' }),
    setInterval() {}, setTimeout() {}, clearTimeout() {}, initSettings() {},
    FileReader: class {
      readAsDataURL(file) { this.result = file.data; this.onload(); }
    },
    fetch: async (url, options) => {
      requests.push({ url, body: options.body && JSON.parse(options.body) });
      return { ok: true, json: async () => state };
    },
  });
  const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
    .replace("import { initSettings } from './settings.js';", '');
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  assert.equal(element('composerStatus').textContent, '还未连接图片服务，先在左下角设置中填写 API。');
  return {
    element, requests,
    dispatch(type, target, dataTransfer = { types: ['Files'] }) {
      const event = { target, dataTransfer, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const handler of listeners.get(type) || []) handler(event);
      return event;
    },
  };
}

test('dragging an existing image is cancelled before it can be imported as a new asset', async () => {
  const app = await loadApp();
  const image = { tagName: 'IMG', closest: selector => selector === 'img' ? image : null };
  const event = app.dispatch('dragstart', image);
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.element('dropOverlay').hidden, true);
  assert.equal(app.requests.some(request => request.url === '/api/assets/import'), false);
});

test('external files still open the category overlay and import into the selected category', async () => {
  const app = await loadApp();
  const zone = { dataset: { drop: 'model' }, closest: () => zone };
  const transfer = { types: ['Files'], files: [{ name: 'model.png', size: 12, data: 'data:image/png;base64,dGVzdA==' }] };
  assert.equal(app.dispatch('dragenter', zone, transfer).defaultPrevented, true);
  assert.equal(app.element('dropOverlay').hidden, false);
  app.dispatch('dragover', zone, transfer);
  assert.equal(transfer.dropEffect, 'copy');
  app.dispatch('drop', zone, transfer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.element('dropOverlay').hidden, true);
  const imports = app.requests.filter(request => request.url === '/api/assets/import');
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].body, { name: 'model', category: 'model', data: transfer.files[0].data });
});
