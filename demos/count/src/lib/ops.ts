import { type IOp, Verb } from '../../../../shared/types'

export function genUpsertOp<T>(type: string, body: T, version = 0): IOp {
  return {
    ts: new Date().toISOString(),
    type,
    verb: Verb.UPSERT,
    ver: version,
    body,
  }
}
