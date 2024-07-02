import { useState, useEffect } from "react";
import type { StateManager } from "../state";

export default function useStateWatcher<T>(mgr: StateManager, opType: string, callback: () => T): T {
  const [val, setVal] = useState(callback());
  useEffect(() => {
    function update() {
      const newVal = callback();
      setVal(newVal);
    }
    mgr.on(opType, update);
    return () => {
      mgr.off(opType, update);
    }
  }, [mgr, opType, callback]);
  return val;
}
