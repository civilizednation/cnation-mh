// 화면 전환(서재 → 권 선택 → 뷰어), 책갈피 목록, API 키 설정

import * as store from "./store.js";
import { resolveApiKey, hasApiKey, listVolumes, listFolder, thumbnailUrl, collator } from "./drive.js";
import { Reader } from "./reader.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  library: null,
  works: new Map(),
  volumes: new Map(), // workId -> Promise<volume[]>
};

/* 공통 UI */

let toastTimer;
function toast(message, duration = 2200) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), duration);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.hidden = screen.id !== id;
  });
  document.body.dataset.screen = id;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function formatDate(time) {
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time);
}

function formatSize(bytes) {
  if (!bytes) return "";
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)}GB` : `${Math.round(bytes / 1048576)}MB`;
}

function positionText(record) {
  if (!record) return "";
  const half = record.half ? " (뒤쪽)" : "";
  return `${record.volumeLabel} · ${record.page + 1}${record.pageCount ? ` / ${record.pageCount}` : ""}쪽${half}`;
}

function readerHash(workId, volumeId, pos = {}) {
  const query = pos.page !== undefined ? `?p=${pos.page + 1}${pos.half ? "&h=1" : ""}` : "";
  return `#/r/${encodeURIComponent(workId)}/${encodeURIComponent(volumeId)}${query}`;
}

function coverSource(work) {
  const cached = store.getCachedCover(work.id);
  if (cached) return cached;
  if (work.cover?.id) return thumbnailUrl(work.cover.id, work.cover.resourceKey, 400);
  return "";
}

function coverElement(work, className = "cover") {
  const src = coverSource(work);
  const el = h("div", { class: className, style: `--work-color: ${work.color || "#455a64"}` });
  const fallback = h("div", { class: "cover-fallback" }, h("span", {}, work.title), work.subtitle ? h("small", {}, work.subtitle) : null);
  el.append(fallback);
  if (src) {
    const img = h("img", { src, alt: "", loading: "lazy", draggable: "false" });
    img.addEventListener("load", () => el.classList.add("has-image"));
    img.addEventListener("error", () => img.remove());
    el.append(img);
  }
  return el;
}

/* 권 목록 불러오기 */

function getVolumes(work, { force = false } = {}) {
  if (!force && state.volumes.has(work.id)) return state.volumes.get(work.id);
  const cached = !force && store.getCachedVolumes(work.id);
  const promise = cached
    ? Promise.resolve(cached)
    : listVolumes(work).then((volumes) => {
        store.setCachedVolumes(work.id, volumes);
        return volumes;
      });
  promise.catch(() => state.volumes.delete(work.id));
  state.volumes.set(work.id, promise);
  return promise;
}

// 표지가 없는 이미지 폴더 작품은 첫 권 첫 장을 표지로 기억
async function ensureCover(work, volumes) {
  if (work.cover || store.getCachedCover(work.id)) return;
  const first = volumes.find((v) => v.kind === "folder");
  if (!first || first !== volumes[0]) return;
  try {
    const files = await listFolder(first.id, first.resourceKey);
    const image = files
      .filter((f) => f.mimeType?.startsWith("image/"))
      .sort((a, b) => collator.compare(a.name, b.name))[0];
    if (image) {
      store.setCachedCover(work.id, thumbnailUrl(image.id, image.resourceKey, 400));
      const hero = document.querySelector("#work-hero .cover");
      if (hero && !hero.querySelector("img")) hero.replaceWith(coverElement(work));
    }
  } catch {
    // 표지는 없어도 됨
  }
}

/* 서재 */

function renderLibrary() {
  showScreen("library-screen");
  document.title = "CNATION 만화";

  const recent = store.recentWorks().filter((r) => state.works.has(r.workId)).slice(0, 3);
  const panel = $("#continue-panel");
  panel.replaceChildren();
  if (recent.length) {
    panel.append(
      h("h2", { class: "section-title" }, "이어 보기"),
      h(
        "div",
        { class: "continue-list" },
        recent.map((record) => {
          const work = state.works.get(record.workId);
          const percent = record.pageCount ? Math.round(((record.page + 1) / record.pageCount) * 100) : 0;
          return h(
            "a",
            { class: "continue-card", href: readerHash(work.id, record.volumeId, record) },
            coverElement(work, "cover cover-small"),
            h(
              "div",
              { class: "continue-copy" },
              h("strong", {}, work.title),
              h("span", {}, positionText(record)),
              h("div", { class: "progress" }, h("i", { style: `width:${percent}%` })),
              h("small", {}, `${formatDate(record.updatedAt)} 읽음`),
            ),
            h("span", { class: "continue-go", "aria-hidden": "true" }, "이어 보기 ›"),
          );
        }),
      ),
    );
  }

  $("#work-grid").replaceChildren(
    ...state.library.works.map((work) => {
      const { last } = store.getWorkProgress(work.id);
      const bookmarks = store.getBookmarks(work.id).length;
      return h(
        "a",
        { class: "work-card", href: `#/w/${encodeURIComponent(work.id)}` },
        coverElement(work),
        h(
          "div",
          { class: "work-copy" },
          h("strong", {}, work.title),
          work.subtitle ? h("small", {}, work.subtitle) : null,
          h("span", { class: last ? "work-status is-reading" : "work-status" }, last ? positionText(last) : "아직 읽지 않음"),
          bookmarks ? h("span", { class: "work-bookmarks" }, `책갈피 ${bookmarks}`) : null,
        ),
      );
    }),
  );
}

/* 작품: 권 선택 */

async function renderWork(workId, { force = false } = {}) {
  const work = state.works.get(workId);
  if (!work) {
    location.hash = "#/";
    return;
  }
  showScreen("work-screen");
  document.title = `${work.title} · CNATION 만화`;
  $("#work-title").textContent = work.title;
  $("#work-screen").dataset.workId = work.id;

  const grid = $("#volume-grid");
  const hero = $("#work-hero");
  $("#volume-count").textContent = "";
  hero.replaceChildren(
    coverElement(work),
    h("div", { class: "hero-copy" }, h("h2", {}, work.title), work.subtitle ? h("p", {}, work.subtitle) : null, h("p", { class: "muted" }, "권 목록을 불러오는 중…")),
  );
  grid.replaceChildren(...Array.from({ length: 8 }, () => h("div", { class: "volume-tile is-skeleton" })));

  let volumes;
  try {
    volumes = await getVolumes(work, { force });
  } catch (error) {
    if ($("#work-screen").dataset.workId !== work.id) return;
    grid.replaceChildren(
      h(
        "div",
        { class: "error-box" },
        h("p", {}, error.message),
        h(
          "div",
          { class: "status-actions" },
          h("button", { class: "primary-btn", type: "button", onclick: () => renderWork(work.id, { force: true }) }, "다시 시도"),
          h("a", { class: "text-btn", href: "#/setup" }, "API 키 설정"),
        ),
      ),
    );
    hero.querySelector(".muted").textContent = "권 목록을 불러오지 못했습니다.";
    return;
  }
  if ($("#work-screen").dataset.workId !== work.id || $("#work-screen").hidden) return;

  const progress = store.getWorkProgress(work.id);
  const last = progress.last && volumes.find((v) => v.id === progress.last.volumeId) ? progress.last : null;
  const doneCount = volumes.filter((v) => progress.volumes[v.id]?.done).length;
  const first = volumes[0];

  hero.replaceChildren(
    coverElement(work),
    h(
      "div",
      { class: "hero-copy" },
      h("h2", {}, work.title),
      work.subtitle ? h("p", {}, work.subtitle) : null,
      h("p", { class: "muted" }, `전체 ${volumes.length}권 · 완독 ${doneCount}권`),
      h(
        "div",
        { class: "hero-actions" },
        last
          ? h("a", { class: "primary-btn", href: readerHash(work.id, last.volumeId, last) }, `이어 보기 · ${positionText(last)}`)
          : first
            ? h("a", { class: "primary-btn", href: readerHash(work.id, first.id, { page: 0 }) }, `${first.label}부터 읽기`)
            : null,
        h("button", { class: "text-btn", type: "button", onclick: () => openBookmarks(work) }, `책갈피 ${store.getBookmarks(work.id).length}`),
      ),
    ),
  );
  $("#volume-count").textContent = `${volumes.length}권`;

  if (!volumes.length) {
    grid.replaceChildren(h("div", { class: "error-box" }, h("p", {}, "이 폴더에서 권(하위 폴더나 ZIP 파일)을 찾지 못했습니다.")));
    return;
  }

  grid.replaceChildren(
    ...volumes.map((volume) => {
      const record = progress.volumes[volume.id];
      const percent = record?.pageCount ? Math.round(((record.page + 1) / record.pageCount) * 100) : 0;
      let status = "";
      if (record?.done) status = "완독";
      else if (record) status = `${record.page + 1} / ${record.pageCount}쪽`;
      const isLast = last?.volumeId === volume.id;
      return h(
        "a",
        {
          class: `volume-tile${record?.done ? " is-done" : ""}${isLast ? " is-last" : ""}`,
          href: readerHash(work.id, volume.id),
          title: volume.name,
        },
        h("strong", { class: "volume-number" }, volume.number !== null ? volume.number : "·"),
        h("span", { class: "volume-name" }, /^\d+$/.test(volume.name) ? volume.label : volume.name),
        h("span", { class: "volume-meta" }, volume.kind === "zip" ? `ZIP ${formatSize(volume.size)}` : "이미지"),
        status ? h("span", { class: "volume-status" }, isLast ? `● ${status}` : status) : null,
        record ? h("div", { class: "progress" }, h("i", { style: `width:${record.done ? 100 : percent}%` })) : null,
      );
    }),
  );

  ensureCover(work, volumes);
}

/* 책갈피 목록 */

function openBookmarks(work) {
  const dialog = $("#bookmarks-dialog");
  const list = $("#bookmark-list");
  dialog.querySelector("h2").textContent = `${work.title} 책갈피`;
  const render = () => {
    const bookmarks = store.getBookmarks(work.id);
    if (!bookmarks.length) {
      list.replaceChildren(h("li", { class: "empty" }, "저장한 책갈피가 없습니다.", h("br"), "보는 중에 상단의 책갈피 버튼(B)을 눌러 추가하세요."));
      return;
    }
    list.replaceChildren(
      ...bookmarks.map((bookmark) =>
        h(
          "li",
          { class: "bookmark-item" },
          h(
            "a",
            {
              class: "bookmark-open",
              href: readerHash(work.id, bookmark.volumeId, bookmark),
              onclick: () => dialog.close(),
            },
            h("strong", {}, `${bookmark.volumeLabel} · ${bookmark.page + 1}쪽${bookmark.half ? " (뒤쪽)" : ""}`),
            h("small", {}, `${bookmark.pageCount ? `${bookmark.pageCount}쪽 중 · ` : ""}${formatDate(bookmark.createdAt)}`),
          ),
          h(
            "button",
            {
              class: "icon-btn danger",
              type: "button",
              "aria-label": "책갈피 삭제",
              onclick: () => {
                store.removeBookmark(work.id, bookmark.key);
                render();
                reader.active && reader.updateBookmarkButton();
              },
            },
            "✕",
          ),
        ),
      ),
    );
  };
  render();
  dialog.showModal();
}

/* API 키 설정 */

function renderSetup(message = "") {
  showScreen("setup-screen");
  document.title = "Drive 연결 설정 · CNATION 만화";
  $("#key-input").value = store.getStoredApiKey();
  $("#key-note").textContent = message;
}

/* 뷰어 */

const reader = new Reader({
  toast,
  onBack: (work) => {
    location.hash = work ? `#/w/${encodeURIComponent(work.id)}` : "#/";
  },
  onOpenVolume: (work, volume, pos) => {
    location.hash = readerHash(work.id, volume.id, pos);
  },
  onBookmarks: (work) => openBookmarks(work),
});

async function renderReader(workId, volumeId, params) {
  const work = state.works.get(workId);
  if (!work) {
    location.hash = "#/";
    return;
  }
  showScreen("reader-screen");
  if (reader.volume?.id !== volumeId) {
    // 새 권을 여는 동안 이전 권 화면이 남아 보이지 않도록
    $("#page-label").textContent = "- / -";
    reader.showStatus("불러오는 중…");
  }
  let volumes;
  try {
    volumes = await getVolumes(work);
  } catch (error) {
    toast(error.message, 4000);
    location.hash = `#/w/${encodeURIComponent(work.id)}`;
    return;
  }
  const volume = volumes.find((v) => v.id === volumeId);
  if (!volume) {
    toast("해당 권을 찾을 수 없습니다.");
    location.hash = `#/w/${encodeURIComponent(work.id)}`;
    return;
  }
  document.title = `${work.title} ${volume.label} · CNATION 만화`;

  let start = { page: 0, half: 0 };
  if (params.has("p")) {
    start = { page: Math.max(0, Number(params.get("p")) - 1 || 0), half: params.get("h") === "1" ? 1 : 0 };
  } else {
    const saved = store.getVolumeProgress(work.id, volume.id);
    // 다 읽은 권을 다시 열면 처음부터
    if (saved && !(saved.done && saved.page >= saved.pageCount - 1)) start = { page: saved.page, half: saved.half };
  }
  // 같은 권 안에서 해시만 바뀐 경우(책갈피 이동 등)는 다시 열지 않고 이동
  if (reader.active && reader.volume?.id === volume.id && reader.source) {
    reader.go(start);
    return;
  }
  reader.open(work, volumes, volume, start);
}

/* 라우팅 */

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

function route() {
  const { parts, params } = parseHash();
  if (parts[0] !== "r" && reader.active) reader.close();
  if (parts[0] === "setup") return renderSetup();
  if (!hasApiKey()) return renderSetup("먼저 Google Drive API 키를 설정해 주세요.");
  switch (parts[0]) {
    case "w":
      return renderWork(parts[1]);
    case "r":
      return renderReader(parts[1], parts[2], params);
    default:
      return renderLibrary();
  }
}

/* 시작 */

function bindGlobalEvents() {
  // 모든 시트: 닫기 버튼과 바깥 영역 클릭으로 닫기
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-close]") || event.target === dialog) dialog.close();
    });
  });

  $("#library-settings").addEventListener("click", () => (location.hash = "#/setup"));
  $("#setup-back").addEventListener("click", () => (location.hash = "#/"));
  $("#work-back").addEventListener("click", () => (location.hash = "#/"));
  $("#work-refresh").addEventListener("click", () => {
    const workId = $("#work-screen").dataset.workId;
    store.clearCachedVolumes(workId);
    renderWork(workId, { force: true });
    toast("Drive 에서 권 목록을 새로 불러옵니다");
  });
  $("#work-bookmarks").addEventListener("click", () => {
    const work = state.works.get($("#work-screen").dataset.workId);
    if (work) openBookmarks(work);
  });

  $("#key-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = $("#key-input").value.trim();
    store.setStoredApiKey(value);
    await resolveApiKey();
    state.volumes.clear();
    if (!hasApiKey()) {
      $("#key-note").textContent = "키가 비어 있습니다.";
      return;
    }
    const probe = state.library.works[0];
    $("#key-note").textContent = "연결 확인 중…";
    try {
      await listFolder(probe.folderId, probe.resourceKey);
      toast("Google Drive 에 연결되었습니다");
      location.hash = "#/";
    } catch (error) {
      $("#key-note").textContent = error.message;
    }
  });
  $("#key-clear").addEventListener("click", async () => {
    store.setStoredApiKey("");
    $("#key-input").value = "";
    await resolveApiKey();
    state.volumes.clear();
    $("#key-note").textContent = hasApiKey() ? "이 기기에 저장한 키를 지웠습니다. (배포 설정의 키를 사용합니다)" : "이 기기에 저장한 키를 지웠습니다.";
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("pageshow", (event) => {
    // 뒤로 가기 캐시에서 돌아왔을 때 진행 상황 다시 그리기
    if (event.persisted && !reader.active) route();
  });
}

async function init() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
  try {
    state.library = await fetch("./data/library.json", { cache: "no-cache" }).then((res) => {
      if (!res.ok) throw new Error(`작품 목록을 불러오지 못했습니다 (${res.status})`);
      return res.json();
    });
  } catch (error) {
    document.body.textContent = error.message;
    return;
  }
  state.library.works.forEach((work) => state.works.set(work.id, work));
  await resolveApiKey();
  bindGlobalEvents();
  route();
}

init();
