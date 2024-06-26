import { useEffect, useState } from "react";
import { EventEmitter } from "./eventEmitter";
import type { Applier } from "./types";

export class StateManager {
  emitter: EventEmitter = new EventEmitter();
  applier: Applier;
  constructor(applier: Applier) {
    this.applier = applier;
  }

  apply = async (op: IOp) => {
    await this.applier(op);
    this.emitter.emit(op.type);
  }

  on = (opType: string, listener: () => void) => {
    this.emitter.on(opType, listener);
  }

  off = (opType: string, listener: () => void) => {
    this.emitter.off(opType, listener);
  }
}

export function useStateWatcher<T>(mgr: StateManager, opType: string, callback: () => T): T {
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
