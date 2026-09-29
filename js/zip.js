// 필요한 페이지만 골라서 푸는 ZIP 리더
//
// ZIP 파일은 끝부분에 전체 파일 목록(중앙 디렉터리)이 있고, 각 파일의 위치가 적혀 있습니다.
// 그래서 수백 MB짜리 권도 전부 받지 않고, HTTP Range 요청으로
//   1) 끝부분(목록)만 읽고
//   2) 지금 보는 페이지의 바이트 구간만 받아서 압축을 풉니다.
// 서버가 Range 를 지원하지 않으면 파일 전체를 한 번 받아 메모리에서 같은 방식으로 읽습니다.

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const utf8 = new TextDecoder("utf-8", { fatal: true });
let euckr = null;
try {
  euckr = new TextDecoder("euc-kr");
} catch {
  euckr = null;
}

function decodeName(bytes, isUtf8) {
  if (isUtf8) return new TextDecoder("utf-8").decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    // 한국어 Windows 에서 만든 압축 파일은 이름이 CP949(EUC-KR)인 경우가 많음
    return euckr ? euckr.decode(bytes) : new TextDecoder("utf-8").decode(bytes);
  }
}

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function u64(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("이 브라우저는 압축 해제를 지원하지 않습니다. 최신 Chrome/Safari/Edge 를 사용해 주세요.");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipReader {
  /**
   * @param {object} source
   * @param {number} source.size 파일 전체 크기(바이트)
   * @param {(start:number, end:number) => Promise<Uint8Array>} source.read end 포함 구간 읽기
   */
  constructor(source) {
    this.source = source;
    this.size = source.size;
    this.entries = [];
  }

  async open() {
    const size = this.size;
    if (!size || size < 22) throw new Error("ZIP 파일 크기를 알 수 없거나 너무 작습니다.");

    // EOCD(22바이트) + 최대 주석 길이(65535) + ZIP64 locator(20)
    const tailLength = Math.min(size, 22 + 65535 + 20);
    const tailStart = size - tailLength;
    const tail = await this.source.read(tailStart, size - 1);
    const tailView = viewOf(tail);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (u32(tailView, i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("올바른 ZIP 파일이 아닙니다.");

    let entryCount = u16(tailView, eocd + 10);
    let cdSize = u32(tailView, eocd + 12);
    let cdOffset = u32(tailView, eocd + 16);

    // 4GB 이상 또는 항목 65535개 이상인 ZIP64
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
      const locator = eocd - 20;
      if (locator < 0 || u32(tailView, locator) !== SIG_ZIP64_LOCATOR) {
        throw new Error("ZIP64 정보를 찾을 수 없습니다.");
      }
      const zip64Offset = u64(tailView, locator + 8);
      const record = await this.readBytes(zip64Offset, 56, tail, tailStart);
      const view = viewOf(record);
      if (u32(view, 0) !== SIG_ZIP64_EOCD) throw new Error("ZIP64 정보가 손상되었습니다.");
      entryCount = u64(view, 32);
      cdSize = u64(view, 40);
      cdOffset = u64(view, 48);
    }

    const cd = await this.readBytes(cdOffset, cdSize, tail, tailStart);
    this.entries = this.parseCentralDirectory(cd, entryCount);
    return this;
  }

  // 이미 받아 둔 끝부분(tail) 안에 있으면 재사용
  async readBytes(offset, length, tail, tailStart) {
    if (offset >= tailStart && offset + length <= tailStart + tail.length) {
      return tail.subarray(offset - tailStart, offset - tailStart + length);
    }
    return this.source.read(offset, offset + length - 1);
  }

  parseCentralDirectory(cd, expected) {
    const view = viewOf(cd);
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && entries.length < expected) {
      if (u32(view, p) !== SIG_CENTRAL) break;
      const flags = u16(view, p + 8);
      const method = u16(view, p + 10);
      let compressedSize = u32(view, p + 20);
      let size = u32(view, p + 24);
      const nameLength = u16(view, p + 28);
      const extraLength = u16(view, p + 30);
      const commentLength = u16(view, p + 32);
      let localOffset = u32(view, p + 42);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLength), (flags & 0x800) !== 0);

      // ZIP64 확장 필드: 0xFFFFFFFF 로 표시된 값만 순서대로 들어 있음
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = u16(view, e);
        const len = u16(view, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = u64(view, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(view, q);
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = u64(view, q);
          }
        }
        e += 4 + len;
      }

      if (!name.endsWith("/")) {
        entries.push({
          name,
          method,
          encrypted: (flags & 0x1) !== 0,
          compressedSize,
          size,
          localOffset,
          nameLength,
          extraLength,
        });
      }
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async read(entry) {
    if (entry.encrypted) throw new Error(`암호가 걸린 파일은 열 수 없습니다: ${entry.name}`);
    // 로컬 헤더의 이름/확장 길이는 중앙 디렉터리와 다를 수 있어 여유분을 두고 한 번에 요청
    const guess = 30 + entry.nameLength + entry.extraLength + 64;
    let chunk = await this.source.read(entry.localOffset, entry.localOffset + guess + entry.compressedSize - 1);
    let view = viewOf(chunk);
    if (u32(view, 0) !== SIG_LOCAL) throw new Error(`ZIP 항목 위치가 올바르지 않습니다: ${entry.name}`);
    const dataStart = 30 + u16(view, 26) + u16(view, 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > chunk.length) {
      chunk = await this.source.read(entry.localOffset, entry.localOffset + dataEnd - 1);
      view = viewOf(chunk);
    }
    const data = chunk.subarray(dataStart, dataEnd);

    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error(`지원하지 않는 압축 방식(${entry.method})입니다: ${entry.name}`);
  }
}
