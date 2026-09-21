import { logger } from '../utils/logger.js';

const TWITTER_REGEX = /https?:\/\/(www\.)?(twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;
const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/|youtube\.com\/live\/)/;
const URL_REGEX = /https?:\/\/\S+/;

// ========== ノート／デイリー用（URL抽出と投稿者名の取得だけ） ==========
//
// 下の containsUrl / extractUrl / fetchUrlContent 一式は canvas チャンネルが
// 現役で使っているので手を触れていない。
// ノート／デイリーは「URL先の中身を取りに行かない」方針になったため、
// そちら向けの軽い関数をここに並べる。

// 本文中のURLを「全部」拾うため /g 付き。
// /g 付き正規表現は test()/exec() で lastIndex が残って次回の判定を取りこぼすので、
// この定数は match() 経由でしか使わないこと。
// 日本語の読点・括弧類は文字クラスから除外している。「https://example.com、あと…」のように
// スペースなしで続けて書かれたとき、後ろの日本語まで飲み込んでしまうため。
// 逆に漢字・かなは除外しない（ja.wikipedia.org/wiki/日本語 のような実在のURLを壊すので）。
const ALL_URLS_REGEX = /https?:\/\/[^\s<>"'`、。！？「」『』（）]+/g;

// 末尾に句読点や閉じ括弧がくっついたURL（「... https://example.com です。」等）を切り落とすため
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}、。！？）】」]+$/;

const AUTHOR_TWITTER_REGEX = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/;
const AUTHOR_YOUTUBE_REGEX = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/)/;

// 投稿者名は「あれば嬉しい」程度の情報。待たされるくらいなら諦めるので短め。
const AUTHOR_FETCH_TIMEOUT_MS = 5000;

/**
 * Extract every URL in the text (in order of appearance).
 */
export function extractUrls(text) {
  const matches = text.match(ALL_URLS_REGEX);
  if (!matches) return [];

  return matches
    .map((url) => url.replace(TRAILING_PUNCTUATION_REGEX, ''))
    .filter((url) => url.length > 0);
}

/**
 * Fetch the author display name for a URL.
 * Returns a string, or null when the site is unsupported or the lookup fails.
 * 失敗しても例外は投げない（投稿者名の行が1本消えるだけで、保存処理は続行させたいため）。
 */
export async function fetchAuthorName(url) {
  try {
    if (AUTHOR_TWITTER_REGEX.test(url)) {
      return await fetchTwitterAuthorName(url);
    }
    if (AUTHOR_YOUTUBE_REGEX.test(url)) {
      return await fetchYoutubeAuthorName(url);
    }
  } catch (error) {
    logger.warn(`[URL] Failed to fetch author name for ${url}: ${error.message}`);
  }
  return null;
}

/**
 * X / Twitter: FxTwitter API から表示名を取る（APIキー不要）。
 */
async function fetchTwitterAuthorName(url) {
  const match = url.match(AUTHOR_TWITTER_REGEX);
  if (!match) return null;

  const [, screenName, tweetId] = match;
  const apiUrl = `https://api.fxtwitter.com/${screenName}/status/${tweetId}`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': 'DiscordBot/1.0' },
    signal: AbortSignal.timeout(AUTHOR_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    logger.warn(`[URL] FxTwitter returned ${response.status} for ${url}`);
    return null;
  }

  const data = await response.json();
  // 表示名が取れないときは screen_name で代用する（[[リンク]]先として成立するので）
  const name = data?.tweet?.author?.name || screenName;
  logger.info(`[URL] Author resolved: ${name} (${url})`);
  return name;
}

/**
 * YouTube: oEmbed から channel 名を取る（APIキー不要）。
 */
async function fetchYoutubeAuthorName(url) {
  const apiUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': 'DiscordBot/1.0' },
    signal: AbortSignal.timeout(AUTHOR_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    // 限定公開・削除済みの動画は 401/404 を返す。取れないだけなので警告に留める
    logger.warn(`[URL] YouTube oEmbed returned ${response.status} for ${url}`);
    return null;
  }

  const data = await response.json();
  const name = data?.author_name || null;
  if (name) logger.info(`[URL] Author resolved: ${name} (${url})`);
  return name;
}

// ========== canvas チャンネル用（URL先の中身まで取りに行く） ==========

/**
 * Check if text contains a URL.
 */
export function containsUrl(text) {
  return URL_REGEX.test(text.trim());
}

/**
 * Extract URL from message text. Returns { url, comment } or null.
 */
export function extractUrl(text) {
  const urlMatch = text.match(URL_REGEX);
  if (!urlMatch) return null;

  const url = urlMatch[0];
  const comment = text.replace(url, '').trim();
  return { url, comment: comment || null };
}

/**
 * Fetch content from a URL (auto-detects Twitter / YouTube / article).
 * Returns {
 *   type: 'twitter' | 'youtube' | 'article',
 *   text, imageUrls, videoUrls, sourceUrl,
 *   author: { name, screenName, url } | null
 * }
 */
export async function fetchUrlContent(url) {
  const twitterMatch = url.match(TWITTER_REGEX);

  if (twitterMatch) {
    const screenName = twitterMatch[3];
    const tweetId = twitterMatch[4];
    return fetchTweet(screenName, tweetId, url);
  }

  if (YOUTUBE_REGEX.test(url)) {
    logger.info(`[Scraper] YouTube URL detected: ${url}`);
    return { type: 'youtube', text: '', imageUrls: [], videoUrls: [], sourceUrl: url, author: null };
  }

  return fetchArticle(url);
}

/**
 * Fetch tweet via FxTwitter API.
 */
async function fetchTweet(screenName, tweetId, originalUrl) {
  const apiUrl = `https://api.fxtwitter.com/${screenName}/status/${tweetId}`;

  try {
    logger.info(`[Scraper] Fetching tweet from ${apiUrl}`);
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'DiscordBot/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn(`[Scraper] FxTwitter returned ${response.status}`);
      return emptyResult(originalUrl, screenName);
    }

    const data = await response.json();
    const tweet = data.tweet;

    if (!tweet) {
      logger.warn(`[Scraper] No tweet data in response`);
      return emptyResult(originalUrl, screenName);
    }

    // Tweet text
    const text = tweet.text || '';

    // Author info
    const author = tweet.author ? {
      name: tweet.author.name || screenName,
      screenName: tweet.author.screen_name || screenName,
      url: `https://x.com/${tweet.author.screen_name || screenName}`,
    } : {
      name: screenName,
      screenName: screenName,
      url: `https://x.com/${screenName}`,
    };

    // Extract media
    const imageUrls = [];
    const videoUrls = [];

    const mediaItems = tweet.media?.all || [];
    // Also check photos/videos arrays as fallback
    if (mediaItems.length === 0 && tweet.media?.photos) {
      mediaItems.push(...tweet.media.photos);
    }
    if (mediaItems.length === 0 && tweet.media?.videos) {
      mediaItems.push(...tweet.media.videos);
    }

    for (const item of mediaItems) {
      if (item.type === 'photo' && item.url) {
        imageUrls.push(item.url);
      } else if ((item.type === 'video' || item.type === 'gif') && item.url) {
        videoUrls.push(item.url);
        // Also grab thumbnail for video
        if (item.thumbnail_url) {
          imageUrls.push(item.thumbnail_url);
        }
      }
    }

    logger.info(`[Scraper] Tweet by @${author.screenName}: "${text.substring(0, 50)}..." (${imageUrls.length} images, ${videoUrls.length} videos)`);
    return { type: 'twitter', text, imageUrls, videoUrls, sourceUrl: originalUrl, author };
  } catch (error) {
    logger.error(`[Scraper] Failed to fetch tweet: ${error.message}`);
    return emptyResult(originalUrl, screenName);
  }
}

function emptyResult(url, screenName = null) {
  return {
    type: 'twitter',
    text: '',
    imageUrls: [],
    videoUrls: [],
    sourceUrl: url,
    author: screenName ? { name: screenName, screenName, url: `https://x.com/${screenName}` } : null,
  };
}

/**
 * Fetch article page and extract 1 representative image (og:image or first img tag).
 * No text extraction.
 */
async function fetchArticle(url) {
  try {
    logger.info(`[Scraper] Fetching article from ${url}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      logger.warn(`[Scraper] HTTP ${response.status} for ${url}`);
      return { type: 'article', text: '', imageUrls: [], videoUrls: [], sourceUrl: url, author: null };
    }

    const html = await response.text();

    // Try og:image first
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    if (ogMatch) {
      let imgUrl = ogMatch[1];
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      logger.info(`[Scraper] Article og:image found: ${imgUrl.substring(0, 80)}`);
      return { type: 'article', text: '', imageUrls: [imgUrl], videoUrls: [], sourceUrl: url, author: null };
    }

    // Fallback: first img tag that's not tiny/svg/ico
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      let imgUrl = match[1];
      if (imgUrl.startsWith('data:')) continue;
      if (/\.(svg|ico)(\?|$)/i.test(imgUrl)) continue;
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
      else if (imgUrl.startsWith('/')) {
        const base = new URL(url);
        imgUrl = base.origin + imgUrl;
      }
      logger.info(`[Scraper] Article fallback image found: ${imgUrl.substring(0, 80)}`);
      return { type: 'article', text: '', imageUrls: [imgUrl], videoUrls: [], sourceUrl: url, author: null };
    }

    logger.info(`[Scraper] No images found for article: ${url}`);
    return { type: 'article', text: '', imageUrls: [], videoUrls: [], sourceUrl: url, author: null };
  } catch (error) {
    logger.error(`[Scraper] Failed to fetch article: ${url}`, error);
    return { type: 'article', text: '', imageUrls: [], videoUrls: [], sourceUrl: url, author: null };
  }
}
