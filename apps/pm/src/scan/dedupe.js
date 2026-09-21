import crypto from 'crypto';

// 候補の「同じもの判定」。
//
// 使いどころは2つ:
//   1. 既存タスクと重複する候補を出さない
//   2. decision:"ignore" にされた候補を次回以降 再提案しない
//
// ⚠ 完全一致だけでは役に立たない（Claudeは毎回少しずつ違う言い回しでタイトルを書く）。
//    かといって凝った類似度を入れると「消えるべきでない候補が消える」ほうが痛い。
//    そこで「正規化して、一方が他方を含むか」までに留める。

/** 記号・空白・助詞まわりの揺れを落として比較用の形にする */
export function normalizeTitle(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    // 句読点・記号は落とす（「〜の提出。」と「〜の提出」を同じ扱いにするため）
    .replace(/[、。．，!！?？「」『』（）()[\]【】<>＜＞:：;；'"`~・…\-—ー_/\\|*+=#@$%^&]/g, '');
}

export function normalizeName(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');
}

/**
 * 却下記録用の指紋。タイトル（正規化）と担当者名（正規化）だけで作る。
 * 発言IDにしないのは、同じ依頼が別の言い方でまた出てきたときにも効かせたいため。
 */
export function fingerprint(title, assigneeName) {
  const key = `${normalizeTitle(title)}|${normalizeName(assigneeName)}`;
  return crypto.createHash('sha1').update(key, 'utf-8').digest('hex').slice(0, 16);
}

/** タイトルが「ほぼ同じ」か。短すぎる文字列の巻き込みを避けるため最低長を設ける */
export function titlesLookSame(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 6 || y.length < 6) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 既存タスクと重複しているか。
 * 担当者が食い違うなら別件として残す（同じ内容でも人が違えば別のタスク）。
 * 候補側の担当者が読み取れていない（null）場合は、タイトルだけで判断する。
 */
export function duplicatesExistingTask(candidate, tasks) {
  return tasks.some((task) => {
    if (!titlesLookSame(candidate.title, task.title)) return false;
    const a = normalizeName(candidate.assignee_name);
    const b = normalizeName(task.assigneeName);
    if (!a || !b) return true;
    return a === b || a.includes(b) || b.includes(a);
  });
}
