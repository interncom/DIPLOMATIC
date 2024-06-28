import { type IOp, Verb } from './types.ts'

export function genUpsertOp<T>(type: string, body: T, version = 0): IOp {
  return {
    ts: new Date().toISOString(),
    type,
    verb: Verb.UPSERT,
    ver: version,
    body,
  }
}

export function isOp(op: any): op is IOp {
  return typeof op.ts === 'string' &&
    (op.verb === 'UPSERT' || op.verb === 'DELETE') &&
    typeof op.type === 'string' &&
    typeof op.ver === 'number' &&
    op.ver >= 0 &&
    op.body !== undefined;
}
