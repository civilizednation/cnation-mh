// Google Drive 연동: 폴더 목록, 권 목록, 페이지 이미지 불러오기

import { getStoredApiKey } from "./store.js";
import { ZipReader } from "./zip.js";
import * as pageCache from "./cache.js";

const API = "https://www.googleapis.com/drive/v3";
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const ARCHIVE_EXT = /\.(zip|cbz)$/i;
const ARCHIVE_MIME = new Set(["application/zip", "application/x-zip-compressed", "application/x-cbz", "application/vnd.comicbook+zip"]);
const FOLDER_MIME = "application/vnd.google-apps.folder";

export const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

/* 인증
 * - 배포(Vercel): /api/token 이 서비스 계정으로 1시간짜리 읽기 전용 토큰을 발급
 *   → 브라우저는 그 토큰으로 Google Drive 에서 직접 받음 (비밀 키는 서버에만 있음)
 * - 로컬 테스트: config.js 나 설정 화면에 넣은 API 키를 사용
 */

let auth = { mode: "none" }; // { mode: "token", token, expiresAt } | { mode: "key", key }
let authProblem = "";
let tokenPromise = null;

async function requestToken() {
  const res = await fetch("./api/token", { cache: "no-store" });
  let json = {};
  try {
    json = await res.json();
  } catch {
    // 정적 서버에는 /api/token 이 없음
  }
  if (res.ok && json.accessToken) return { mode: "token", token: json.accessToken, expiresAt: json.expiresAt };
  if (res.ok && json.apiKey) return { mode: "key", key: json.apiKey };
  throw new Error(json.error || "Google Drive 연결 정보가 없습니다.");
}

export async function resolveAuth() {
  authProblem = "";
  const stored = getStoredApiKey();
  if (stored) return (auth = { mode: "key", key: stored });
  const fromFile = window.CNATION_CONFIG?.googleApiKey;
  if (fromFile) return (auth = { mode: "key", key: fromFile });
  try {
    auth = await requestToken();
  } catch (error) {
    auth = { mode: "none" };
    authProblem = error.message;
  }
  return auth;
}

export function hasAuth() {
  return auth.mode !== "none";
}

export function getAuthProblem() {
  return authProblem;
}

async function refreshToken() {
  if (!tokenPromise) {
    tokenPromise = requestToken()
      .then((next) => (auth = next))
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

// Drive API 요청: 인증 붙이기, 토큰 만료 전 갱신, 401 이면 한 번 새 토큰으로 재시도
async function driveFetch(url, { headers = {}, signal, retried = false } = {}) {
  if (auth.mode === "none") throw new DriveError("Google Drive 연결이 설정되지 않았습니다.", 0);
  if (auth.mode === "token" && auth.expiresAt - Date.now() < 5 * 60 * 1000) await refreshToken();
  const target = new URL(url);
  const finalHeaders = { ...headers };
  if (auth.mode === "token") finalHeaders.Authorization = `Bearer ${auth.token}`;
  else target.searchParams.set("key", auth.key);
  const res = await fetch(target, { headers: finalHeaders, signal });
  if (res.status === 401 && auth.mode === "token" && !retried) {
    await refreshToken();
    return driveFetch(url, { headers, signal, retried: true });
  }
  return res;
}

/* 공통 */

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function toDriveError(res) {
  let reason = "";
  let raw = "";
  try {
    const json = await res.json();
    reason = json.error?.errors?.[0]?.reason || json.error?.status || "";
    raw = json.error?.message || "";
  } catch {
    // 본문이 JSON 이 아님
  }
  const text = `${reason} ${raw}`;
  let message = `Google Drive 요청 실패 (${res.status})`;
  if (/keyInvalid|API key not valid|API_KEY_INVALID/i.test(text)) {
    message = "API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.";
  } else if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(text)) {
    message = "Google Cloud 프로젝트에서 Google Drive API 를 '사용 설정'해 주세요.";
  } else if (/referer|referrer/i.test(text)) {
    message = "API 키의 웹사이트 제한(HTTP 리퍼러)에 지금 주소를 추가해 주세요.";
  } else if (/downloadQuotaExceeded|quota/i.test(text)) {
    message = "Google Drive 다운로드 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.";
  } else if (res.status === 404 || /notFound/i.test(text)) {
    message = "Drive 에서 찾을 수 없습니다. 작품 폴더가 서비스 계정 이메일(또는 '링크가 있는 모든 사용자')에 공유되었는지 확인해 주세요.";
  } else if (res.status === 401) {
    message = "Google Drive 인증이 만료되었습니다. 앱을 새로고침해 주세요.";
  } else if (raw) {
    message = `${message}: ${raw}`;
  }
  return new DriveError(message, res.status);
}

function resourceKeyHeaders(id, resourceKey) {
  return resourceKey ? { "X-Goog-Drive-Resource-Keys": `${id}/${resourceKey}` } : {};
}

function isFolder(file) {
  return file.mimeType === FOLDER_MIME;
}

function isImage(file) {
  return file.mimeType?.startsWith("image/") || IMAGE_EXT.test(file.name);
}

function isArchive(file) {
  return ARCHIVE_EXT.test(file.name) || ARCHIVE_MIME.has(file.mimeType);
}

/* 폴더 목록 */

export async function listFolder(folderId, resourceKey) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, resourceKey, imageMediaMetadata(width, height))",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch(`${API}/files?${params}`, { headers: resourceKeyHeaders(folderId, resourceKey) });
    if (!res.ok) throw await toDriveError(res);
    const json = await res.json();
    files.push(...(json.files || []));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return files;
}

/* 권 목록 */

function volumeNumber(name) {
  const base = name.replace(/\.[^.]+$/, "");
  const match = base.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function toVolume(file, kind) {
  const number = volumeNumber(file.name);
  return {
    id: file.id,
    name: file.name.replace(ARCHIVE_EXT, ""),
    resourceKey: file.resourceKey || "",
    kind,
    size: file.size ? Number(file.size) : 0,
    number,
    label: number !== null ? `${number}권` : file.name.replace(ARCHIVE_EXT, ""),
  };
}

export async function listVolumes(work) {
  const files = await listFolder(work.folderId, work.resourceKey);
  const volumes = [];
  for (const file of files) {
    if (isFolder(file)) volumes.push(toVolume(file, "folder"));
    else if (isArchive(file)) volumes.push(toVolume(file, "zip"));
  }
  // 작품 폴더에 이미지가 바로 들어 있으면 그 자체를 한 권으로 취급
  if (files.some(isImage)) {
    volumes.push({
      id: work.folderId,
      name: work.title,
      resourceKey: work.resourceKey || "",
      kind: "folder",
      size: 0,
      number: null,
      label: work.title,
    });
  }
  volumes.sort((a, b) => {
    if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
    return collator.compare(a.name, b.name);
  });
  return volumes;
}

/* 이미지 주소 */

const QUALITY_WIDTH = { normal: 1600, high: 2560 };

export function thumbnailUrl(id, resourceKey, width = 1600) {
  const rk = resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : "";
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}${rk}`;
}

function lh3Url(id, resourceKey) {
  const rk = resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : "";
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}${rk}`;
}

function mediaUrl(id) {
  return `${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
}

async function fetchMediaBlob(id, resourceKey) {
  const res = await driveFetch(mediaUrl(id), { headers: resourceKeyHeaders(id, resourceKey) });
  if (!res.ok) throw await toDriveError(res);
  return res.blob();
}

async function decodeImage(url) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return { url, width: img.naturalWidth, height: img.naturalHeight };
}

/* 권 열기 */

const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };

function mimeOf(name) {
  return MIME_BY_EXT[name.split(".").pop().toLowerCase()] || "application/octet-stream";
}

// 동시에 너무 많은 요청을 보내지 않도록 제한
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

class BaseSource {
  constructor() {
    this.pages = [];
    this.cache = new Map(); // index -> Promise<{url,width,height}>
    this.blobUrls = new Set();
    this.closed = false;
  }

  get count() {
    return this.pages.length;
  }

  // 이미 불러온 페이지의 크기 (없으면 null)
  knownSize(index) {
    const page = this.pages[index];
    return page?.width ? { width: page.width, height: page.height } : null;
  }

  load(index) {
    if (index < 0 || index >= this.pages.length) return Promise.reject(new Error("페이지 범위를 벗어났습니다."));
    if (!this.cache.has(index)) {
      const promise = this.loadPage(index).then((result) => {
        const page = this.pages[index];
        page.width = result.width;
        page.height = result.height;
        return result;
      });
      promise.catch(() => this.cache.delete(index));
      this.cache.set(index, promise);
      this.trim(this.focus ?? index);
    }
    return this.cache.get(index);
  }

  // 메모리 절약: 지금 보는 위치(focus)에서 먼 페이지의 blob 은 해제
  trim(center) {
    const keep = 24;
    for (const [index, promise] of this.cache) {
      if (Math.abs(index - center) > keep) {
        this.cache.delete(index);
        promise
          .then((result) => {
            if (result.url.startsWith("blob:")) {
              URL.revokeObjectURL(result.url);
              this.blobUrls.delete(result.url);
            }
          })
          .catch(() => {});
      }
    }
  }

  makeBlobUrl(blob) {
    const url = URL.createObjectURL(blob);
    this.blobUrls.add(url);
    return url;
  }

  close() {
    this.closed = true;
    for (const url of this.blobUrls) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.cache.clear();
  }
}

class FolderSource extends BaseSource {
  constructor(volume, quality) {
    super();
    this.volume = volume;
    this.quality = quality;
  }

  async open(onStatus) {
    onStatus?.("페이지 목록을 불러오는 중…");
    const files = await listFolder(this.volume.id, this.volume.resourceKey);
    let images = files.filter(isImage);

    if (!images.length) {
      const archives = files.filter(isArchive).sort((a, b) => collator.compare(a.name, b.name));
      if (archives.length) {
        // 권 폴더 안에 압축 파일만 있는 경우
        this.delegate = new ZipSource(toVolume(archives[0], "zip"));
        await this.delegate.open(onStatus);
        this.pages = this.delegate.pages;
        return this;
      }
      // 한 단계 아래 폴더까지 모아 보기
      const folders = files.filter(isFolder).sort((a, b) => collator.compare(a.name, b.name));
      for (const folder of folders) {
        const inner = await listFolder(folder.id, folder.resourceKey);
        images.push(...inner.filter(isImage).map((f) => ({ ...f, name: `${folder.name}/${f.name}` })));
      }
    }

    images = images.sort((a, b) => collator.compare(a.name, b.name));
    this.pages = images.map((file) => ({
      id: file.id,
      name: file.name,
      resourceKey: file.resourceKey || "",
      width: file.imageMediaMetadata?.width || 0,
      height: file.imageMediaMetadata?.height || 0,
    }));
    if (!this.pages.length) throw new Error("이 권에서 이미지를 찾지 못했습니다.");
    return this;
  }

  get focus() {
    return this.delegate ? this.delegate.focus : this._focus;
  }

  set focus(value) {
    if (this.delegate) this.delegate.focus = value;
    else this._focus = value;
  }

  knownSize(index) {
    return this.delegate ? this.delegate.knownSize(index) : super.knownSize(index);
  }

  load(index) {
    return this.delegate ? this.delegate.load(index) : super.load(index);
  }

  async loadPage(index) {
    const page = this.pages[index];
    if (this.quality !== "original") {
      const width = QUALITY_WIDTH[this.quality] || QUALITY_WIDTH.high;
      try {
        return await decodeImage(thumbnailUrl(page.id, page.resourceKey, width));
      } catch {
        // 아래 대체 경로 시도
      }
      try {
        return await decodeImage(lh3Url(page.id, page.resourceKey));
      } catch {
        // 아래 대체 경로 시도
      }
    }
    const blob = await fetchMediaBlob(page.id, page.resourceKey);
    return decodeImage(this.makeBlobUrl(blob));
  }

  close() {
    this.delegate?.close();
    super.close();
  }
}

// Range 를 지원하지 않는 응답에서 이보다 큰 파일은 통째로 받지 않음 (휴대폰 메모리 보호)
const FULL_DOWNLOAD_LIMIT = 80 * 1024 * 1024;

class ZipSource extends BaseSource {
  constructor(volume) {
    super();
    this.volume = volume;
    this.full = null;
    this.fullPromise = null;
    this.queue = limiter(4);
  }

  get cachePrefix() {
    return `zip:${this.volume.id}:${this.size}`;
  }

  async open(onStatus) {
    this.onStatus = onStatus;
    let size = this.volume.size;
    if (!size) {
      const params = new URLSearchParams({ fields: "size", supportsAllDrives: "true" });
      const res = await driveFetch(`${API}/files/${encodeURIComponent(this.volume.id)}?${params}`, {
        headers: resourceKeyHeaders(this.volume.id, this.volume.resourceKey),
      });
      if (!res.ok) throw await toDriveError(res);
      size = Number((await res.json()).size);
    }
    this.size = size;

    this.zip = new ZipReader({ size, read: (start, end) => this.read(start, end) });
    // 전에 연 적 있는 권은 저장해 둔 목록을 그대로 사용
    const cachedEntries = await pageCache.getJSON(`${this.cachePrefix}:index`);
    if (cachedEntries?.length) {
      this.zip.entries = cachedEntries;
    } else {
      onStatus?.("압축 파일 목록을 읽는 중…");
      await this.zip.open();
      pageCache.putJSON(`${this.cachePrefix}:index`, this.zip.entries);
    }

    const entries = this.zip.entries
      .filter((entry) => IMAGE_EXT.test(entry.name) && !/(^|\/)(__MACOSX|\.)/.test(entry.name))
      .sort((a, b) => collator.compare(a.name, b.name));
    if (!entries.length) throw new Error("압축 파일 안에서 이미지를 찾지 못했습니다.");
    this.pages = entries.map((entry) => ({ name: entry.name, entry, width: 0, height: 0 }));
    return this;
  }

  async read(start, end) {
    if (this.full) return this.full.subarray(start, end + 1);
    if (this.fullPromise) {
      await this.fullPromise;
      return this.full.subarray(start, end + 1);
    }
    const res = await driveFetch(mediaUrl(this.volume.id), {
      headers: { ...resourceKeyHeaders(this.volume.id, this.volume.resourceKey), Range: `bytes=${start}-${end}` },
    });
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw await toDriveError(res);
    // Range 를 지원하지 않아 전체 파일이 온 경우
    if (this.size > FULL_DOWNLOAD_LIMIT) {
      res.body?.cancel();
      throw new Error(`이 파일(${Math.round(this.size / 1048576)}MB)은 부분 다운로드를 지원하지 않아 열 수 없습니다.`);
    }
    this.fullPromise = this.readWhole(res);
    this.full = await this.fullPromise;
    return this.full.subarray(start, end + 1);
  }

  async readWhole(res) {
    const total = Number(res.headers.get("Content-Length")) || this.size;
    const buffer = new Uint8Array(total);
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer.set(value, received);
      received += value.length;
      const mb = (n) => (n / 1048576).toFixed(1);
      this.onStatus?.(`압축 파일 내려받는 중… ${mb(received)} / ${mb(total)} MB`);
    }
    return buffer.subarray(0, received);
  }

  // 기기 캐시에 있으면 그것을, 없으면 Drive 에서 받아 캐시에 저장
  async pageBytes(index) {
    const { entry } = this.pages[index];
    const key = `${this.cachePrefix}:${entry.localOffset}`;
    const cached = await pageCache.getBytes(key);
    if (cached) return cached;
    const bytes = await this.zip.read(entry);
    pageCache.putBytes(key, bytes, mimeOf(entry.name));
    return bytes;
  }

  loadPage(index) {
    const { entry } = this.pages[index];
    return this.queue(async () => {
      if (this.closed) throw new Error("닫힌 권입니다.");
      const bytes = await this.pageBytes(index);
      const url = this.makeBlobUrl(new Blob([bytes], { type: mimeOf(entry.name) }));
      return decodeImage(url);
    });
  }

  // 화면에 띄우지 않고 캐시에만 받아 두기 (다음 권 미리 준비)
  async prefetch(count) {
    const total = Math.min(count, this.pages.length);
    const jobs = [];
    for (let i = 0; i < total; i += 1) {
      const key = `${this.cachePrefix}:${this.pages[i].entry.localOffset}`;
      if (!pageCache.has(key)) jobs.push(this.queue(() => this.pageBytes(i)));
    }
    await Promise.allSettled(jobs);
  }

  close() {
    super.close();
    this.full = null;
  }
}

export async function openVolume(volume, { quality, onStatus }) {
  const source = volume.kind === "zip" ? new ZipSource(volume) : new FolderSource(volume, quality);
  await source.open(onStatus);
  return source;
}

// 다음 권의 목록과 앞쪽 몇 페이지를 미리 받아 두기
export async function prefetchVolume(volume, { quality, pages = 4 } = {}) {
  if (volume.kind === "zip") {
    const source = new ZipSource(volume);
    try {
      await source.open();
      await source.prefetch(pages);
    } finally {
      source.close();
    }
    return;
  }
  const source = new FolderSource(volume, quality);
  await source.open();
  if (source.delegate) {
    await source.delegate.prefetch(pages);
  } else {
    // 이미지 폴더는 브라우저 HTTP 캐시에 올려 두기
    const width = QUALITY_WIDTH[quality] || QUALITY_WIDTH.high;
    source.pages.slice(0, pages).forEach((page) => {
      new Image().src = thumbnailUrl(page.id, page.resourceKey, width);
    });
  }
  source.close();
}
