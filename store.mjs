import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const categories = { model: '模特', clothing: '服装', scene: '场景' };
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function required(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(`${label}不能为空，且最多 ${max} 字。`);
  return value.trim();
}
export function category(value) { if (!Object.hasOwn(categories, value)) throw fail('请选择模特、服装或场景。'); return value; }

export async function createStore(dir) {
  await mkdir(path.join(dir, 'images'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, 'studio.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))');
  const query = db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid');
  const one = db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
  const save = db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data');
  const all = kind => query.all(kind).map(row => JSON.parse(row.data));
  const get = (kind, key) => { const row = one.get(kind, key); if (!row) throw fail('未找到这条记录。', 404); return JSON.parse(row.data); };
  const put = (kind, value) => { save.run(kind, value.id, JSON.stringify(value)); return value; };
  function transaction(fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  async function image(bytes, fields = {}) {
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw fail('图片为空或超过 25 MB。');
    let metadata, thumbnail;
    try {
      const source = sharp(bytes, { limitInputPixels: 80_000_000 });
      metadata = await source.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error();
      thumbnail = await source.rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch { throw fail('请使用有效的静态 PNG、JPG 或 WebP 图片（不超过 8000 万像素）。'); }
    const assetId = id();
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    const asset = { id: assetId, name: `图片-${assetId.slice(0, 6)}`, category: null, inLibrary: false, tags: [], createdAt: now(), libraryAt: null, version: 1, width: metadata.width, height: metadata.height, extension, mime: `image/${metadata.format}`, file: `images/${assetId}.${extension}`, thumbFile: `images/${assetId}-thumb.webp`, ...fields };
    await writeFile(path.join(dir, asset.file), bytes, { mode: 0o600 });
    await writeFile(path.join(dir, asset.thumbFile), thumbnail, { mode: 0o600 });
    return asset;
  }
  const publicAsset = asset => { const { file, thumbFile, ...safe } = asset; return { ...safe, url: `/media/${asset.id}`, thumb: `/media/${asset.id}?thumb=1` }; };
  const readImage = asset => readFile(path.join(dir, asset.file));
  function addToLibrary(asset, type) {
    if (asset.inLibrary) return asset;
    asset.category = category(type); asset.inLibrary = true; asset.libraryAt = now();
    if (!asset.name || asset.name.startsWith('图片-') || asset.name.startsWith('生成结果')) asset.name = `${categories[type]}-${asset.libraryAt.replace(/[-:TZ.]/g, '').slice(0, 12)}`;
    return put('assets', asset);
  }
  return { db, dir, all, get, put, transaction, image, publicAsset, readImage, addToLibrary };
}
