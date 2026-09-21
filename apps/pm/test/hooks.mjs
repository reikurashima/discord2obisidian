// ESM の resolve フック。
// 'discord.js' と 'dotenv/config' をテスト用スタブに差し替えることで、
// 本体のコードを1行も変えずに（＝本番と同じコードのまま）実接続なしで動かす。

const STUBS = {
  'discord.js': './stub/discord.js',
  'dotenv/config': './stub/dotenv-config.js',
};

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
