# cnation 만화책방 (cnation-mh)

## 버전 / rev. history 규칙

- 버전과 변경 이력은 `js/version.js` 의 `HISTORY` 한 곳에서 관리합니다. 서재 상단의 버전 표시와 `rev. history` 화면(`#/history`)이 여기서 읽어 갑니다.
- 기능을 수정·추가할 때마다 세 번째 자리를 올리고(예: 1.0.0 → 1.0.1), `HISTORY` 맨 위에 새 항목(version, date, title, changes)을 추가합니다.
- 두 번째 자리(예: 1.0.x → 1.1.0)는 제작자가 "큰 변화"라고 따로 요청할 때만 올립니다.
- 변경 내용은 사용자가 이해할 수 있는 한국어 문장으로 적습니다.
- 앱 화면 파일을 바꾸면 `service-worker.js` 의 `CACHE` 버전도 올려서 기존 사용자에게 반영되게 합니다.
