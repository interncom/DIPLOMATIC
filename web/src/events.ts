import { IStateEmitter } from "./types";

type TypedListener<T> = (data: T) => void;

export class TypedEventEmitter<T> {
  private listeners: Map<string, Set<TypedListener<T>>> = new Map();

  // Add an event listener for a specific event type
  public addEventListener(
    eventType: string,
    listener: TypedListener<T>,
  ): () => void {
    let listeners = this.listeners.get(eventType);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(eventType, listeners);
    }

    listeners.add(listener);

    // Return cleanup function for easy useEffect integration
    return () => {
      this.removeEventListener(eventType, listener);
    };
  }

  // Remove an event listener
  public removeEventListener(
    eventType: string,
    listener: TypedListener<T>,
  ): void {
    const listenerSet = this.listeners.get(eventType);
    if (listenerSet) {
      listenerSet.delete(listener);
      // Clean up empty sets to prevent memory leaks
      if (listenerSet.size === 0) {
        this.listeners.delete(eventType);
      }
    }
  }

  // Emit an event to all subscribers
  public emit(eventType: string, data: T): void {
    const listenerSet = this.listeners.get(eventType);
    if (listenerSet) {
      // Create a copy to prevent issues if listeners modify the set during iteration
      const listeners = Array.from(listenerSet);
      for (const listener of listeners) {
        listener(data);
      }
    }
  }
}

export class StateEmitter<T> implements IStateEmitter<T> {
  static eventName = "update";
  emitter: TypedEventEmitter<T>;
  constructor(private getter: () => Promise<T>) {
    this.emitter = new TypedEventEmitter();
  }

  get = () => this.getter();

  async emit() {
    const state = await this.getter();
    this.emitter.emit(StateEmitter.eventName, state);
  }

  listen(func: (state: T) => void) {
    this.emitter.addEventListener(StateEmitter.eventName, func);
    return () => {
      this.emitter.removeEventListener(StateEmitter.eventName, func);
    };
  }
}
