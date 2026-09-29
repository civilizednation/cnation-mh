// 작품 대표 이미지(표지) 만들기
//
// library.json 의 cover 지정 방법
//   "cover": { "volume": 1, "page": 5 }                  1권 5쪽
//   "cover": { "volume": 1, "page": 5, "side": "right" } 펼친 페이지면 오른쪽 절반만
//   "cover": { "id": "Drive 이미지 파일 ID", "resourceKey": "…" }  Drive 이미지 파일 직접 지정

import * as store from "./store.js";
import { openVolume, thumbnailUrl } from "./drive.js";

const COVER_WIDTH = 360;

export function configKey(work) {
  return work.cover && !work.cover.id ? JSON.stringify(work.cover) : "";
}

function isWide(width, height) {
  return width > height * 1.05;
}

/**
 * 뷰어에서 불러온 페이지로 대표 이미지 만들기
 * @param {{url:string,width:number,height:number}} image 불러온 페이지
 * @param {{id?:string,resourceKey?:string}} page 원본 파일 정보(이미지 폴더 작품이면 id 가 있음)
 * @param {"left"|"right"|null} side 펼친 페이지에서 쓸 쪽
 */
export async function snapshot(image, page, side) {
  const wide = isWide(image.width, image.height);
  const useSide = wide ? side || "right" : null;

  if (!image.url.startsWith("blob:") && page?.id) {
    // Drive 썸네일(다른 출처)은 캔버스로 자를 수 없어 표시 위치로 조절
    return {
      url: thumbnailUrl(page.id, page.resourceKey, COVER_WIDTH * (useSide ? 2 : 1)),
      position: useSide ? `${useSide} center` : "center",
    };
  }

  const img = new Image();
  img.src = image.url;
  await img.decode();
  const sw = useSide ? img.naturalWidth / 2 : img.naturalWidth;
  const sx = useSide === "right" ? img.naturalWidth / 2 : 0;
  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = Math.round((COVER_WIDTH * img.naturalHeight) / sw);
  canvas.getContext("2d").drawImage(img, sx, 0, sw, img.naturalHeight, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL("image/jpeg", 0.75), position: "center" };
}

function findVolume(volumes, number) {
  return volumes.find((v) => v.number === number) || volumes[number - 1] || null;
}

// library.json 의 { volume, page, side } 지정을 실제 이미지로 만들어 기기에 저장
export async function resolveConfigCover(work, volumes) {
  const spec = work.cover;
  const key = configKey(work);
  if (!key) return null;
  const saved = store.getCoverSlots(work.id).config;
  if (saved?.key === key) return saved;

  const volume = findVolume(volumes, Number(spec.volume) || 1);
  if (!volume) return null;
  const source = await openVolume(volume, { quality: "normal" });
  try {
    const index = Math.min(Math.max(0, (Number(spec.page) || 1) - 1), source.count - 1);
    const image = await source.load(index);
    const cover = await snapshot(image, source.pages[index], spec.side || null);
    const value = { ...cover, key };
    store.setCoverSlot(work.id, "config", value);
    return value;
  } finally {
    source.close();
  }
}
