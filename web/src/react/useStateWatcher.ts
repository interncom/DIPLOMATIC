import { useState, useEffect } from "react";
import type { StateManager } from "../state";

export default function useStateWatcher<T>(mgr: StateManager, opType: string, callback: () => Promise<T>): T | undefined {
  const [val, setVal] = useState<T>();
  useEffect(() => {
    async function update() {
      const newVal = await callback();
      setVal(newVal);
    }
    update();
    mgr.on(opType, update);
    return () => {
      mgr.off(opType, update);
    }
  }, [mgr, opType, callback]);
  return val;
}
