type Listener = () => void;

export class EventEmitter {
  private events: { [key: string]: Listener[] } = {};

  on(event: string, listener: Listener): void {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  off(event: string, listener: Listener): void {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(l => l !== listener);
  }

  // Method to emit an event
  emit(event: string): void {
    if (!this.events[event]) return;
    for (const listener of this.events[event]) {
      listener();
    }
  }
}
