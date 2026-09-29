// Vercel 서버리스 함수: 서비스 계정으로 Google Drive 읽기 전용 액세스 토큰(1시간)을 발급합니다.
// 서비스 계정 비밀 키는 이 서버에만 있고, 브라우저에는 곧 만료되는 토큰만 전달됩니다.
//
// Vercel 환경 변수
//   GOOGLE_SERVICE_ACCOUNT  서비스 계정 JSON 키 파일 내용 전체 (권장)
//   GOOGLE_API_KEY          (대안) 서비스 계정이 없을 때 API 키를 그대로 전달
const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
let cached = null; // { accessToken, expiresAt } — 같은 인스턴스에서는 재사용

function readServiceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT 값이 올바른 JSON 이 아닙니다. 키 파일 내용을 { 부터 } 까지 그대로 넣어 주세요.");
    }
  }
  if (!json.client_email || !json.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT 에 client_email / private_key 가 없습니다. 서비스 계정 JSON 키가 맞는지 확인해 주세요.");
  }
  return { ...json, private_key: json.private_key.replace(/\\n/g, "\n") };
}

const base64url = (value) => Buffer.from(value).toString("base64url");

async function issueToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key).toString("base64url");

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google 토큰 발급 실패: ${json.error_description || json.error || res.status}`);
  }
  return { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  try {
    const account = readServiceAccount();
    if (account) {
      // 만료 10분 전까지는 같은 토큰 재사용
      if (!cached || cached.expiresAt - Date.now() < 10 * 60 * 1000) cached = await issueToken(account);
      return send(res, 200, cached);
    }
    if (process.env.GOOGLE_API_KEY) return send(res, 200, { apiKey: process.env.GOOGLE_API_KEY });
    return send(res, 503, { error: "Vercel 환경 변수 GOOGLE_SERVICE_ACCOUNT 가 설정되지 않았습니다." });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
};
