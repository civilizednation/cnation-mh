# CNATION 만화

Google Drive 에 올려 둔 만화책을 작품 → 권 순서로 골라 읽는 웹 만화책 뷰어입니다.
별도 빌드 없이 Vercel 에 바로 배포되며, 휴대폰·태블릿에서 **홈 화면에 추가**하면 앱처럼 전체 화면으로 실행됩니다.

## 주요 기능

- **서재**: `data/library.json` 에 등록한 작품 목록, 최근 읽은 작품 이어 보기
- **권 선택**: 작품 폴더 안의 하위 폴더(이미지) 또는 `.zip`/`.cbz` 파일을 권으로 자동 인식, 권별 진행률·완독 표시
- **ZIP 권 읽기**: 압축 파일 전체를 받지 않고, 지금 보는 페이지 부분만 HTTP Range 요청으로 받아서 브라우저에서 바로 압축 해제
  (수백 MB짜리 권도 첫 페이지가 금방 뜹니다. 서버가 Range 를 지원하지 않으면 한 번 전체를 받아서 읽습니다.)
- **보기 방식**
  - 한 페이지 보기
  - 두 페이지 보기 (첫 장 따로/짝 맞추기 선택)
  - **반쪽 보기**: 두 페이지가 한 장으로 스캔된 이미지를 반으로 잘라 한 쪽씩 보여 줌 — 세로로 든 휴대폰·태블릿용.
    만화 방향(오른쪽→왼쪽)이면 오른쪽 절반부터 읽습니다. 기본은 가로로 긴 이미지만 자르고, "모든 이미지"로 바꿀 수 있습니다.
  - 세로 스크롤
- **이어보기**: 작품별·권별로 마지막 위치 자동 저장 (브라우저 localStorage)
- **책갈피**: 보는 중 책갈피 버튼(또는 `B`)으로 저장, 작품별 책갈피 목록에서 바로 이동
- 읽기 방향(오른쪽→왼쪽 / 왼쪽→오른쪽), 화면/너비 맞춤, 화질, 페이지 목록(썸네일), 전체 화면
- 조작: 화면 왼쪽/오른쪽 탭, 스와이프, 가운데 탭(메뉴 표시), 키보드 `←` `→` `Space` `Home` `End` `1`~`4`(보기 방식) `B` `T` `F` `H`

## Google Drive 연결 (서비스 계정)

비밀 키는 Vercel 서버에만 두고, 브라우저에는 1시간 뒤 만료되는 **읽기 전용 토큰**만 전달합니다.
만화 데이터는 브라우저가 Google Drive 에서 **직접** 받기 때문에 Vercel 대역폭을 거의 쓰지 않습니다.

```text
브라우저 ──(/api/token)──> Vercel: 서비스 계정 키로 1시간 토큰 발급
브라우저 ──(토큰, Range 요청)──> Google Drive   ← 만화 데이터는 여기서 직접
```

1. [Google Cloud 콘솔](https://console.cloud.google.com/apis/library/drive.googleapis.com)에서 **Google Drive API** 를 사용 설정합니다.
2. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기** (예: `cnation-google-mh`). 역할은 주지 않아도 됩니다.
3. 만든 서비스 계정 → **키 → 키 추가 → 새 키 만들기 → JSON** 으로 키 파일을 받습니다. 이 파일은 비밀번호와 같으니 저장소에 올리지 마세요.
4. Vercel → cnation-mh → **Settings → Environment Variables** 에 추가하고 재배포합니다.
   - Key: `GOOGLE_SERVICE_ACCOUNT`
   - Value: JSON 키 파일 내용 전체 (`{` 부터 `}` 까지)
5. Google Drive 에서 작품 폴더(또는 이를 담은 상위 폴더)를 서비스 계정 이메일
   (`…@….iam.gserviceaccount.com`)에 **뷰어**로 공유합니다.
   이렇게 하면 폴더를 "링크가 있는 모든 사용자" 공개로 둘 필요가 없습니다.
   (단, 이미지 폴더 작품의 썸네일/표지는 공개 썸네일 주소를 쓰므로, 비공개로 바꾸면 원본 다운로드로 대신 불러와 조금 느려집니다.)

앱 설정 화면(서재 오른쪽 위 ⚙)에서 연결 상태와 오류 메시지를 확인할 수 있습니다.

## Vercel 배포

1. Vercel 에서 **Add New → Project** → 이 저장소(`cnation-mh`) Import
2. Framework Preset: `Other`, Build Command / Output Directory 는 비워 둠
3. 위의 `GOOGLE_SERVICE_ACCOUNT` 환경 변수 추가 후 Deploy

`/api/token` 서버리스 함수가 필요하므로 GitHub Pages 같은 정적 호스팅만으로는 동작하지 않습니다.

## 로컬 실행

```bash
GOOGLE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/serve.mjs
# → http://localhost:5173
```

Node.js 18 이상만 있으면 되고 설치할 패키지는 없습니다. 서비스 계정 없이 API 키로 테스트하려면
`GOOGLE_API_KEY=AIza... node scripts/serve.mjs` 로 실행하거나 설정 화면의 "로컬 테스트용: API 키로 연결"을 사용합니다.

## 큰 ZIP 권 처리

- ZIP 목록(중앙 디렉터리)과 보는 페이지 부분만 HTTP Range 로 받습니다. 260MB 권도 첫 페이지는 몇 MB 만 받고 뜹니다.
- 받은 페이지와 ZIP 목록은 기기(Cache Storage)에 최대 800MB 저장되어, 같은 권을 다시 열면 네트워크 없이 표시됩니다.
  한도를 넘으면 오래 안 본 것부터 지웁니다. 뷰어의 보기 설정 → 저장 공간에서 지울 수 있습니다.
- 권 끝에 가까워지면 다음 권의 목록과 앞 4페이지를 미리 받아 둡니다.
- 메모리에는 보는 위치 주변 페이지만 두고, 권을 닫으면 바로 해제합니다.
- Range 를 지원하지 않는 응답이 오면 80MB 이하 파일만 통째로 받고, 그보다 크면 안내 메시지를 띄웁니다.

## 작품 추가하기

`data/library.json` 의 `works` 에 항목을 추가합니다.

```json
{
  "id": "slamdunk",
  "title": "슬램덩크",
  "folderId": "0B_Fq1xsSZuWIeUhJQ2NTM2NuTEU",
  "resourceKey": "0-iyPAtm8AlJzULx7aKa7feg",
  "color": "#c62828"
}
```

- `id`: 영문 식별자 (이어보기·책갈피 저장 키로 쓰이므로 한 번 정하면 바꾸지 않기)
- `folderId`: 작품 폴더 ID (공유 링크 `.../folders/<여기>`)
- `resourceKey`: 2021년 이전에 만든 폴더의 공유 링크에 `?resourcekey=` 가 붙어 있으면 그 값
- `color`: 선택 (표지가 없을 때 쓰는 배경색)

### 작품 대표 이미지(표지)

- 작품 폴더 **바로 안**에 `cover.jpg`, `cover.png`, `cover.webp` 중 하나를 넣으면 그 이미지를 표지로 씁니다.
- 없으면 1권 첫 장을 표지로 씁니다. (펼친 두 쪽 이미지면 오른쪽 절반)
- 권 목록은 12시간 동안 캐시되므로, 표지 파일을 새로 넣었으면 권 선택 화면의 새로고침 버튼을 누르면 바로 반영됩니다.

작품 폴더 구성은 다음 중 어느 형태든 됩니다.

```text
작품 폴더/
├── 01/  02/  03/ …              권마다 이미지 폴더
├── 작품명_01.zip  작품명_02.zip   권마다 압축 파일
├── cover.webp                    (선택) 표지 이미지
└── (이미지를 바로 넣으면 한 권으로 취급)
```

권 번호는 이름의 마지막 숫자로 정렬합니다(`드래곤볼_무수정판_07.zip` → 7권). 권 목록은 12시간 동안 캐시되며, 권 선택 화면의 새로고침 버튼으로 즉시 다시 불러올 수 있습니다.

## 폴더 구성

```text
index.html            앱 화면
styles.css            디자인
config.js             (선택) 로컬 테스트용 API 키
js/app.js             화면 전환, 서재, 권 선택, 책갈피 목록, API 키 설정
js/reader.js          뷰어 (한 페이지 / 두 페이지 / 반쪽 / 스크롤)
js/drive.js           Google Drive API: 폴더 목록, 이미지·ZIP 불러오기
js/zip.js             Range 요청 기반 ZIP 리더 (ZIP64, CP949 파일명 지원)
js/store.js           이어보기·책갈피·설정 저장
js/cache.js           ZIP 페이지·목록 기기 캐시 (최대 800MB)
data/library.json     작품 목록
api/token.js          서비스 계정으로 1시간짜리 Drive 읽기 토큰 발급 (Vercel 서버리스)
service-worker.js     앱 화면 오프라인 캐시 (만화 이미지는 캐시하지 않음)
manifest.webmanifest  홈 화면 설치 정보
scripts/serve.mjs     로컬 실행 서버
```

## 참고

- 이어보기·책갈피는 기기(브라우저)마다 따로 저장됩니다.
- ZIP 압축 해제에는 브라우저 내장 `DecompressionStream` 을 사용합니다 (Chrome/Edge 80+, Safari 16.4+, Firefox 113+).
- 이미지 폴더 작품은 Drive 썸네일 주소로 이미지를 불러오고, 실패하면 Drive API 원본 다운로드로 대신합니다.
- `/api/token` 은 누구나 호출할 수 있으므로, 서비스 계정에는 만화 폴더만 공유하세요. 토큰으로 읽을 수 있는 범위는 서비스 계정에 공유된 파일뿐입니다.
