export interface IClock {
  now(): Date;
}

export class Clock implements IClock {
  now() {
    return new Date();
  }
}

export class MockClock implements IClock {
  constructor(private _now: Date) {}
  set(_now: Date) {
    this._now = _now;
  }
  now() {
    return this._now;
  }
}
