import * as digestV1 from './digest.v1.js';
import * as echoV1 from './echo.v1.js';
import * as invoiceV1 from './invoice.v1.js';

// outputSchema 名 → スキーマモジュール。
// ここに無い名前のジョブは受け付けない（未知スキーマを「検証なしで素通し」にしないため）。
//
// スキーマモジュールの形: { name, describe(), validate(value) } と、任意で normalize(value)。
// normalize があれば runner が validate の前に1回だけ通し、その結果を output に使う。
const SCHEMAS = new Map([
  [digestV1.name, digestV1],
  [echoV1.name, echoV1],
  [invoiceV1.name, invoiceV1],
]);

export function getSchema(schemaName) {
  return SCHEMAS.get(schemaName) || null;
}

export function schemaNames() {
  return [...SCHEMAS.keys()];
}
