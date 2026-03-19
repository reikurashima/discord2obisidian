import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let model = null;

function getModel() {
  if (!model) {
    const genAI = new GoogleGenerativeAI(config.ai.geminiApiKey);
    model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }
  return model;
}

/**
 * Clean up rough/spoken text into concise written text.
 */
export async function cleanupText(rawText) {
  try {
    const m = getModel();
    const result = await m.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `あなたはテキストエディターです。以下の雑な文章を整えてください。
ルール:
- 文法を修正し、フィラー（えーと、まあ、なんか等）を除去する
- 簡潔にまとめるが、元の意味とトーンは保つ
- 整えたテキストのみを出力し、説明や前置きは不要
- 入力と同じ言語で回答する

入力:
${rawText}`,
            },
          ],
        },
      ],
    });

    const cleaned = result.response.text().trim();
    logger.info(`[AI] Text cleaned: "${rawText.substring(0, 30)}..." -> "${cleaned.substring(0, 30)}..."`);
    return cleaned;
  } catch (error) {
    logger.error('[AI] cleanupText failed, using original text', error);
    return rawText;
  }
}

/**
 * Summarize article/tweet content into 2-3 concise lines.
 */
export async function summarizeContent(text, sourceUrl) {
  try {
    const m = getModel();
    const result = await m.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `以下のコンテンツを2〜3行で超簡潔に要約してください。
ルール:
- 要点と注目すべき詳細を含める
- 要約のみを出力し、説明や前置きは不要
- コンテンツと同じ言語で回答する（日本語のコンテンツには日本語で）

ソースURL: ${sourceUrl}

コンテンツ:
${text.substring(0, 4000)}`,
            },
          ],
        },
      ],
    });

    const summary = result.response.text().trim();
    logger.info(`[AI] Content summarized from ${sourceUrl}`);
    return summary;
  } catch (error) {
    logger.error('[AI] summarizeContent failed', error);
    return `(要約失敗) ${text.substring(0, 200)}...`;
  }
}
