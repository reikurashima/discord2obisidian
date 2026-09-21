import { schemaNames } from './schemas/index.js';

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
//   'none'  … ツールを一切使わせない（文章生成だけ。いちばん安全）
//   'read'  … 読み取り系のみ
// write: true … 上記に加えて /work/<jobId>/out/ への書き込みを許す

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
};

export function getKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

export function kindNames() {
  return Object.keys(KINDS);
}

// 読み取り系として許すツール。
// ⚠ Bash / WebFetch / WebSearch / Task は意図的に含めない。
//    引用データ（他人が書いた文章）に命令文が紛れていた場合の被害を、
//    「読めるが何もできない」に留めるため。
const READ_TOOLS = ['Read', 'Glob', 'Grep'];

// 明示的に拒否するツール。allowedTools だけだと将来ツールが増えたときに漏れるので、
// 危険なものは名指しでも落としておく（二重の網）。
const DENY_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

/**
 * kind と作業ディレクトリから `claude -p` に渡すツール制限の引数を組み立てる。
 * outDir は /work/<jobId>/out（このパス配下だけ書き込みを許す）
 */
export function buildToolArgs(kindDef, outDir) {
  const allowed = [];
  if (kindDef.tools === 'read') allowed.push(...READ_TOOLS);
  if (kindDef.write) {
    // パス指定つきで許可する。out/ の外へは書けない
    allowed.push(`Write(${outDir}/**)`, `Edit(${outDir}/**)`);
  }

  const args = [];
  // ⚠ tools: 'none' のときは --allowedTools に空文字を渡す。
  //    引数ごと省くと既定の許可セットが効いてしまうため、必ず明示する。
  args.push('--allowedTools', allowed.join(','));
  args.push('--disallowedTools', DENY_TOOLS.join(','));
  return args;
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
  if (errors.length > 0) return { errorCode: 'BAD_JOB', errors };

  return { errorCode: null, errors: [], kindDef };
}
