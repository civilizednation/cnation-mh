// 앱 화면(HTML/CSS/JS)만 캐시합니다. Google Drive 의 만화 이미지는 캐시하지 않습니다.
// 항상 네트워크를 먼저 쓰고, 연결이 끊겼을 때만 캐시로 화면을 띄웁니다.
const CACHE = "cnation-mh-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./js/app.js",
  "./js/reader.js",
  "./js/drive.js",
  "./js/zip.js",
  "./js/store.js",
  "./data/library.json",
  "./favicon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html"))),
  );
});
