// 만화 뷰어: 한 페이지 / 두 페이지 / 반쪽 보기 / 세로 스크롤

import * as store from "./store.js";
import { openVolume, prefetchVolume, thumbnailUrl } from "./drive.js";
import * as pageCache from "./cache.js";
import { snapshot } from "./covers.js";

const $ = (selector) => document.querySelector(selector);

const MODE_NAMES = {
  single: "한 페이지 보기",
  double: "두 페이지 보기",
  split: "반쪽 보기",
  scroll: "세로 스크롤",
};

export const MODE_HINTS = {
  single: "이미지 한 장을 화면에 맞춰 보여 줍니다.",
  double: "두 장을 나란히 펼쳐 보여 줍니다. 가로 화면의 태블릿·PC에 알맞습니다.",
  split: "두 페이지가 한 장으로 스캔된 이미지를 반으로 잘라 한 쪽씩 보여 줍니다. 세로로 든 휴대폰·태블릿에 알맞습니다.",
  scroll: "모든 페이지를 위아래로 이어서 보여 줍니다.",
};

export class Reader {
  constructor({ toast, onBack, onOpenVolume, onBookmarks }) {
    this.toast = toast;
    this.onBack = onBack;
    this.onOpenVolume = onOpenVolume;
    this.onBookmarks = onBookmarks;
    this.settings = store.getSettings();
    this.source = null;
    this.work = null;
    this.volume = null;
    this.volumes = [];
    this.pos = { page: 0, half: 0 };
    this.renderToken = 0;
    this.openToken = 0;
    this.lastFrames = null;
    this.barsVisible = true;
    this.splitHintShown = false;

    this.el = {
      screen: $("#reader-screen"),
      stage: $("#stage"),
      spread: $("#spread"),
      scrollList: $("#scroll-list"),
      status: $("#stage-status"),
      statusText: $("#stage-status-text"),
      work: $("#reader-work"),
      volume: $("#reader-volume"),
      slider: $("#page-slider"),
      pageLabel: $("#page-label"),
      prevVolume: $("#prev-volume"),
      nextVolume: $("#next-volume"),
      bookmark: $("#reader-bookmark"),
      top: $("#reader-top"),
      bottom: $("#reader-bottom"),
      settingsDialog: $("#settings-dialog"),
      tocDialog: $("#toc-dialog"),
      tocGrid: $("#toc-grid"),
      tocTitle: $("#toc-title"),
      endDialog: $("#end-dialog"),
    };

    this.bindEvents();
  }

  get active() {
    return Boolean(this.work);
  }

  /* 열기 / 닫기 */

  async open(work, volumes, volume, start) {
    const token = ++this.openToken;
    this.closeSource();
    // 설정 화면에서 바꾼 값 반영
    this.settings = store.getSettings();
    this.el.slider.classList.toggle("is-rtl", this.settings.direction === "rtl");
    this.work = work;
    this.volumes = volumes;
    this.volume = volume;
    this.lastFrames = null;
    this.el.work.textContent = work.title;
    this.el.volume.textContent = volume.label;
    this.el.spread.replaceChildren();
    this.el.scrollList.replaceChildren();
    this.scrollBuiltFor = null;
    this.prefetchedNext = false;
    this.el.pageLabel.textContent = "- / -";
    this.el.slider.value = "1";
    this.updateVolumeButtons();
    this.setBars(true);
    this.showStatus("불러오는 중…");

    let source;
    try {
      source = await openVolume(volume, {
        quality: this.settings.quality,
        onStatus: (text) => token === this.openToken && this.showStatus(text),
      });
    } catch (error) {
      if (token !== this.openToken) return;
      this.showError(error, () => this.open(work, volumes, volume, start));
      return;
    }
    if (token !== this.openToken) {
      source.close();
      return;
    }
    this.source = source;
    this.el.slider.max = String(source.count);

    const page = Math.min(Math.max(0, start.page || 0), source.count - 1);
    this.pos = { page, half: start.half ? 1 : 0 };
    if (this.settings.mode === "double") this.pos = { page: this.spreadStart(page), half: 0 };
    await this.render();
  }

  close() {
    this.openToken += 1;
    this.renderToken += 1;
    this.closeSource();
    this.work = null;
    this.volume = null;
    this.el.spread.replaceChildren();
    this.el.scrollList.replaceChildren();
    this.scrollObserver?.disconnect();
    this.tocObserver?.disconnect();
    for (const dialog of [this.el.settingsDialog, this.el.tocDialog, this.el.endDialog]) {
      if (dialog.open) dialog.close();
    }
  }

  closeSource() {
    this.source?.close();
    this.source = null;
    this.thumbs = new Map();
  }

  /* 상태 표시 */

  showStatus(text) {
    this.el.status.hidden = false;
    this.el.status.classList.remove("is-error");
    this.el.statusText.textContent = text;
    this.el.status.querySelector(".status-actions")?.remove();
  }

  hideStatus() {
    this.el.status.hidden = true;
  }

  showError(error, retry) {
    console.error(error);
    this.el.status.hidden = false;
    this.el.status.classList.add("is-error");
    this.el.statusText.textContent = error?.message || String(error);
    this.el.status.querySelector(".status-actions")?.remove();
    const actions = document.createElement("div");
    actions.className = "status-actions";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "primary-btn";
    again.textContent = "다시 시도";
    again.addEventListener("click", (event) => {
      event.stopPropagation();
      retry();
    });
    const back = document.createElement("button");
    back.type = "button";
    back.className = "text-btn";
    back.textContent = "권 목록으로";
    back.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onBack(this.work);
    });
    actions.append(again, back);
    this.el.status.appendChild(actions);
  }

  /* 페이지 배치 계산 */

  shouldSplit(size) {
    if (!size) return false;
    if (this.settings.splitRule === "all") return true;
    return size.width > size.height * 1.05;
  }

  isSplitPage(page) {
    return this.shouldSplit(this.source?.knownSize(page));
  }

  spreadStart(page) {
    if (this.settings.coverAlone) {
      if (page <= 0) return 0;
      return page - ((page - 1) % 2);
    }
    return page - (page % 2);
  }

  spreadIndices(start) {
    const count = this.source.count;
    if (this.settings.coverAlone && start === 0) return [0];
    return start + 1 < count ? [start, start + 1] : [start];
  }

  visibleIndices() {
    if (this.settings.mode === "double") return this.spreadIndices(this.spreadStart(this.pos.page));
    return [this.pos.page];
  }

  // 반쪽 보기에서 먼저 읽는 쪽: 만화(오른쪽→왼쪽)는 오른쪽 절반이 먼저
  cropSide(half) {
    const firstSide = this.settings.direction === "rtl" ? "right" : "left";
    const secondSide = firstSide === "right" ? "left" : "right";
    return half === 0 ? firstSide : secondSide;
  }

  /* 그리기 */

  async render() {
    if (!this.source) return;
    const token = ++this.renderToken;
    const { mode } = this.settings;
    this.el.screen.dataset.mode = mode;
    this.el.screen.dataset.fit = this.settings.fit;

    if (mode === "scroll") {
      this.el.spread.hidden = true;
      this.el.scrollList.hidden = false;
      this.renderScroll();
      this.afterMove();
      return;
    }
    this.el.spread.hidden = false;
    this.el.scrollList.hidden = true;

    const indices = this.visibleIndices();
    this.source.focus = indices[0];
    const loadingTimer = setTimeout(() => token === this.renderToken && this.showStatus("페이지를 불러오는 중…"), 180);
    let results;
    try {
      results = await Promise.all(indices.map((index) => this.source.load(index)));
    } catch (error) {
      clearTimeout(loadingTimer);
      if (token === this.renderToken) this.showError(error, () => this.render());
      return;
    } finally {
      clearTimeout(loadingTimer);
    }
    if (token !== this.renderToken) return;
    this.hideStatus();

    let frames = results.map((result, k) => ({ ...result, index: indices[k], crop: null }));
    if (mode === "split") {
      const frame = frames[0];
      if (this.shouldSplit(frame)) {
        frame.crop = this.cropSide(this.pos.half);
      } else {
        this.pos.half = 0;
      }
    } else {
      this.pos.half = 0;
      if (mode === "single") this.maybeSuggestSplit(frames[0]);
    }
    // 두 페이지 보기: 만화는 앞 페이지가 오른쪽
    if (frames.length > 1 && this.settings.direction === "rtl") frames = frames.reverse();

    this.lastFrames = frames;
    this.layout(frames);
    this.el.spread.scrollTop = 0;
    this.el.spread.scrollLeft = 0;
    this.afterMove();
    this.preload();
    this.maybeSaveCover(results[0], indices[0]);
  }

  layout(frames) {
    const stage = this.el.stage;
    const vw = stage.clientWidth;
    const vh = stage.clientHeight;
    const aspects = frames.map((f) => (f.crop ? f.width / 2 : f.width) / f.height || 0.7);
    const total = aspects.reduce((sum, a) => sum + a, 0);
    const height = this.settings.fit === "width" ? vw / total : Math.min(vh, vw / total);

    const row = document.createElement("div");
    row.className = "spread-row";
    frames.forEach((frame, i) => {
      const box = document.createElement("div");
      box.className = "page-box";
      box.style.width = `${Math.floor(aspects[i] * height)}px`;
      box.style.height = `${Math.floor(height)}px`;
      const img = document.createElement("img");
      img.src = frame.url;
      img.alt = `${frame.index + 1}쪽`;
      img.draggable = false;
      if (frame.crop) {
        img.className = `crop crop-${frame.crop}`;
      }
      box.appendChild(img);
      row.appendChild(box);
    });
    this.el.spread.replaceChildren(row);
  }

  relayout() {
    if (this.settings.mode === "scroll" || !this.lastFrames) return;
    this.layout(this.lastFrames);
  }

  /* 세로 스크롤 */

  renderScroll() {
    const list = this.el.scrollList;
    const key = `${this.volume.id}`;
    if (this.scrollBuiltFor !== key) {
      this.scrollBuiltFor = key;
      this.scrollObserver?.disconnect();
      const items = [];
      for (let i = 0; i < this.source.count; i += 1) {
        const item = document.createElement("div");
        item.className = "scroll-page";
        item.dataset.index = String(i);
        const size = this.source.knownSize(i);
        item.style.aspectRatio = size ? `${size.width} / ${size.height}` : "7 / 10";
        const img = document.createElement("img");
        img.alt = `${i + 1}쪽`;
        img.draggable = false;
        item.appendChild(img);
        items.push(item);
      }
      list.replaceChildren(...items);
      this.scrollObserver = new IntersectionObserver((entries) => this.onScrollIntersect(entries), {
        root: list,
        rootMargin: "150% 0px",
      });
      items.forEach((item) => this.scrollObserver.observe(item));
      list.onscroll = () => this.onScrollMove();
    }
    const target = list.children[this.pos.page];
    if (target) list.scrollTop = target.offsetTop;
  }

  onScrollIntersect(entries) {
    for (const entry of entries) {
      const item = entry.target;
      const index = Number(item.dataset.index);
      const img = item.firstChild;
      if (entry.isIntersecting) {
        if (img.getAttribute("src")) continue;
        this.source
          ?.load(index)
          .then((result) => {
            if (!item.isConnected) return;
            item.style.aspectRatio = `${result.width} / ${result.height}`;
            img.src = result.url;
          })
          .catch(() => item.classList.add("is-error"));
      } else if (img.getAttribute("src")) {
        // 멀리 벗어난 페이지는 메모리에서 내려놓기
        img.removeAttribute("src");
      }
    }
  }

  onScrollMove() {
    if (this.scrollTick) return;
    this.scrollTick = requestAnimationFrame(() => {
      this.scrollTick = null;
      const list = this.el.scrollList;
      const probe = list.scrollTop + list.clientHeight * 0.35;
      const items = list.children;
      let lo = 0;
      let hi = items.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (items[mid].offsetTop <= probe) lo = mid;
        else hi = mid - 1;
      }
      if (lo !== this.pos.page) {
        this.pos = { page: lo, half: 0 };
        if (this.source) this.source.focus = lo;
        this.afterMove();
      }
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4 && this.pos.page >= this.source.count - 1) {
        store.markVolumeDone(this.work.id, this.volume, this.source.count);
      }
    });
  }

  /* 이동 */

  async go(pos) {
    if (!this.source) return;
    const count = this.source.count;
    this.pos = { page: Math.min(Math.max(0, pos.page), count - 1), half: pos.half ? 1 : 0 };
    if (this.settings.mode === "double") this.pos.page = this.spreadStart(this.pos.page);
    if (this.settings.mode === "scroll") {
      const target = this.el.scrollList.children[this.pos.page];
      if (target) this.el.scrollList.scrollTop = target.offsetTop;
      this.afterMove();
      return;
    }
    await this.render();
  }

  async next() {
    if (!this.source) return;
    const count = this.source.count;
    const { page, half } = this.pos;
    switch (this.settings.mode) {
      case "scroll":
        this.el.scrollList.scrollBy({ top: this.el.scrollList.clientHeight * 0.85, behavior: "smooth" });
        return;
      case "split":
        if (half === 0 && this.isSplitPage(page)) return this.go({ page, half: 1 });
        if (page + 1 >= count) return this.atEnd();
        return this.go({ page: page + 1, half: 0 });
      case "double": {
        const shown = this.spreadIndices(this.spreadStart(page));
        const nextPage = shown[shown.length - 1] + 1;
        if (nextPage >= count) return this.atEnd();
        return this.go({ page: nextPage, half: 0 });
      }
      default:
        if (page + 1 >= count) return this.atEnd();
        return this.go({ page: page + 1, half: 0 });
    }
  }

  async prev() {
    if (!this.source) return;
    const { page, half } = this.pos;
    switch (this.settings.mode) {
      case "scroll":
        this.el.scrollList.scrollBy({ top: -this.el.scrollList.clientHeight * 0.85, behavior: "smooth" });
        return;
      case "split": {
        if (half === 1) return this.go({ page, half: 0 });
        if (page === 0) return this.atStart();
        // 앞 페이지가 잘리는 이미지면 뒤쪽 절반부터
        const size = await this.source.load(page - 1).catch(() => null);
        return this.go({ page: page - 1, half: this.shouldSplit(size) ? 1 : 0 });
      }
      case "double": {
        const start = this.spreadStart(page);
        if (start === 0) return this.atStart();
        return this.go({ page: this.spreadStart(start - 1), half: 0 });
      }
      default:
        if (page === 0) return this.atStart();
        return this.go({ page: page - 1, half: 0 });
    }
  }

  // 화면 왼쪽/오른쪽 기준 이동 (읽기 방향 반영)
  left() {
    return this.settings.direction === "rtl" ? this.next() : this.prev();
  }

  right() {
    return this.settings.direction === "rtl" ? this.prev() : this.next();
  }

  atStart() {
    const index = this.volumeIndex();
    this.toast(index > 0 ? "첫 페이지입니다. 아래 '이전 권'으로 이동할 수 있어요." : "첫 페이지입니다.");
  }

  atEnd() {
    store.markVolumeDone(this.work.id, this.volume, this.source.count);
    const nextVolume = this.volumes[this.volumeIndex() + 1];
    $("#end-title").textContent = `${this.volume.label}을(를) 다 읽었습니다`;
    $("#end-text").textContent = nextVolume ? `다음은 ${nextVolume.label}입니다.` : "이 작품의 마지막 권입니다.";
    const nextButton = $("#end-next");
    nextButton.hidden = !nextVolume;
    nextButton.textContent = nextVolume ? `${nextVolume.label} 읽기` : "";
    this.el.endDialog.showModal();
  }

  volumeIndex() {
    return this.volumes.findIndex((v) => v.id === this.volume?.id);
  }

  openSiblingVolume(offset) {
    const target = this.volumes[this.volumeIndex() + offset];
    if (target) this.onOpenVolume(this.work, target, { page: 0, half: 0 });
  }

  /* 이동 후 처리 */

  afterMove() {
    if (!this.source || !this.work) return;
    const count = this.source.count;
    const { page, half } = this.pos;
    this.el.slider.value = String(page + 1);
    this.el.pageLabel.textContent = this.pageLabel();
    this.updateBookmarkButton();
    store.saveProgress(this.work.id, this.volume, this.pos, count);
    const hash = `#/r/${encodeURIComponent(this.work.id)}/${encodeURIComponent(this.volume.id)}?p=${page + 1}${half ? "&h=1" : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  pageLabel() {
    const count = this.source.count;
    const { page, half } = this.pos;
    if (this.settings.mode === "double") {
      const shown = this.spreadIndices(this.spreadStart(page));
      const range = shown.length > 1 ? `${shown[0] + 1}-${shown[1] + 1}` : `${shown[0] + 1}`;
      return `${range} / ${count}`;
    }
    if (this.settings.mode === "split" && this.isSplitPage(page)) {
      const side = this.cropSide(half) === "right" ? "오른쪽" : "왼쪽";
      return `${page + 1} / ${count} · ${side}`;
    }
    return `${page + 1} / ${count}`;
  }

  preload() {
    const count = this.source.count;
    const ahead = this.settings.mode === "double" ? 4 : 3;
    const last = this.visibleIndices().at(-1);
    for (let i = 1; i <= ahead; i += 1) {
      if (last + i < count) this.source.load(last + i).catch(() => {});
    }
    if (this.pos.page > 0) this.source.load(this.pos.page - 1).catch(() => {});
    this.maybePrefetchNextVolume(last);
  }

  // 권 끝에 가까워지면 다음 권 목록과 앞 페이지를 미리 받아 둠
  maybePrefetchNextVolume(lastVisible) {
    if (this.prefetchedNext || lastVisible < this.source.count - 6) return;
    const nextVolume = this.volumes[this.volumeIndex() + 1];
    if (!nextVolume) return;
    this.prefetchedNext = true;
    prefetchVolume(nextVolume, { quality: this.settings.quality }).catch(() => {});
  }

  updateVolumeButtons() {
    const index = this.volumeIndex();
    this.el.prevVolume.disabled = index <= 0;
    this.el.nextVolume.disabled = index < 0 || index >= this.volumes.length - 1;
  }

  updateBookmarkButton() {
    const on = store.hasBookmark(this.work.id, this.volume.id, this.pos.page, this.pos.half);
    this.el.bookmark.classList.toggle("is-on", on);
    this.el.bookmark.setAttribute("aria-pressed", String(on));
  }

  toggleBookmark() {
    if (!this.source) return;
    const added = store.toggleBookmark(this.work.id, this.volume, this.pos.page, this.pos.half, this.source.count);
    this.updateBookmarkButton();
    this.toast(added ? `책갈피 추가: ${this.volume.label} ${this.pageLabel()}` : "책갈피를 지웠습니다");
  }

  maybeSuggestSplit(frame) {
    if (this.splitHintShown || !frame) return;
    const portraitScreen = this.el.stage.clientHeight > this.el.stage.clientWidth;
    if (portraitScreen && frame.width > frame.height * 1.05) {
      this.splitHintShown = true;
      this.toast("두 쪽이 한 장에 스캔된 이미지예요. 설정에서 '반쪽 보기'를 켜 보세요.", 3600);
    }
  }

  // 1권 첫 장을 표지 후보로 기억 (폴더에 cover 파일이 있으면 그쪽이 우선)
  maybeSaveCover(result, index) {
    if (index !== 0 || !result || this.volume.id !== this.volumes[0]?.id) return;
    if (store.getCoverSlots(this.work.id).auto) return;
    snapshot(result, this.source.pages[0])
      .then((cover) => store.setCoverSlot(this.work.id, "auto", cover))
      .catch(() => {});
  }

  /* 설정 */

  applySetting(name, value) {
    const previous = this.settings;
    this.settings = store.updateSettings({ [name]: value });
    this.syncSettingsDialog();
    if (!this.source) return;

    if (name === "quality" && previous.quality !== value) {
      // 이미지 폴더 권은 새 화질로 다시 열기
      if (this.volume.kind === "folder") {
        this.open(this.work, this.volumes, this.volume, this.pos);
      }
      return;
    }
    if (name === "mode") {
      this.toast(MODE_NAMES[value]);
      if (value === "double") this.pos = { page: this.spreadStart(this.pos.page), half: 0 };
      if (value !== "split") this.pos.half = 0;
      if (previous.mode === "scroll" || value === "scroll") this.scrollBuiltFor = value === "scroll" ? null : this.scrollBuiltFor;
    }
    if (name === "direction" && this.pos.half) this.pos.half = 0;
    if (name === "coverAlone" && this.settings.mode === "double") {
      this.pos = { page: this.spreadStart(this.pos.page), half: 0 };
    }
    this.render();
  }

  syncSettingsDialog() {
    const dialog = this.el.settingsDialog;
    dialog.querySelectorAll(".segmented").forEach((group) => {
      const current = String(this.settings[group.dataset.setting]);
      group.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.value === current);
        button.setAttribute("aria-pressed", String(button.dataset.value === current));
      });
    });
    dialog.querySelectorAll("[data-only]").forEach((group) => {
      group.hidden = group.dataset.only !== this.settings.mode;
    });
    $("#mode-hint").textContent = MODE_HINTS[this.settings.mode];
  }

  openSettings() {
    this.settings = store.getSettings();
    this.syncSettingsDialog();
    this.updateCacheUsage();
    this.el.settingsDialog.showModal();
  }

  updateCacheUsage() {
    const mb = pageCache.usageBytes() / 1048576;
    $("#cache-usage").textContent = `이 기기에 저장된 페이지: ${mb < 1 ? mb.toFixed(1) : Math.round(mb)}MB (최대 800MB, 오래 안 본 것부터 자동 정리)`;
  }

  /* 페이지 목록 */

  openToc() {
    if (!this.source) return;
    const grid = this.el.tocGrid;
    this.el.tocTitle.textContent = `${this.volume.label} · ${this.source.count}쪽`;
    this.tocObserver?.disconnect();
    this.tocObserver = new IntersectionObserver((entries) => this.onTocIntersect(entries), {
      root: grid,
      rootMargin: "200px 0px",
    });
    const items = [];
    for (let i = 0; i < this.source.count; i += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toc-item";
      button.dataset.index = String(i);
      if (i === this.pos.page) button.classList.add("is-current");
      const thumb = document.createElement("div");
      thumb.className = "toc-thumb";
      const label = document.createElement("span");
      label.textContent = `${i + 1}`;
      button.append(thumb, label);
      button.addEventListener("click", () => {
        this.el.tocDialog.close();
        this.go({ page: i, half: 0 });
      });
      items.push(button);
      this.tocObserver.observe(button);
    }
    grid.replaceChildren(...items);
    this.el.tocDialog.showModal();
    items[this.pos.page]?.scrollIntoView({ block: "center" });
  }

  onTocIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const button = entry.target;
      this.tocObserver.unobserve(button);
      const index = Number(button.dataset.index);
      const thumb = button.firstChild;
      this.thumbnail(index)
        .then((url) => {
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          img.loading = "lazy";
          thumb.replaceChildren(img);
        })
        .catch(() => thumb.classList.add("is-error"));
    }
  }

  async thumbnail(index) {
    if (this.thumbs.has(index)) return this.thumbs.get(index);
    const page = this.source.pages[index];
    let url;
    if (page.id) {
      url = thumbnailUrl(page.id, page.resourceKey, 240);
    } else {
      // 압축 파일 페이지는 작은 썸네일로 만들어 따로 보관
      const result = await this.source.load(index);
      const img = new Image();
      img.src = result.url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = Math.round((180 * img.naturalHeight) / img.naturalWidth);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      url = canvas.toDataURL("image/jpeg", 0.6);
    }
    this.thumbs.set(index, url);
    return url;
  }

  /* 화면 UI */

  setBars(visible) {
    this.barsVisible = visible;
    this.el.screen.classList.toggle("bars-hidden", !visible);
  }

  toggleFullscreen() {
    if (!document.fullscreenEnabled) {
      this.toast("이 브라우저는 전체 화면을 지원하지 않습니다. 홈 화면에 추가해 앱처럼 실행해 보세요.");
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  isZoomed() {
    return (window.visualViewport?.scale || 1) > 1.05;
  }

  bindEvents() {
    const { stage, slider } = this.el;

    // 탭: 왼쪽 30% / 가운데 / 오른쪽 30% (스크롤을 막지 않도록 오버레이 대신 클릭 좌표로 판단)
    stage.addEventListener("click", (event) => {
      if (!this.source || this.isZoomed() || !this.el.status.hidden) return;
      const rect = stage.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      if (this.settings.mode === "scroll" || (ratio > 0.3 && ratio < 0.7)) {
        this.setBars(!this.barsVisible);
        return;
      }
      this.setBars(false);
      if (ratio <= 0.3) this.left();
      else this.right();
    });

    // 스와이프
    let touch = null;
    stage.addEventListener(
      "touchstart",
      (event) => {
        touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, t: Date.now() } : null;
      },
      { passive: true },
    );
    stage.addEventListener(
      "touchend",
      (event) => {
        if (!touch || !this.source || this.isZoomed() || this.settings.mode === "scroll") return;
        const dx = event.changedTouches[0].clientX - touch.x;
        const dy = event.changedTouches[0].clientY - touch.y;
        const quick = Date.now() - touch.t < 800;
        touch = null;
        if (!quick || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        // 손가락을 오른쪽으로 밀면 왼쪽 페이지가 나타남
        if (dx > 0) this.left();
        else this.right();
        this.setBars(false);
      },
      { passive: true },
    );

    slider.addEventListener("input", () => {
      if (!this.source) return;
      this.el.pageLabel.textContent = `${slider.value} / ${this.source.count}`;
      clearTimeout(this.sliderTimer);
      this.sliderTimer = setTimeout(() => this.go({ page: Number(slider.value) - 1, half: 0 }), 150);
    });
    // 만화 방향이면 슬라이더도 오른쪽이 시작
    const syncSliderDirection = () => slider.classList.toggle("is-rtl", this.settings.direction === "rtl");
    syncSliderDirection();
    this.el.settingsDialog.addEventListener("close", syncSliderDirection);

    $("#reader-back").addEventListener("click", () => this.onBack(this.work));
    $("#reader-bookmark").addEventListener("click", () => this.toggleBookmark());
    $("#reader-bookmarks").addEventListener("click", () => this.onBookmarks(this.work));
    $("#reader-toc").addEventListener("click", () => this.openToc());
    $("#reader-settings").addEventListener("click", () => this.openSettings());
    $("#reader-fullscreen").addEventListener("click", () => this.toggleFullscreen());
    this.el.prevVolume.addEventListener("click", () => this.openSiblingVolume(-1));
    this.el.nextVolume.addEventListener("click", () => this.openSiblingVolume(1));
    $("#end-next").addEventListener("click", () => {
      this.el.endDialog.close();
      this.openSiblingVolume(1);
    });
    $("#end-list").addEventListener("click", () => {
      this.el.endDialog.close();
      this.onBack(this.work);
    });

    $("#cache-clear").addEventListener("click", async () => {
      await pageCache.clearAll();
      this.updateCacheUsage();
      this.toast("저장된 페이지를 지웠습니다");
    });

    this.el.settingsDialog.querySelectorAll(".segmented").forEach((group) => {
      group.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-value]");
        if (!button) return;
        let value = button.dataset.value;
        if (value === "true" || value === "false") value = value === "true";
        this.applySetting(group.dataset.setting, value);
      });
    });

    window.addEventListener("resize", () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.relayout(), 80);
    });

    document.addEventListener("keydown", (event) => {
      if (!this.source || this.el.screen.hidden) return;
      if (document.querySelector("dialog[open]")) return;
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      const handled = () => event.preventDefault();
      switch (event.key) {
        case "ArrowLeft":
          handled();
          this.left();
          break;
        case "ArrowRight":
          handled();
          this.right();
          break;
        case " ":
        case "PageDown":
          if (this.settings.mode === "scroll" && event.key === " ") return;
          handled();
          if (event.shiftKey) this.prev();
          else this.next();
          break;
        case "PageUp":
          handled();
          this.prev();
          break;
        case "Home":
          handled();
          this.go({ page: 0, half: 0 });
          break;
        case "End":
          handled();
          this.go({ page: this.source.count - 1, half: 0 });
          break;
        case "1":
        case "2":
        case "3":
        case "4":
          this.applySetting("mode", ["single", "double", "split", "scroll"][Number(event.key) - 1]);
          break;
        case "b":
        case "B":
          this.toggleBookmark();
          break;
        case "t":
        case "T":
          this.openToc();
          break;
        case "f":
        case "F":
          this.toggleFullscreen();
          break;
        case "h":
        case "H":
          this.setBars(!this.barsVisible);
          break;
        default:
      }
    });
  }
}
