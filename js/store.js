// 이어보기, 책갈피, 보기 설정 등 브라우저(localStorage)에 저장하는 데이터

const PREFIX = "cnation-mh.";

const KEYS = {
  settings: `${PREFIX}settings.v1`,
  progress: `${PREFIX}progress.v1`,
  bookmarks: `${PREFIX}bookmarks.v1`,
  covers: `${PREFIX}covers.v1`,
  apiKey: `${PREFIX}api-key`,
  volumes: (workId) => `${PREFIX}volumes.${workId}.v1`,
};

const VOLUME_CACHE_TTL = 12 * 60 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  mode: "single", // single | double | split | scroll
  direction: "rtl", // rtl(오른쪽→왼쪽, 만화 원작) | ltr
  fit: "contain", // contain(화면 맞춤) | width(너비 맞춤)
  quality: "high", // normal | high | original
  coverAlone: true, // 두 페이지 보기에서 첫 장(표지)을 따로 표시
  splitRule: "wide", // wide(가로로 긴 이미지만 자르기) | all(모든 이미지 자르기)
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 공간이 없거나 사생활 보호 모드인 경우 조용히 무시
  }
}

/* 설정 */

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) };
}

export function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  save(KEYS.settings, next);
  return next;
}

/* API 키 (이 브라우저에만 저장) */

export function getStoredApiKey() {
  try {
    return localStorage.getItem(KEYS.apiKey) || "";
  } catch {
    return "";
  }
}

export function setStoredApiKey(value) {
  try {
    if (value) localStorage.setItem(KEYS.apiKey, value);
    else localStorage.removeItem(KEYS.apiKey);
  } catch {
    // 무시
  }
}

/* 이어보기 */

// 구조: { [workId]: { last: {...}, volumes: { [volumeId]: {...} } } }
function allProgress() {
  return load(KEYS.progress, {});
}

export function getWorkProgress(workId) {
  const entry = allProgress()[workId];
  return entry || { last: null, volumes: {} };
}

export function getVolumeProgress(workId, volumeId) {
  return getWorkProgress(workId).volumes[volumeId] || null;
}

export function saveProgress(workId, volume, position, pageCount) {
  const all = allProgress();
  const entry = all[workId] || { last: null, volumes: {} };
  const record = {
    volumeId: volume.id,
    volumeLabel: volume.label,
    page: position.page,
    half: position.half || 0,
    pageCount,
    done: position.page >= pageCount - 1,
    updatedAt: Date.now(),
  };
  const previous = entry.volumes[volume.id];
  // 한 번 완독한 권은 다시 앞부분을 봐도 완독 표시 유지
  if (previous?.done) record.done = true;
  entry.volumes[volume.id] = record;
  entry.last = record;
  all[workId] = entry;
  save(KEYS.progress, all);
  return record;
}

export function markVolumeDone(workId, volume, pageCount) {
  const all = allProgress();
  const entry = all[workId] || { last: null, volumes: {} };
  const record = entry.volumes[volume.id] || {
    volumeId: volume.id,
    volumeLabel: volume.label,
    page: pageCount - 1,
    half: 0,
    pageCount,
  };
  record.done = true;
  record.updatedAt = Date.now();
  entry.volumes[volume.id] = record;
  all[workId] = entry;
  save(KEYS.progress, all);
}

export function clearVolumeProgress(workId, volumeId) {
  const all = allProgress();
  const entry = all[workId];
  if (!entry) return;
  delete entry.volumes[volumeId];
  if (entry.last?.volumeId === volumeId) {
    const rest = Object.values(entry.volumes).sort((a, b) => b.updatedAt - a.updatedAt);
    entry.last = rest[0] || null;
  }
  save(KEYS.progress, all);
}

// 서재 화면의 "최근 읽은 작품" 순서
export function recentWorks() {
  return Object.entries(allProgress())
    .filter(([, entry]) => entry.last)
    .map(([workId, entry]) => ({ workId, ...entry.last }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* 책갈피 */

export function bookmarkKey(volumeId, page, half = 0) {
  return `${volumeId}:${page}:${half}`;
}

export function getBookmarks(workId) {
  return load(KEYS.bookmarks, {})[workId] || [];
}

function saveBookmarks(workId, list) {
  const all = load(KEYS.bookmarks, {});
  all[workId] = list;
  save(KEYS.bookmarks, all);
}

export function hasBookmark(workId, volumeId, page, half) {
  const key = bookmarkKey(volumeId, page, half);
  return getBookmarks(workId).some((b) => b.key === key);
}

// 있으면 지우고, 없으면 추가. 추가되었으면 true
export function toggleBookmark(workId, volume, page, half, pageCount) {
  const key = bookmarkKey(volume.id, page, half);
  const list = getBookmarks(workId);
  const index = list.findIndex((b) => b.key === key);
  if (index >= 0) {
    list.splice(index, 1);
    saveBookmarks(workId, list);
    return false;
  }
  list.unshift({
    key,
    volumeId: volume.id,
    volumeLabel: volume.label,
    page,
    half: half || 0,
    pageCount,
    createdAt: Date.now(),
  });
  saveBookmarks(workId, list);
  return true;
}

export function removeBookmark(workId, key) {
  saveBookmarks(
    workId,
    getBookmarks(workId).filter((b) => b.key !== key),
  );
}

/* 표지 캐시 */

export function getCachedCover(workId) {
  return load(KEYS.covers, {})[workId] || null;
}

export function setCachedCover(workId, dataUrl) {
  const all = load(KEYS.covers, {});
  all[workId] = dataUrl;
  save(KEYS.covers, all);
}

/* 권 목록 캐시 (Drive API 호출 줄이기) */

export function getCachedVolumes(workId, { allowStale = false } = {}) {
  const cached = load(KEYS.volumes(workId), null);
  if (!cached) return null;
  if (!allowStale && Date.now() - cached.at > VOLUME_CACHE_TTL) return null;
  return cached.volumes;
}

export function setCachedVolumes(workId, volumes) {
  save(KEYS.volumes(workId), { at: Date.now(), volumes });
}

export function clearCachedVolumes(workId) {
  try {
    localStorage.removeItem(KEYS.volumes(workId));
  } catch {
    // 무시
  }
}
