import * as digestV1 from './digest.v1.js';
import * as echoV1 from './echo.v1.js';

// outputSchema 名 → スキーマモジュール。
// ここに無い名前のジョブは受け付けない（未知スキーマを「検証なしで素通し」にしないため）。
const SCHEMAS = new Map([
  [digestV1.name, digestV1],
  [echoV1.name, echoV1],
]);

export function getSchema(schemaName) {
  return SCHEMAS.get(schemaName) || null;
}

export function schemaNames() {
  return [...SCHEMAS.keys()];
}
