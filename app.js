import { initSettings } from './settings.js';
window.lucide.createIcons();

const $ = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const types = { model: '模特', clothing: '服装', scene: '场景' };
const labels = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '生成失败', interrupted: '结果未知', cancelled: '已取消' };
const retrying = new Set();
let data = { assets: [], tags: [], threads: [], jobs: [], ratios: [], configured: false, limits: { maxImages: 16, maxImageMB: 25 } };
let current = sessionStorage.getItem('studio-thread') || null;
let category = 'model', filter = 'all', refs = [], ratio = '3:4', resolution = 'standard', selection = null;
let assetsOpen = false, settingsOpen = false, sending = false, previewId = null;
let drafts = {}, lastRendered = '', toastTimer, renameTarget, importing = false;
try { drafts = JSON.parse(sessionStorage.getItem('studio-drafts') || '{}'); } catch { /* A damaged draft must not block startup. */ }

async function request(url, input) {
  let response;
  try { response = await fetch(url, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
  catch { throw new Error('无法连接本地服务，请检查服务是否正在运行。'); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '操作失败，请重试。');
  return body;
}
function toast(message, error = false, undo) {
  clearTimeout(toastTimer); $('toast').replaceChildren(document.createTextNode(message));
  $('toast').className = `toast ${error ? 'error' : ''}`; $('toast').hidden = false;
  if (undo) { const button = document.createElement('button'); button.textContent = '撤销'; button.onclick = () => void undo().catch(report); $('toast').append(button); }
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 10000 : 4500);
}
const report = error => toast(error.message, true);
const asset = key => data.assets.find(item => item.id === key);
const thread = key => data.threads.find(item => item.id === key);
const date = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function thumbnail(item, name = item.name) { return `<img src="${item.thumb}" alt="${escape(name)}" loading="lazy">`; }
function closeMenu() { if ($('contextMenu').matches(':popover-open')) $('contextMenu').hidePopover(); }
function openMenu(anchor, html) {
  const rect = anchor.getBoundingClientRect();
  closeMenu(); const menu = $('contextMenu');
  ($('preview').open ? $('preview') : document.body).append(menu);
  menu.innerHTML = html; menu.showPopover();
  const width = menu.offsetWidth; const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, rect.bottom + height + 8 > innerHeight ? rect.top - height - 6 : rect.bottom + 6)}px`;
}

function showSettings(value) {
  settingsOpen = value;
  $('settings').hidden = !value; $('workbench').hidden = value; $('allResults').hidden = value;
  $('settingsNav').classList.toggle('active', value); $('studioNav').classList.toggle('active', !value);
  $('threadTitle').disabled = value; $('threadTitle').textContent = value ? '设置' : thread(current)?.name || '新任务';
  $('pageState').textContent = value ? 'API 服务连接' : '一张图片，一个新的可能';
  if (value) setAssets(false);
}
function setAssets(value) {
  assetsOpen = value;
  $('app').classList.toggle('assets-open', value); $('assetPanel').classList.toggle('is-open', value);
  $('assetsNav').classList.toggle('active', value); $('assetsNav').setAttribute('aria-expanded', value);
  if (value && innerWidth < 1020) { $('app').classList.remove('tasks-open'); $('threadPanel').hidden = false; }
  $('tasksNav').setAttribute('aria-expanded', getComputedStyle($('threadPanel')).display !== 'none');
}
async function setCategory(value) {
  category = value; filter = 'all'; renderAssets();
  await request('/api/category', { category });
}
function readParts() {
  const parts = [];
  const text = value => {
    if (!value) return;
    const last = parts.at(-1); if (last?.type === 'text') last.text += value; else parts.push({ type: 'text', text: value });
  };
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) return text(node.textContent.replace(/\u00a0/g, ' '));
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset.assetId) return parts.push({ type: 'asset', assetId: node.dataset.assetId });
    if (node.tagName === 'BR') return text('\n');
    if (['DIV', 'P'].includes(node.tagName) && node.previousSibling) text('\n');
    for (const child of node.childNodes) visit(child);
  }
  for (const node of $('prompt').childNodes) visit(node);
  return parts;
}
function mentionNode(item) {
  const node = document.createElement('span'); node.className = 'mention'; node.contentEditable = 'false'; node.dataset.assetId = item.id;
  const image = document.createElement('img'); image.src = item.thumb; image.alt = '';
  node.append(image, document.createTextNode(`@${item.name}`)); return node;
}
function writeParts(parts) {
  $('prompt').replaceChildren();
  for (const part of parts) {
    const item = part.type === 'asset' ? asset(part.assetId) : null;
    $('prompt').append(item ? mentionNode(item) : document.createTextNode(part.text || `@${part.name || '不可用资产'}`));
  }
  selection = null;
}
function saveDraft() {
  drafts[current || 'new'] = { parts: readParts(), refs: [...refs], ratio, resolution };
  sessionStorage.setItem('studio-drafts', JSON.stringify(drafts));
}
function restoreDraft() {
  const draft = drafts[current || 'new'] || {};
  refs = (draft.refs || []).filter(key => asset(key)); ratio = draft.ratio || '3:4'; writeParts(draft.parts || []); renderRefs();
  resolution = draft.resolution || 'standard'; renderImageOptions();
}
function resolutionDisplayLabel(item) {
  if (item?.id === 'standard' && ['标准', 'standard'].includes(item.label)) return '1K';
  if (item?.id === 'high' && ['高清', 'high'].includes(item.label)) return '2K';
  return item?.label || item?.id || '默认尺寸';
}
function renderImageOptions() {
  const options = data.imageOptions;
  if (!options) { $('resolutionButton').disabled = true; return; }
  let preset = options.resolutions.find(item => item.id === resolution);
  if (!preset) {
    resolution = options.defaultResolution; preset = options.resolutions.find(item => item.id === resolution);
    toast('当前模型不支持此前的分辨率，已切换为默认尺寸');
  }
  if (!Object.hasOwn(preset.sizes, ratio)) ratio = Object.keys(preset.sizes)[0];
  $('ratioButton').textContent = `${ratio} ▾`;
  $('resolutionButton').textContent = `${resolutionDisplayLabel(preset)} ▾`;
  $('resolutionButton').disabled = options.resolutions.length < 2;
  $('resolutionButton').title = options.adapted ? '按官方文档适配的常用尺寸；2K 可能增加费用和耗时' : '此模型尚未适配分辨率选项，沿用原有尺寸';
}
function jobSizeLabel(job) {
  if (job.resolution === 'standard' && ['标准', 'standard'].includes(job.resolutionLabel)) return '1K';
  if (job.resolution === 'high' && ['高清', 'high'].includes(job.resolutionLabel)) return '2K';
  return job.resolutionLabel || '默认尺寸';
}
function changeThread(key) {
  saveDraft(); current = key; sessionStorage.setItem('studio-thread', current || '');
  restoreDraft(); showSettings(false); lastRendered = ''; render();
  $('timeline').scrollTop = $('timeline').scrollHeight;
  if (innerWidth < 1020) $('app').classList.remove('tasks-open');
}
function addReference(key) {
  if (!asset(key)) return;
  if (!refs.includes(key) && refs.length >= (data.limits?.maxImages ?? 16)) return toast(`当前接口最多引用 ${data.limits.maxImages} 张图片，请先移除一张引用。`, true);
  if (!refs.includes(key)) { refs.push(key); renderRefs(); renderAssets(); saveDraft(); }
  else toast('这张图片已在引用栏中');
  showSettings(false);
}
function insertReference(key) {
  const item = asset(key); if (!item) return;
  $('prompt').focus();
  const range = selection && $('prompt').contains(selection.commonAncestorContainer) ? selection : document.createRange();
  if (!selection || !$('prompt').contains(range.commonAncestorContainer)) { range.selectNodeContents($('prompt')); range.collapse(false); }
  // Replace the trigger @ immediately before the caret, rather than leaving it unbound.
  if (range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0 && range.startContainer.textContent[range.startOffset - 1] === '@') range.setStart(range.startContainer, range.startOffset - 1);
  range.deleteContents(); const token = mentionNode(item); range.insertNode(token); range.setStartAfter(token); range.collapse(true);
  const space = document.createTextNode(' '); range.insertNode(space); range.setStartAfter(space); range.collapse(true);
  const cursor = getSelection(); cursor.removeAllRanges(); cursor.addRange(range); selection = range.cloneRange(); saveDraft();
}
function removeReference(key) {
  refs = refs.filter(item => item !== key);
  $('prompt').querySelectorAll('[data-asset-id]').forEach(node => { if (node.dataset.assetId === key) node.remove(); });
  renderRefs(); renderAssets(); saveDraft();
}
function renderRefs() {
  $('clearReferences').disabled = refs.length === 0;
  $('references').innerHTML = refs.map(key => asset(key)).filter(Boolean).map(item => `<div class="reference-chip"><button class="reference-image" data-action="insert-reference" data-id="${item.id}" aria-label="插入引用 ${escape(item.name)}" title="${escape(item.name)}">${thumbnail(item)}</button><button class="reference-remove" data-action="remove-reference" data-id="${item.id}" aria-label="取消引用 ${escape(item.name)}">×</button></div>`).join('');
  const maximum = data.limits?.maxImages ?? 16;
  $('referenceCount').textContent = maximum ? `${refs.length} / ${maximum} 张参考图` : `${refs.length} 张参考图`;
}
function renderAssets() {
  const tags = data.tags.filter(item => item.category === category);
  if (filter !== 'all' && filter !== 'untagged' && !tags.some(item => item.id === filter)) filter = 'all';
  $('tagFilter').innerHTML = '<option value="all">全部</option><option value="untagged">未分类</option>' + tags.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
  $('tagFilter').value = filter;
  document.querySelectorAll('[data-category]').forEach(node => node.setAttribute('aria-selected', node.dataset.category === category));
  const list = data.assets.filter(item => item.inLibrary && item.category === category && (filter === 'all' || (filter === 'untagged' ? !item.tags.length : item.tags.includes(filter)))).sort((a, b) => b.libraryAt.localeCompare(a.libraryAt));
  $('assetCount').textContent = `${list.length} 张${types[category]}图片`;
  $('assetGrid').innerHTML = list.length ? list.map(item => `<article class="asset-card ${refs.includes(item.id) ? 'selected' : ''}"><div class="asset-picture"><button class="asset-pick" data-action="reference" data-id="${item.id}" aria-label="引用 ${escape(item.name)}">${thumbnail(item)}</button>${refs.includes(item.id) ? '<span class="selected-mark">✓ 已引用</span>' : ''}<button class="asset-more" data-action="asset-menu" data-id="${item.id}" aria-label="${escape(item.name)}的更多操作">⋯</button></div><div class="asset-name" title="${escape(item.name)}">${escape(item.name)}</div><div class="asset-tags">${item.tags.map(key => `<span>${escape(data.tags.find(tag => tag.id === key)?.name)}</span>`).join('') || '<span>未分类</span>'}</div></article>`).join('') : `<div class="empty-grid">${filter === 'all' ? `还没有${types[category]}图片<br>从下方导入，或把图片拖到这里` : '暂无匹配的图片<br>试试其他标签或“全部”'}</div>`;
}
function renderThreads() {
  $('threadList').innerHTML = [...data.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => {
    const list = data.jobs.filter(job => job.threadId === item.id); const running = list.filter(job => ['queued', 'running'].includes(job.status)).length;
    return `<button class="thread-entry ${item.id === current ? 'active' : ''}" data-action="thread" data-id="${item.id}" title="${escape(item.name)}"><span>${escape(item.name)}</span><small>${running ? `${running} 张处理中` : `${list.length} 次生成`} · ${date(item.updatedAt)}</small></button>`;
  }).join('') || '<div class="empty-grid">你的创作记录<br>会保存在这里</div>';
}
function partsHTML(parts) {
  return parts.map(part => {
    if (part.type === 'text') return escape(part.text);
    const item = asset(part.assetId);
    return `<span class="mention">${item ? `<img src="${item.thumb}" alt="">` : ''}@${escape(part.name || item?.name || '图片')}</span>`;
  }).join('');
}
function frozenRefs(job) { return `<div class="frozen-refs">${job.references.map(ref => { const item = asset(ref.id); return item ? `<button data-action="preview" data-id="${ref.id}" aria-label="查看参考图 ${escape(ref.name)}">${thumbnail(item, ref.name)}</button>` : ''; }).join('')}</div>`; }
function libraryButton(item) { return `<button data-action="library" data-id="${item.id}">${item.inLibrary ? '✓ 已加入资产' : '＋ 加入资产'}</button>`; }
function resultButtons(item, includeJump = false) {
  return `${libraryButton(item)}<a href="${item.url}?download=1" download>下载</a>${includeJump ? `<button data-action="jump" data-id="${item.jobId}">跳回任务</button>` : ''}`;
}
function renderTimeline() {
  const list = data.jobs.filter(item => item.threadId === current);
  const signature = JSON.stringify(list) + JSON.stringify(data.assets.map(item => [item.id, item.inLibrary]));
  if (signature === lastRendered) return;
  lastRendered = signature;
  const timeline = $('timeline'); const bottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90; const scroll = timeline.scrollTop;
  if (!list.length) {
    timeline.innerHTML = `<div class="empty"><div><h1>新的创作</h1><div class="actions"><button class="secondary" data-action="open-assets">＋ 导入参考图片</button>${!data.configured ? '<button class="secondary" data-action="settings">连接图片服务 ↗</button>' : ''}</div></div></div>`;
    return;
  }
  timeline.innerHTML = list.map((job, index) => {
    const result = asset(job.resultId); const pending = ['queued', 'running'].includes(job.status);
    const originalIndex = list.findIndex(item => item.id === job.retryOf);
    const retryLinks = `${job.retryOf ? `<button data-action="jump" data-id="${job.retryOf}">重试自第 ${originalIndex + 1} 次生成 · 查看原记录</button>` : ''}${job.retryId ? `<button data-action="jump" data-id="${job.retryId}">已重新发送 · 查看重试任务</button>` : ''}`;
    const pendingMessage = job.waitingLong ? (job.retryId ? '原请求仍在等待，返回的图片会保留在这里。' : '已等待超过 3 分钟，仍在等待。可继续等待或重试；重试另发请求，可能产生额外费用。') : '可以继续编辑和发送下一张图片';
    const retryButton = job.canRetry ? `<button data-action="retry" data-id="${job.id}" ${retrying.has(job.id) ? 'disabled' : ''}>${retrying.has(job.id) ? '正在重新发送…' : '重试'}</button>` : '';
    return `<article class="turn" id="job-${job.id}"><div class="turn-head"><span class="turn-number">${String(index + 1).padStart(2, '0')}</span><span>${date(job.createdAt)}</span><span>· ${escape(job.ratio)}</span><span>· ${escape(jobSizeLabel(job))}</span><span class="status-pill ${job.status}">${labels[job.status]}</span></div><div class="prompt-bubble">${partsHTML(job.parts)}${frozenRefs(job)}</div>${retryLinks ? `<div class="retry-links">${retryLinks}</div>` : ''}${job.error ? `<p class="error-inline">${escape(job.error)}</p>` : ''}<div class="result-card">${result ? `<button class="result-image-button" data-action="preview" data-id="${result.id}" aria-label="放大第 ${index + 1} 张生成结果">${thumbnail(result)}</button><div class="result-toolbar">${resultButtons(result)}<button data-action="reuse" data-id="${job.id}">修改提示词</button></div>` : `<div class="result-status">${pending ? '<span class="spinner" aria-hidden="true"></span>' : '<span class="muted">○</span>'}<strong>${job.waitingLong ? '仍在等待' : labels[job.status]}</strong><p>${pending ? pendingMessage : escape(job.error)}</p></div><div class="result-toolbar">${retryButton}${pending ? `<button data-action="cancel" data-id="${job.id}">取消生成</button>` : `<button data-action="reuse" data-id="${job.id}">修改提示词</button><button data-action="reselect" data-id="${job.id}">重选资产</button>`}</div>`}</div></article>`;
  }).join('');
  timeline.scrollTop = bottom ? timeline.scrollHeight : scroll;
}
function renderResults() {
  const list = data.assets.filter(item => item.jobId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('resultCount').textContent = list.length; $('drawerCount').textContent = `${list.length} 张图片 · 包括尚未加入资产库的结果`;
  $('resultGrid').innerHTML = list.map(item => `<article class="gallery-card"><button class="result-image-button" data-action="preview" data-id="${item.id}" aria-label="预览 ${escape(thread(item.threadId)?.name || item.name)}">${thumbnail(item)}</button><div class="result-toolbar">${resultButtons(item, true)}</div><div class="asset-name">${date(item.createdAt)}</div></article>`).join('') || '<div class="empty-grid">还没有生成结果<br>第一张图片会从这里开始</div>';
}
function render() {
  renderImageOptions(); renderAssets(); renderThreads(); renderTimeline(); renderResults();
  if (!settingsOpen) $('threadTitle').textContent = thread(current)?.name || '新任务';
  $('composerStatus').textContent = data.configured ? '每次生成一张图片 · 可连续发送多个任务' : '还未连接图片服务，先在左下角设置中填写 API。';
}
let refreshing = null;
async function refresh(force = false) {
  if (refreshing) { await refreshing; if (!force) return; }
  refreshing = (async () => {
    const next = await request('/api/state');
    const previous = data; data = next;
    if (JSON.stringify(previous) !== JSON.stringify(data) || force) {
      render();
      for (const job of data.jobs) {
        const old = previous.jobs.find(item => item.id === job.id);
        if (old && ['queued', 'running'].includes(old.status) && ['failed', 'interrupted'].includes(job.status)) toast(job.error, true);
        if (old && ['queued', 'running'].includes(old.status) && job.status === 'succeeded') toast('一张新图片已生成');
      }
    }
  })();
  try { await refreshing; } finally { refreshing = null; }
}
function openPreview(key) {
  const item = asset(key); if (!item) return;
  closeMenu(); previewId = key;
  $('previewImage').src = item.url; $('previewImage').alt = item.name;
  const job = data.jobs.find(entry => entry.id === item.jobId);
  $('previewDetails').innerHTML = `<div class="eyebrow">${job ? 'GENERATION / DETAILS' : 'ASSET / DETAILS'}</div><h2>${escape(item.name)}</h2><div class="actions"><button class="secondary" data-action="preview-reference" data-id="${item.id}">＠ 引用</button><a class="secondary" href="${item.url}?download=1" download>下载原图</a></div><div class="result-toolbar">${libraryButton(item)}${item.category ? `<button data-action="tags" data-id="${item.id}">管理标签</button>` : ''}</div><span class="detail-label">图片信息</span><div class="detail-value">${item.width} × ${item.height} · ${item.extension.toUpperCase()}<br>${date(item.createdAt)}</div>${job ? `<span class="detail-label">原始提示词</span><div class="detail-value">${partsHTML(job.parts)}</div><span class="detail-label">引用资产</span>${frozenRefs(job)}<span class="detail-label">生成参数</span><div class="detail-value">比例 ${escape(job.ratio)} · ${escape(jobSizeLabel(job))} · ${escape(job.model)}</div><span class="detail-label">所属任务</span><div class="detail-value">${escape(thread(job.threadId)?.name)}</div><div class="actions" style="margin-top:22px"><button class="secondary" data-action="jump" data-id="${job.id}">跳回任务</button><button class="secondary" data-action="reuse" data-id="${job.id}">继续生成</button></div>` : '<span class="detail-label">来源</span><div class="detail-value">本地导入</div>'}`;
  if (!$('preview').open) $('preview').showModal();
}
function showAssetMenu(button, key) {
  openMenu(button, `<button data-action="preview" data-id="${key}">大图预览</button><button data-action="tags" data-id="${key}">管理标签</button><button data-action="rename-asset" data-id="${key}">重命名</button><a href="/media/${key}?download=1" download>下载</a><button class="danger" data-action="remove-asset" data-id="${key}">从资产库移除</button>`);
}
function showTags(button, key) {
  const item = asset(key); if (!item) return;
  openMenu(button, `<div class="menu-title">管理标签 · ${escape(item.name)}</div>${data.tags.filter(tag => tag.category === item.category).map(tag => `<label class="tag-check"><input type="checkbox" data-tag="${tag.id}" data-asset="${key}" ${item.tags.includes(tag.id) ? 'checked' : ''}>${escape(tag.name)}</label>`).join('') || '<div class="menu-title">还没有标签，创建第一个吧</div>'}<form class="tag-create" id="tagForm" data-asset="${key}"><input name="name" aria-label="新标签名称" placeholder="输入新标签，如“小美”" maxlength="32" required><button class="primary" type="submit">创建并添加</button></form>`);
}
function chooseLibrary(button, key) {
  const item = asset(key);
  if (item.inLibrary) {
    if ($('preview').open) $('preview').close(); closeDrawer(); showSettings(false); setAssets(true); void setCategory(item.category).catch(report); toast('已定位到对应资产分类'); return;
  }
  openMenu(button, `<div class="menu-title">加入资产库</div>${Object.entries(types).map(([value, name]) => `<button data-action="add-library" data-id="${key}" data-type="${value}">${name}</button>`).join('')}`);
}
function closeDrawer() { $('resultDrawer').hidden = true; $('drawerBackdrop').hidden = true; }
function jumpToJob(key) {
  const job = data.jobs.find(item => item.id === key); if (!job) return;
  if ($('preview').open) $('preview').close(); closeDrawer(); closeMenu(); changeThread(job.threadId);
  const node = $(`job-${job.id}`); node?.scrollIntoView({ block: 'center' }); node?.classList.add('highlight'); setTimeout(() => node?.classList.remove('highlight'), 1800);
}
function reuseJob(key, reselect = false) {
  const job = data.jobs.find(item => item.id === key); if (!job) return;
  if (readParts().some(part => part.type === 'asset' || part.text.trim())) saveDraft();
  if ($('preview').open) $('preview').close(); closeDrawer(); closeMenu();
  if (current !== job.threadId) changeThread(job.threadId);
  showSettings(false); refs = job.references.map(item => item.id); ratio = job.ratio; resolution = job.resolution || 'standard';
  writeParts(job.parts); renderRefs(); renderImageOptions(); saveDraft(); renderAssets();
  if (reselect) setAssets(true); $('prompt').focus();
}
function rename(kind, key) {
  closeMenu(); renameTarget = { kind, key };
  $('renameTitle').textContent = kind === 'assets' ? '重命名资产' : '重命名任务';
  $('renameInput').value = (kind === 'assets' ? asset(key) : thread(key)).name; $('renameDialog').showModal(); $('renameInput').select();
}
async function send() {
  if (sending) return;
  const parts = readParts();
  if (!parts.some(part => part.type === 'asset' || part.text.trim())) return toast('先写下你的创作指令');
  if (!data.configured) { showSettings(true); return toast('请先配置 API 服务', true); }
  sending = true; $('sendButton').disabled = true;
  try {
    if (!current) {
      const entry = await request('/api/threads', {}); current = entry.id; sessionStorage.setItem('studio-thread', current); data.threads.push(entry);
    }
    const job = await request('/api/jobs', { threadId: current, parts, referenceIds: [...refs], ratio, resolution });
    data.jobs.push(job); delete drafts.new; saveDraft(); renderRefs();
    lastRendered = ''; render(); $('timeline').scrollTop = $('timeline').scrollHeight;
  } catch (error) { $('composerStatus').textContent = error.message; $('composerStatus').classList.add('error'); toast(error.message, true); }
  finally { sending = false; $('sendButton').disabled = false; $('prompt').focus(); }
}
async function importFiles(files, type) {
  if (importing) return toast('正在导入上一组图片，请稍候');
  if (!files.length) return;
  importing = true; let count = 0;
  try {
    showSettings(false); setAssets(true); await setCategory(type);
    for (const file of files) {
      $('importStatus').textContent = `正在导入 ${count + 1} / ${files.length}…`;
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} 超过 25 MB`, true); continue; }
      try {
        const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        await request('/api/assets/import', { name: file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '图片', category: type, data: encoded }); count++;
      } catch (error) { toast(`${file.name}：${error.message || '读取失败'}`, true); }
    }
    await refresh(true); toast(`已导入 ${count} 张图片${count < files.length ? `，${files.length - count} 张未成功` : ''}`);
  } finally { importing = false; $('importStatus').textContent = '也可拖入图片，选择分类导入'; $('fileInput').value = ''; }
}

document.addEventListener('selectionchange', () => {
  const cursor = getSelection(); if (cursor?.rangeCount && $('prompt').contains(cursor.anchorNode)) selection = cursor.getRangeAt(0).cloneRange();
});
$('prompt').addEventListener('input', event => { if (event.data?.includes('@')) { showSettings(false); setAssets(true); } saveDraft(); });
$('prompt').addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); document.execCommand('insertText', false, text); });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } });
$('sendButton').onclick = send;
$('clearReferences').onclick = () => {
  refs = [];
  $('prompt').querySelectorAll('[data-asset-id]').forEach(node => node.remove());
  selection = null;
  renderRefs(); renderAssets(); saveDraft();
  $('prompt').focus();
};
$('settingsNav').onclick = () => showSettings(true);
$('studioNav').onclick = () => showSettings(false);
$('assetsNav').onclick = () => { showSettings(false); setAssets(!assetsOpen); };
$('referenceButton').onclick = () => setAssets(true);
$('tasksNav').onclick = () => {
  if (innerWidth < 1020) { setAssets(false); $('app').classList.toggle('tasks-open'); }
  else $('threadPanel').hidden = !$('threadPanel').hidden;
  $('tasksNav').setAttribute('aria-expanded', getComputedStyle($('threadPanel')).display !== 'none');
};
$('newThread').onclick = () => changeThread(null);
$('threadTitle').onclick = () => { if (current) rename('threads', current); };
$('tagFilter').onchange = event => { filter = event.target.value; renderAssets(); };
$('ratioButton').onclick = event => openMenu(event.currentTarget, '<div class="menu-title">图片比例</div>' + data.ratios.map(value => `<button data-action="ratio" data-value="${value}">${value === ratio ? '✓ ' : ''}${value}</button>`).join(''));
$('resolutionButton').onclick = event => openMenu(event.currentTarget, '<div class="menu-title">分辨率 · 当前比例 ' + escape(ratio) + '</div>' + (data.imageOptions?.resolutions || []).filter(item => item.sizes[ratio]).map(item => `<button data-action="resolution" data-value="${item.id}">${item.id === resolution ? '✓ ' : ''}${escape(resolutionDisplayLabel(item))}</button>`).join('') + '<div class="menu-title">2K 可能增加费用和生成耗时</div>');
$('importButton').onclick = () => { const parent = $('importButton').parentElement; parent.classList.toggle('open'); $('importButton').setAttribute('aria-expanded', parent.classList.contains('open')); };
let importCategory = 'model';
$('fileInput').onchange = () => void importFiles([...$('fileInput').files], importCategory).catch(report);
$('allResults').onclick = () => { $('resultDrawer').hidden = false; $('drawerBackdrop').hidden = false; $('closeResults').focus(); };
$('closeResults').onclick = () => { closeDrawer(); $('allResults').focus(); };
$('drawerBackdrop').onclick = closeDrawer;
$('closePreview').onclick = () => $('preview').close();
$('preview').addEventListener('click', event => { if (event.target === $('preview')) $('preview').close(); });
$('preview').addEventListener('close', () => { previewId = null; closeMenu(); });
$('cancelRename').onclick = () => $('renameDialog').close();
$('renameForm').onsubmit = async event => {
  event.preventDefault();
  try { await request(`/api/${renameTarget.kind}/${renameTarget.key}`, { name: $('renameInput').value }); $('renameDialog').close(); await refresh(true); toast('名称已更新'); }
  catch (error) { report(error); }
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeDrawer(); $('dropOverlay').hidden = true; } });
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-category]');
  if (tab) return void setCategory(tab.dataset.category).catch(report);
  const importer = event.target.closest('[data-import]');
  if (importer) { importCategory = importer.dataset.import; $('fileInput').click(); $('importButton').parentElement.classList.remove('open'); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id: key } = button.dataset;
  try {
    switch (action) {
      case 'open-assets': showSettings(false); setAssets(true); break;
      case 'close-assets': setAssets(false); break;
      case 'close-tasks': $('app').classList.remove('tasks-open'); if (innerWidth >= 1020) $('threadPanel').hidden = true; break;
      case 'settings': showSettings(true); break;
      case 'thread': changeThread(key); break;
      case 'reference': addReference(key); break;
      case 'insert-reference': insertReference(key); break;
      case 'remove-reference': removeReference(key); break;
      case 'preview-reference': $('preview').close(); closeDrawer(); addReference(key); break;
      case 'asset-menu': showAssetMenu(button, key); break;
      case 'preview': openPreview(key); break;
      case 'tags': showTags(button, key); break;
      case 'rename-asset': rename('assets', key); break;
      case 'remove-asset': {
        closeMenu(); const previousCategory = asset(key).category;
        await request(`/api/assets/${key}`, { inLibrary: false }); await refresh(true);
        toast('已从资产库移除，原图和历史引用仍保留', false, async () => { await request(`/api/assets/${key}/library`, { category: previousCategory }); await refresh(true); toast('已恢复到资产库'); }); break;
      }
      case 'library': chooseLibrary(button, key); break;
      case 'add-library': closeMenu(); await request(`/api/assets/${key}/library`, { category: button.dataset.type }); await refresh(true); if (previewId) openPreview(previewId); toast('已加入资产'); break;
      case 'ratio': ratio = button.dataset.value; renderImageOptions(); closeMenu(); saveDraft(); break;
      case 'resolution': resolution = button.dataset.value; renderImageOptions(); closeMenu(); saveDraft(); break;
      case 'cancel': await request(`/api/jobs/${key}/cancel`, {}); await refresh(true); break;
      case 'retry': {
        if (retrying.has(key)) break;
        retrying.add(key); button.disabled = true; button.textContent = '正在重新发送…';
        try {
          const retried = await request(`/api/jobs/${key}/retry`, {});
          await refresh(true); jumpToJob(retried.id); toast('已重新发送，原记录中可查看重试任务');
        } finally { retrying.delete(key); lastRendered = ''; renderTimeline(); }
        break;
      }
      case 'reuse': reuseJob(key); break;
      case 'reselect': reuseJob(key, true); break;
      case 'jump': jumpToJob(key); break;
    }
  } catch (error) { report(error); button.disabled = false; }
});
document.addEventListener('change', async event => {
  const checkbox = event.target.closest('[data-tag]'); if (!checkbox) return;
  const item = asset(checkbox.dataset.asset);
  const controls = [...$('contextMenu').querySelectorAll('input,button')];
  controls.forEach(control => { control.disabled = true; });
  const values = checkbox.checked ? [...item.tags, checkbox.dataset.tag] : item.tags.filter(key => key !== checkbox.dataset.tag);
  try { await request(`/api/assets/${item.id}`, { tags: values }); await refresh(true); }
  catch (error) { checkbox.checked = !checkbox.checked; report(error); } finally { controls.forEach(control => { control.disabled = false; }); }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'tagForm') return;
  event.preventDefault(); const form = event.target; const item = asset(form.dataset.asset); const button = form.querySelector('button'); button.disabled = true;
  try {
    const tag = await request('/api/tags', { name: form.elements.name.value, category: item.category });
    await request(`/api/assets/${item.id}`, { tags: [...item.tags, tag.id] }); await refresh(true); closeMenu(); toast('标签已创建并添加');
  } catch (error) { report(error); } finally { button.disabled = false; }
});
let dragDepth = 0;
// Browser image drags can include Files; only external files should be imported.
document.addEventListener('dragstart', event => { if (event.target?.closest?.('img')) event.preventDefault(); });
document.addEventListener('dragenter', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
document.addEventListener('dragleave', event => { if (event.dataTransfer.types.includes('Files') && --dragDepth <= 0) { $('dropOverlay').hidden = true; dragDepth = 0; } });
document.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); const zone = event.target.closest('[data-drop]'); event.dataTransfer.dropEffect = zone ? 'copy' : 'none';
  document.querySelectorAll('[data-drop]').forEach(item => item.classList.toggle('over', item === zone));
});
document.addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const zone = event.target.closest('[data-drop]');
  if (zone) void importFiles([...event.dataTransfer.files], zone.dataset.drop).catch(report);
  else toast('请把图片拖到模特、服装或场景区域');
});

initSettings({ request, saved: () => { void refresh(true).catch(report); toast('API 设置已保存'); } });
try {
  data = await request('/api/state'); category = data.category;
  if (current && !thread(current)) current = null;
  restoreDraft(); render(); showSettings(false);
} catch (error) { report(error); $('timeline').innerHTML = '<div class="empty"><p>无法连接本地服务，请刷新重试。</p></div>'; }
setInterval(() => { if (!document.hidden) void refresh().catch(error => { $('composerStatus').textContent = error.message; }); }, 1600);
window.addEventListener('beforeunload', saveDraft);
