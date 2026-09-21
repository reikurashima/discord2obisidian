import https from 'https';
import { URL } from 'url';
import { logger } from './utils/logger.js';

/**
 * Discord webhook へ通知する。
 *
 * ⚠ User-Agent を必ず明示する。既定の Node の UA だと Discord に 403 で弾かれる
 *   （Python-urllib で実際に 403 を食った件と同じ）。
 * ⚠ 通知の失敗で本体の処理を止めない。必ず握りつぶしてログだけ残す。
 */
export async function notifyDiscord(webhookUrl, text) {
  if (!webhookUrl) {
    logger.warn(`[Notify] RUNNER_WEBHOOK_URL not set, logging only:\n${text}`);
    return false;
  }
  try {
    await post(webhookUrl, JSON.stringify({ content: text.slice(0, 1900) }));
    logger.info('[Notify] sent to Discord webhook');
    return true;
  } catch (error) {
    logger.error('[Notify] failed (ignored, worker keeps running)', error);
    return false;
  }
}

function post(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'claude-runner', // ← これが無いと 403
      },
      timeout: 10_000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`webhook returned ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
