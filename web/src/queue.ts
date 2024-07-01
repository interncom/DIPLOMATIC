import type { IQueue } from "./types";

export class Queue<K, V> implements IQueue<K, V> {
  private map: Map<K, V>;

  constructor() {
    this.map = new Map<K, V>();
  }

  async enqueue(key: K, value: V): Promise<void> {
    this.map.set(key, value);
  }

  async peek(key: K): Promise<V | undefined> {
    return this.map.get(key);
  }

  async entries(): Promise<Array<[K, V]>> {
    return Array.from(this.map.entries());
  }

  async dequeue(key: K): Promise<V | undefined> {
    const value = this.map.get(key);
    this.map.delete(key);
    return value;
  }

  async size(): Promise<number> {
    return this.map.size;
  }
}
