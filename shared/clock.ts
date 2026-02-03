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

// offset returns the estimated offset in milliseconds between client and host.
// It uses an NTP-style algorithm:
//   offset = [(T2 - T1) + (T3 - T4)] / 2
// where:
//   T1 = timeSentClient (client send time)
//   T2 = timeRcvdHost (server receive time)
//   T3 = timeSentHost (server send time)
//   T4 = timeRcvdClient (client receive time)
// This formula averages the two one-way delays to estimate the clock difference.
export function offset(
  timeSentClient: Date,
  timeRcvdHost: Date,
  timeSentHost: Date,
  timeRcvdClient: Date,
): number {
  const delayHostRecv = timeRcvdHost.getTime() - timeSentClient.getTime();
  const delayClientRecv = timeSentHost.getTime() - timeRcvdClient.getTime();
  const offsetMs = (delayHostRecv + delayClientRecv) / 2;
  return offsetMs;
}
