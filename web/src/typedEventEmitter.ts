type Listener<T> = (data: T) => void;

// TODO: consolidate with eventEmitter.
export default class TypedEventEmitter<T> {
  private listeners: Map<string, Set<Listener<T>>> = new Map();

  // Add an event listener for a specific event type
  public addEventListener(
    eventType: string,
    listener: Listener<T>,
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
  public removeEventListener(eventType: string, listener: Listener<T>): void {
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
