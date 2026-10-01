import { Status } from "../shared/consts";
import { err, ok, type ValStat } from "../shared/valstat";

// Account name for setSeed. A missing label is the default account.
export function accountLabel(raw: string | undefined): ValStat<string> {
  if (raw === undefined) return ok("");
  if (typeof raw !== "string") return err(Status.InvalidParam);
  return ok(raw.trim());
}

// Label for a store that holds one account.
// The first save names it. A different label while it is occupied is InvalidParam.
export function singleAccountLabel(
  current: string | undefined,
  raw: string | undefined,
  occupied: boolean,
): ValStat<string> {
  const [label, lst] = accountLabel(raw);
  if (lst !== Status.Success || label === undefined) {
    return err(Status.InvalidParam);
  }
  if (occupied && current !== undefined && current !== label) {
    return err(Status.InvalidParam);
  }
  return ok(label);
}
