// 작품 대표 이미지(표지)
//
// 우선순위
//   1. Google Drive 작품 폴더 바로 안의 cover.jpg / cover.png / cover.webp
//   2. 없으면 1권 첫 장 (처음 한 번 만들어 기기에 저장)

import * as store from "./store.js";
import { openVolume, thumbnailUrl } from "./drive.js";

const COVER_WIDTH = 360;

function isWide(width, height) {
  return width > height * 1.05;
}

/**
 * 불러온 페이지로 표지 이미지 만들기
 * @param {{url:string,width:number,height:number}} image 불러온 페이지
 * @param {{id?:string,resourceKey?:string}} page 원본 파일 정보(이미지 폴더 작품이면 id 가 있음)
 */
export async function snapshot(image, page) {
  // 펼친 두 쪽이 한 장에 스캔된 이미지면 만화의 첫 쪽인 오른쪽 절반을 씀
  const side = isWide(image.width, image.height) ? "right" : null;

  if (!image.url.startsWith("blob:") && page?.id) {
    // Drive 썸네일(다른 출처)은 캔버스로 자를 수 없어 표시 위치로 조절
    return {
      url: thumbnailUrl(page.id, page.resourceKey, COVER_WIDTH * (side ? 2 : 1)),
      position: side ? `${side} center` : "center",
    };
  }

  const img = new Image();
  img.src = image.url;
  await img.decode();
  const sw = side ? img.naturalWidth / 2 : img.naturalWidth;
  const sx = side === "right" ? img.naturalWidth / 2 : 0;
  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = Math.round((COVER_WIDTH * img.naturalHeight) / sw);
  canvas.getContext("2d").drawImage(img, sx, 0, sw, img.naturalHeight, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL("image/jpeg", 0.75), position: "center" };
}

// 1권 첫 장으로 표지를 만들어 기기에 저장
export async function resolveAutoCover(work, volumes) {
  const saved = store.getCoverSlots(work.id).auto;
  if (saved) return saved;
  const volume = volumes[0];
  if (!volume) return null;
  const source = await openVolume(volume, { quality: "normal" });
  try {
    if (!source.count) return null;
    const cover = await snapshot(await source.load(0), source.pages[0]);
    store.setCoverSlot(work.id, "auto", cover);
    return cover;
  } finally {
    source.close();
  }
}
