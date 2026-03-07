import { use, useEffect, useRef, useState } from "react";
import { IStateManager } from "../types";

export default function useStateWatcher<T>(
  mgr: IStateManager,
  opType: string,
  callback: () => Promise<T>,
): T | undefined {
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
