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

## Google Drive 준비

1. 각 작품 폴더를 **링크가 있는 모든 사용자 → 뷰어**로 공유합니다.
2. [Google Cloud 콘솔](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Drive API** 를 사용 설정합니다.
3. **API 및 서비스 → 사용자 인증 정보 → API 키 만들기**
4. 만든 키에 제한을 겁니다.
   - **애플리케이션 제한사항: 웹사이트** → `https://<배포주소>/*`, 로컬 테스트용 `http://localhost:5173/*`
   - **API 제한사항: Google Drive API**

   이 키는 브라우저에서 사용되므로 누구나 볼 수 있습니다. 위 두 가지 제한을 꼭 걸어 두세요.

## Vercel 배포

1. Vercel 에서 **Add New → Project** → 이 저장소(`cnation-mh`) Import
2. Framework Preset: `Other`, Build Command / Output Directory 는 비워 둠
3. **Settings → Environment Variables** 에 `GOOGLE_API_KEY` = 위에서 만든 키
4. Deploy

키는 `api/config.js` 서버리스 함수를 통해 앱에 전달되므로 저장소에 넣을 필요가 없습니다.
환경 변수 없이 배포했다면 앱 첫 화면의 **API 키 설정**에서 입력해도 됩니다(그 기기에만 저장).

## 로컬 실행

```bash
GOOGLE_API_KEY=AIza... node scripts/serve.mjs
# → http://localhost:5173
```

Node.js 만 있으면 되고 설치할 패키지는 없습니다.

## 작품 추가하기

`data/library.json` 의 `works` 에 항목을 추가합니다.

```json
{
  "id": "slamdunk",
  "title": "슬램덩크",
  "subtitle": "완결",
  "folderId": "0B_Fq1xsSZuWIeUhJQ2NTM2NuTEU",
  "resourceKey": "0-iyPAtm8AlJzULx7aKa7feg",
  "color": "#c62828",
  "cover": { "id": "표지 이미지 파일 ID", "resourceKey": "있으면 입력" }
}
```

- `id`: 영문 식별자 (이어보기·책갈피 저장 키로 쓰이므로 한 번 정하면 바꾸지 않기)
- `folderId`: 작품 폴더 ID (공유 링크 `.../folders/<여기>`)
- `resourceKey`: 2021년 이전에 만든 폴더의 공유 링크에 `?resourcekey=` 가 붙어 있으면 그 값
- `cover`, `color`, `subtitle`: 선택. 표지가 없으면 처음 읽은 권의 첫 장으로 자동 생성합니다.

작품 폴더 구성은 다음 중 어느 형태든 됩니다.

```text
작품 폴더/
├── 01/  02/  03/ …              권마다 이미지 폴더
├── 작품명_01.zip  작품명_02.zip   권마다 압축 파일
└── (이미지를 바로 넣으면 한 권으로 취급)
```

권 번호는 이름의 마지막 숫자로 정렬합니다(`드래곤볼_무수정판_07.zip` → 7권). 권 목록은 12시간 동안 캐시되며, 권 선택 화면의 새로고침 버튼으로 즉시 다시 불러올 수 있습니다.

## 폴더 구성

```text
index.html            앱 화면
styles.css            디자인
config.js             (선택) 로컬용 API 키
js/app.js             화면 전환, 서재, 권 선택, 책갈피 목록, API 키 설정
js/reader.js          뷰어 (한 페이지 / 두 페이지 / 반쪽 / 스크롤)
js/drive.js           Google Drive API: 폴더 목록, 이미지·ZIP 불러오기
js/zip.js             Range 요청 기반 ZIP 리더 (ZIP64, CP949 파일명 지원)
js/store.js           이어보기·책갈피·설정 저장
data/library.json     작품 목록
api/config.js         Vercel 환경 변수의 API 키 전달
service-worker.js     앱 화면 오프라인 캐시 (만화 이미지는 캐시하지 않음)
manifest.webmanifest  홈 화면 설치 정보
scripts/serve.mjs     로컬 실행 서버
```

## 참고

- 이어보기·책갈피는 기기(브라우저)마다 따로 저장됩니다.
- ZIP 압축 해제에는 브라우저 내장 `DecompressionStream` 을 사용합니다 (Chrome/Edge 80+, Safari 16.4+, Firefox 113+).
- 이미지 폴더 작품은 Drive 썸네일 주소로 이미지를 불러오고, 실패하면 Drive API 원본 다운로드로 대신합니다.
