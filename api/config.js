// Vercel 서버리스 함수: 환경 변수 GOOGLE_API_KEY 를 앱에 전달합니다.
// 키를 저장소에 커밋하지 않기 위한 용도이며, 브라우저에서 Drive API 를 직접 부르므로
// Google Cloud 콘솔에서 키에 "웹사이트 제한(HTTP 리퍼러)"과 "Drive API 전용" 제한을 꼭 걸어 두세요.
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ googleApiKey: process.env.GOOGLE_API_KEY || "" }));
};
