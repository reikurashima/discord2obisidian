import path from 'path';
import { validateAttachmentList } from './attachments.js';
import { schemaNames } from './schemas/index.js';
import { buildTriageContext, validateTriageInput } from './triage.js';

// ---- 依頼できる Bot（ホワイトリスト） ---------------------------------
// キューのディレクトリ名と一致させる。ここに無い bot のジョブは即 failed。
export const BOTS = ['pm', 'portal'];

// ---- kind（ホワイトリスト） -------------------------------------------
//
// kind ごとに「何を出力するか」「どのツールを使ってよいか」を固定する。
// ⚠ 既定は読み取りのみ。書き込みが要る kind だけ write: true にすると、
//    /work/<jobId>/out/ 配下にだけ書けるよう実行時にパスを差し込む。
//    （runner 自身は副作用を持たない設計なので、out/ の中身も依頼側が拾って使う）
//
// tools:
//   'none'         … ツールを一切使わせない（文章生成だけ。いちばん安全）
//   'read'         … 読み取り系のみ
//   'workdir-read' … Read だけ。しかも作業ディレクトリ（/work/<jobId>/）の中だけ（添付PDFを読む用）
// write: true … 上記に加えて /work/<jobId>/out/ への書き込みを許す
// bots:        … この kind を依頼できる bot。省略時は BOTS 全部（既存の kind の挙動を変えないため）
// attachments: … 'required' = 添付（["<jobId>.pdf"] の1件）必須 / 'allowed' = 任意 / 省略 = 添付を受け付けない
// instructions … kind 固有の作業手順（プロンプトの「作業の手順」に入る。省略可）
// redactLogs: true … 生の出力（claude の stdout/stderr・解析結果・ジョブの input）を
//              result の logTail と failed/ に残さない。残すのはエラーコードと「どの項目で落ちたか」だけ。
//              機微情報（請求書の取引先・口座・金額）を 14日間ディスクに置かないため
// model:       … この kind で使うモデルを固定する（ジョブ側の model より優先）。省略時はジョブの指定のまま
// dataInputKeys … input のうち「人が書いた文章」のキー。プロンプトでは構造化入力から外し、
//              quoted と同じく <data> の囲いに入れて無害化する（指示として解釈させないため）
// validateInput(input) … input の形の検証。エラー文の配列を返し、1件でもあれば BAD_JOB で弾く
// context(job) … プロンプトの「# 参考情報」に入れる行の配列（runner が計算した確かな値。暦など）

const KINDS = {
  // 疎通確認。input.text をそのまま返させるだけ
  'echo.ping': {
    tools: 'none',
    write: false,
    outputSchemas: ['echo.v1'],
    role: 'あなたは疎通確認用のエコーサービスです。入力された文字列をそのまま返すだけの仕事をします。',
  },

  // Discordのログからタスク候補を抜き出す
  'digest.extract': {
    tools: 'read',
    write: false,
    outputSchemas: ['digest.v1'],
    role: [
      'あなたはDiscordの会話ログから「タスク候補」を抽出する解析エンジンです。',
      '「誰が・いつまでに・何をする」と読み取れる発言だけを候補として拾います。',
      '雑談・感想・完了報告は候補にしません。推測で人名や期限を補わないでください。',
    ].join('\n'),
  },

  // 請求書PDF（外注先から届いたもの）から会計用の項目を読み取る（マイポータル用）
  // ⚠ 請求書は機微情報。読めるのは作業ディレクトリにコピーした添付だけにする
  'invoice.extract': {
    bots: ['portal'],
    tools: 'workdir-read',
    write: false,
    attachments: 'required',
    redactLogs: true,
    outputSchemas: ['invoice.v1'],
    role: [
      'あなたは日本語の請求書（PDF）から会計用の項目を読み取る抽出エンジンです。',
      '請求書に**実際に書かれている値だけ**を読み取ります。読み取れない項目・書かれていない項目は推測せず null にします。',
    ].join('\n'),
    instructions: [
      '添付の請求書PDFを Read ツールで開いて読むこと。スキャン画像のPDFもあるので、その場合は画像として文字を読み取ること。',
      '**読み取れない項目・書かれていない項目は推測せず null にすること。** 他の値からの計算（例: 税抜から税額を割り出す）で埋めないこと。',
      '**⚠ ファイル名（input.fileName）は手がかりにすぎない。ファイル名に含まれる日付（例: 先頭の「0815」）は、請求書の発行日・支払期日とは限らない。**'
        + '日付は必ずPDF本文から読み取り、本文に無ければ null にすること。ファイル名から日付を埋めないこと。',
      '日付は西暦の YYYY-MM-DD にすること（和暦は西暦に直す。例: 令和8年 = 2026年）。年が本文から確定できない日付は null にすること。',
      '金額は円単位の整数にすること（カンマ・円記号・「円」を付けない。例: 110000）。',
      'amount_incl は**源泉徴収を差し引く前の**税込の請求額。「差引ご請求額」「お振込金額」など源泉徴収後の額を入れないこと。',
      'withholding は源泉徴収税額。記載が無ければ null。',
      'issuer_name は請求元（この請求書を発行した側＝外注先）。宛先（「御中」「様」が付く請求先）と取り違えないこと。',
      'invoice_number は適格請求書発行事業者の登録番号（T＋13桁の数字）。請求書番号（No. 等）と混同しないこと。無ければ null。',
      'project_hint は件名・案件名。無ければ null。',
    ],
  },

  // 本人が貼った雑なメモを、マイポータルのタスク（列＝案件ごと）に振り分ける（マイポータル用）
  // ⚠ 文章だけで判断できるのでツールは一切使わせない。登録は依頼側（ポータル）が結果を見て行う
  'task.triage': {
    bots: ['portal'],
    tools: 'none',
    write: false,
    // 本人方針で sonnet 固定（ジョブ側の model 指定より優先する）
    model: 'sonnet',
    outputSchemas: ['tasks.v1'],
    // メモ本文（input.text）は <data> の囲いに移して渡す。
    // ⚠ 本人が書いたメモでも、取引先のメール・チャットをそのまま貼ったものが混ざり得る。
    //    その中の命令文を指示として解釈させないため、quoted と同じ扱いにする
    dataInputKeys: ['text'],
    validateInput: validateTriageInput,
    // 今日の曜日と先6週間の暦（「来週金曜」を日付に直すための表）
    context: buildTriageContext,
    role: [
      'あなたは、本人が書いた雑なメモを「やることリスト（タスク）」に整理する振り分け係です。',
      'メモに**書かれていることだけ**をタスクにします。書かれていないタスク・期限・補足を推測で足さないでください。',
    ].join('\n'),
    instructions: [
      'メモ（<data> の中の input.text）を読み、**意味のまとまりごとに**タスクへ分けること。1行1タスクとは限らない（1行に2つの用事があれば2件、複数行で1つの用事なら1件）。',
      'title は短く具体的に、「〜する」で終わる程度の一文にすること（例: 「背景モデルの修正を送る」）。200文字以内。メモの言い回しを整えるのはよいが、意味を変えないこと。',
      'projectId は input.projects の name（列名）から最も合う列を選び、その **id** を書くこと。**自信が無ければ null**（依頼側で「受信箱」に入る）。',
      '**新しい列（projects に無い id）を作らないこと。** 合う列が無ければ null にすること。',
      'dueDate はメモに期限が書かれている場合だけ、「# 参考情報」の暦を引いて YYYY-MM-DD に直すこと（例: 「明日」「来週金曜」「10/5まで」）。',
      '年の無い日付（例: 10/5）は今日以降で最も近いその日にすること。期限が書かれていなければ null にすること。',
      '「急ぎ」「至急」「重要」「!!」など急ぎ・重要を示す言葉があるタスクだけ starred を true にすること。それ以外は false。',
      'notes はメモに書かれた補足（相手・数量・条件など）をタスクごとに短く添える。無ければ空文字 ""。メモに無いことを書かないこと。',
      '空行・あいさつ・雑談・感想・「済」「完了」「done」など**既に終わったと書いてあるもの**はタスクにしないこと。',
      'タスクが1件も無ければ {"tasks": []} を返すこと。',
    ],
  },
};

export function getKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

export function kindNames() {
  return Object.keys(KINDS);
}

/**
 * その kind が生の出力を残さない（redactLogs）対象か。
 * ⚠ ジョブが rejected でも kind 名さえ分かれば判定する（pm から invoice.extract が来た場合など）
 */
export function isRedactedKind(kind) {
  return getKind(kind)?.redactLogs === true;
}

// 読み取り系として許すツール。
// ⚠ Bash / WebFetch / WebSearch / Task は意図的に含めない。
//    引用データ（他人が書いた文章）に命令文が紛れていた場合の被害を、
//    「読めるが何もできない」に留めるため。
const READ_TOOLS = ['Read', 'Glob', 'Grep'];

// 明示的に拒否するツール。allowedTools だけだと将来ツールが増えたときに漏れるので、
// 危険なものは名指しでも落としておく（二重の網）。
const DENY_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

// tools: 'workdir-read' のときに追加で拒否するもの。
// ⚠ Read 以外の読み取り系（Glob / Grep / LS）も落とす。「Read だけ」を文字どおりにするため。
const WORKDIR_READ_DENY_TOOLS = [
  'Glob', 'Grep', 'LS', 'Write', 'Edit', 'MultiEdit', 'NotebookRead',
];

// tools: 'workdir-read' のときに Read を拒否する場所（コンテナ内の絶対パス）。
//
// ⚠⚠ 二重の網。1枚目は「cwd を作業ディレクトリにする」「許可を作業ディレクトリに絞る」。
//    ただし許可側のパス指定構文が実機で効くかは確かめられていない（認証が無く claude を実行できない）。
//    また Claude Code は読み取り系ツールを既定で許していることがあるため、
//    許可側だけに頼ると「作業ディレクトリの外も読めてしまう」恐れがある。
//    そこで拒否側で、読まれて困る場所を名指しで塞ぐ（拒否は許可より優先される）。
//      /root  … claude の認証情報（/root/.claude）
//      /queue … 他のジョブ・他の bot のデータ、他の請求書PDF
//      /app   … runner 自身のソース
//      /etc /proc /sys … 環境変数・秘密情報の取り出し口
//    ⚠ /work は塞げない（作業ディレクトリがその下にあり、拒否が優先されてしまうため）。
//      runner は1プロセス直列なので、/work の下に他のジョブが同時に居ることは無い。
const WORKDIR_READ_DENY_PATHS = [
  '/root', '/queue', '/app', '/etc', '/proc', '/sys', '/home', '/var', '/tmp', '/usr', '/opt', '/run', '/dev',
];

/**
 * kind と作業ディレクトリから `claude -p` に渡すツール制限の引数を組み立てる。
 * outDir は /work/<jobId>/out（このパス配下だけ書き込みを許す）
 * workDir は /work/<jobId>（tools: 'workdir-read' のときだけ使う。省略時は outDir の親）
 */
export function buildToolArgs(kindDef, outDir, workDir = path.posix.dirname(toPosix(outDir))) {
  const allowed = [];
  const denied = [...DENY_TOOLS];
  if (kindDef.tools === 'read') allowed.push(...READ_TOOLS);
  if (kindDef.tools === 'workdir-read') {
    const wd = toPosix(workDir);
    // 許可は作業ディレクトリの中の Read だけ。
    // ⚠ パス規則の書き方が2通りある（`./` = cwd 相対 / `//` = ルートからの絶対パス）。
    //    どちらが CLI で効くか実機未確認なので両方書く。どちらも作業ディレクトリの中しか指さない
    allowed.push('Read(./**)', `Read(/${wd}/**)`);
    denied.push(...WORKDIR_READ_DENY_TOOLS);
    for (const p of WORKDIR_READ_DENY_PATHS) {
      // 同じく2通りで書く（`//x` = 絶対パス / `/x` = 解釈違いでも害のない側に倒れる）
      denied.push(`Read(/${p}/**)`, `Read(${p}/**)`);
    }
    denied.push('Read(~/**)');
  }
  if (kindDef.write) {
    // パス指定つきで許可する。out/ の外へは書けない
    allowed.push(`Write(${outDir}/**)`, `Edit(${outDir}/**)`);
  }

  const args = [];
  // ⚠ tools: 'none' のときは --allowedTools に空文字を渡す。
  //    引数ごと省くと既定の許可セットが効いてしまうため、必ず明示する。
  args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', denied.join(','));
  return args;
}

/** Windows で検証するときも、ルールには POSIX 形式のパスを書く（本番は Linux） */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function validateJobShape(job, fileName, laneBot) {
  const errors = [];
  const expectedId = fileName.replace(/\.json$/, '');

  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { errorCode: 'BAD_JOB', errors: ['job must be a JSON object'] };
  }
  // jobId とファイル名がズレていると result の突き合わせができなくなる
  if (job.jobId !== expectedId) {
    return { errorCode: 'BAD_JOB', errors: [`jobId "${job.jobId}" does not match file name "${fileName}"`] };
  }
  if (!BOTS.includes(job.bot)) {
    return { errorCode: 'UNKNOWN_BOT', errors: [`bot "${job.bot}" is not allowed (allowed: ${BOTS.join(', ')})`] };
  }
  // ⚠ 置かれたキューと自称 bot が食い違うジョブは受け付けない。
  //    pm の inbox に portal を名乗るジョブを置けてしまうと、
  //    「どちらのキューに結果を返すか」が曖昧になり、権限の線引きも崩れる
  if (laneBot && job.bot !== laneBot) {
    return { errorCode: 'UNKNOWN_BOT', errors: [`bot "${job.bot}" does not match queue lane "${laneBot}"`] };
  }
  const kindDef = getKind(job.kind);
  if (!kindDef) {
    return { errorCode: 'UNKNOWN_KIND', errors: [`kind "${job.kind}" is not allowed (allowed: ${kindNames().join(', ')})`] };
  }
  // kind ごとの bot ホワイトリスト。
  // ⚠ 請求書のように機微な kind を、関係ない bot（pm）から使わせない
  if (kindDef.bots && !kindDef.bots.includes(job.bot)) {
    return { errorCode: 'UNKNOWN_KIND', errors: [`kind "${job.kind}" is not allowed for bot "${job.bot}" (allowed bots: ${kindDef.bots.join(', ')})`] };
  }
  if (!schemaNames().includes(job.outputSchema)) {
    return { errorCode: 'UNKNOWN_SCHEMA', errors: [`outputSchema "${job.outputSchema}" is not defined (defined: ${schemaNames().join(', ')})`] };
  }
  // kind と outputSchema の組み合わせまで見る。
  // digest.extract に echo.v1 を要求されても、検証が緩くなるだけで意味がないため
  if (!kindDef.outputSchemas.includes(job.outputSchema)) {
    return {
      errorCode: 'UNKNOWN_SCHEMA',
      errors: [`outputSchema "${job.outputSchema}" is not allowed for kind "${job.kind}" (allowed: ${kindDef.outputSchemas.join(', ')})`],
    };
  }
  if (job.quoted !== undefined && !Array.isArray(job.quoted)) {
    errors.push('quoted must be an array when present');
  }
  // 添付。名前の形（パストラバーサル対策）はここで弾く。ファイルの有無は runner が見る
  // ⚠ 許すのは ["<jobId>.pdf"] の1件だけ（他のジョブの添付を指させない）
  // ⚠ 添付を受け付けない kind の空配列（"attachments": []）は「添付なし」として通す。
  //    task.triage の契約ではポータルが [] を付けて送ってくるため。
  //    添付を使う kind（invoice.extract）の空配列は従来どおり BAD_JOB（["<jobId>.pdf"] の1件だけ）
  const noAttachmentsGiven = !kindDef.attachments && Array.isArray(job.attachments) && job.attachments.length === 0;
  if (!noAttachmentsGiven) errors.push(...validateAttachmentList(job.attachments, job.jobId));
  const attachmentCount = Array.isArray(job.attachments) ? job.attachments.length : 0;
  if (!kindDef.attachments && attachmentCount > 0) {
    errors.push(`kind "${job.kind}" does not accept attachments`);
  }
  if (kindDef.attachments === 'required' && attachmentCount === 0) {
    errors.push(`kind "${job.kind}" requires at least one attachment`);
  }
  // kind 固有の input 検証（task.triage の text 4000文字上限・today 必須など）。
  // ⚠ 壊れた入力で claude を回しても推測で埋めた結果しか返らないので、実行前に弾く
  if (typeof kindDef.validateInput === 'function') {
    errors.push(...kindDef.validateInput(job.input));
  }
  if (errors.length > 0) return { errorCode: 'BAD_JOB', errors };

  return { errorCode: null, errors: [], kindDef };
}
