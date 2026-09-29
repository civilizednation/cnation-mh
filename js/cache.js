// 한 번 받은 ZIP 페이지와 ZIP 목록을 기기(Cache Storage)에 저장해 두는 캐시
// - 같은 권을 다시 열면 네트워크 없이 바로 표시
// - 전체 용량이 한도를 넘으면 가장 오래 안 본 것부터 삭제

const CACHE_NAME = "cnation-mh-pages-v1";
const INDEX_KEY = "cnation-mh.page-cache.v1";
const LIMIT_BYTES = 800 * 1024 * 1024;

const supported = typeof caches !== "undefined" && window.isSecureContext;
let cachePromise = null;
let index = null; // { [key]: [size, lastUsed] }
let saveTimer = null;

function openCache() {
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
  return cachePromise;
}

function loadIndex() {
  if (index) return index;
  try {
    index = JSON.parse(localStorage.getItem(INDEX_KEY)) || {};
  } catch {
    index = {};
  }
  return index;
}

function saveIndexSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      // 무시
    }
  }, 500);
}

function requestFor(key) {
  return new Request(`${location.origin}/__cnation-cache/${encodeURIComponent(key)}`);
}

function touch(key) {
  const entry = loadIndex()[key];
  if (entry) {
    entry[1] = Date.now();
    saveIndexSoon();
  }
}

async function evict() {
  const entries = Object.entries(loadIndex());
  let total = entries.reduce((sum, [, [size]]) => sum + size, 0);
  if (total <= LIMIT_BYTES) return;
  const cache = await openCache();
  entries.sort((a, b) => a[1][1] - b[1][1]);
  for (const [key, [size]] of entries) {
    if (total <= LIMIT_BYTES * 0.9) break;
    await cache.delete(requestFor(key));
    delete index[key];
    total -= size;
  }
  saveIndexSoon();
}

async function put(key, response, size) {
  if (!supported) return;
  try {
    const cache = await openCache();
    await cache.put(requestFor(key), response);
    loadIndex()[key] = [size, Date.now()];
    saveIndexSoon();
    await evict();
  } catch {
    // 저장 공간 부족 등은 무시 (캐시는 없어도 동작)
  }
}

async function match(key) {
  if (!supported || !loadIndex()[key]) return null;
  try {
    const cache = await openCache();
    const response = await cache.match(requestFor(key));
    if (!response) {
      delete index[key];
      return null;
    }
    touch(key);
    return response;
  } catch {
    return null;
  }
}

export async function getBytes(key) {
  const response = await match(key);
  return response ? new Uint8Array(await response.arrayBuffer()) : null;
}

export function putBytes(key, bytes, type = "application/octet-stream") {
  return put(key, new Response(bytes, { headers: { "Content-Type": type } }), bytes.byteLength);
}

export async function getJSON(key) {
  const response = await match(key);
  return response ? response.json() : null;
}

export function putJSON(key, value) {
  const text = JSON.stringify(value);
  return put(key, new Response(text, { headers: { "Content-Type": "application/json" } }), text.length);
}

export function has(key) {
  return supported && Boolean(loadIndex()[key]);
}

export function usageBytes() {
  return Object.values(loadIndex()).reduce((sum, [size]) => sum + size, 0);
}

export async function clearAll() {
  index = {};
  saveIndexSoon();
  if (!supported) return;
  cachePromise = null;
  await caches.delete(CACHE_NAME);
}
