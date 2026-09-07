import { use, useEffect, useRef, useState } from "react";
import { IStateManager } from "../shared/types";
import { dipLog } from "../verbose";

export default function useStateWatcher<T>(
  mgr: IStateManager,
  opType: string,
  callback: () => Promise<T>,
): T | undefined {
  const [val, setVal] = useState<T>();
  useEffect(() => {
    async function update() {
      const t0 = performance.now();
      dipLog(`watcher ${opType} start`);
      const newVal = await callback();
      dipLog(`watcher ${opType} setVal`, {
        ms: Math.round(performance.now() - t0),
      });
      setVal(newVal);
    }
    update();
    mgr.on(opType, update);
    return () => {
      mgr.off(opType, update);
    };
  }, [mgr, opType, callback]);
  return val;
}

export function useStateWatcherSuspense<T>(
  mgr: IStateManager,
  opType: string,
  callback: () => Promise<T>,
): T {
  const promiseRef = useRef<Promise<T>>(callback());

  useEffect(() => {
    async function update() {
      promiseRef.current = callback();
    }
    mgr.on(opType, update);
    return () => {
      mgr.off(opType, update);
    };
  }, [mgr, opType, callback]);

  return use(promiseRef.current);
}
