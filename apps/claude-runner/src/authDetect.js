// 認証切れの判定。
//
// ⚠⚠ **この判定ロジックは未確定。実機で確かめてから詰めること。**
//    claude が認証切れを 終了コードで返すのか、stderr の文字列で返すのか、
//    それとも --output-format json の中に入れてくるのかが分かっていない。
//    そのため現状は:
//      - 疑わしい文字列に当たったら AUTH とみなす（暫定）
//      - **判定に関わらず、生の stdout/stderr/exitCode を
//        failed/<jobId>.error.json と health.json に必ずそのまま残す**
//    実機のログを見てから、この関数だけを直せば済むようにしてある。

const AUTH_PATTERNS = [
  /invalid\s+api\s+key/i,
  /authentication[_\s-]?error/i,
  /unauthorized/i,
  /\b401\b/,
  /not\s+logged\s*in/i,
  /please\s+run\s+`?\/?login/i,
  /login\s+required/i,
  /credentials?\s+(expired|not\s+found|invalid)/i,
  /oauth.{0,20}(expired|revoked|invalid)/i,
  /session\s+expired/i,
];

/**
 * @param {{code:number|null, stdout:string, stderr:string}} execResult
 * @returns {{isAuthError:boolean, matched:string|null}}
 */
export function detectAuthError(execResult) {
  const haystack = `${execResult.stderr || ''}\n${execResult.stdout || ''}`;
  for (const re of AUTH_PATTERNS) {
    const m = haystack.match(re);
    if (m) return { isAuthError: true, matched: m[0] };
  }
  return { isAuthError: false, matched: null };
}
