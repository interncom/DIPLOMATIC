// Event emitter.

import { IStateEmitter } from "./types";
import { TypedEventEmitter } from "./shared/events";

export class StateEmitter<T> implements IStateEmitter<T> {
  static eventName = "update";
  emitter: TypedEventEmitter<T>;
  constructor(private getter: () => Promise<T>) {
    this.emitter = new TypedEventEmitter();
  }

  get = () => this.getter();

  async emit() {
    const state = await this.getter();
    queueMicrotask(() => this.emitter.emit(StateEmitter.eventName, state));
  }

  listen(func: (state: T) => void) {
    this.emitter.addEventListener(StateEmitter.eventName, func);
    return () => {
      this.emitter.removeEventListener(StateEmitter.eventName, func);
    };
  }
}
