import { expect, test, vi, describe, beforeEach } from 'vitest'
import { NeoClient } from '../src/neoclient'
import { StateManager } from '../src/state'
import type { IHostConnectionInfo } from '../src/shared/types'

describe('NeoClient', () => {
  let mockClock: any;
  let mockStore: any;
  let mockState: any;
  let client: NeoClient;

  beforeEach(() => {
    mockClock = { now: vi.fn(() => new Date()) };
    mockStore = {
      hosts: {
        add: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined)
      },
      seed: {
        load: vi.fn().mockResolvedValue(undefined)
      },
      uploads: { count: vi.fn().mockResolvedValue(0) },
      downloads: { count: vi.fn().mockResolvedValue(0) }
    };
    const applier = vi.fn();
    const clear = vi.fn();
    mockState = new StateManager(applier, clear);
    client = new NeoClient(mockClock, mockState, mockStore);
  });

  test('instantiates NeoClient', () => {
    expect(client).toBeInstanceOf(NeoClient);
  });

  test('link adds host to store', async () => {
    const host: IHostConnectionInfo = {
      url: new URL('https://example.com'),
      label: 'test',
      idx: 1
    };
    await client.link(host);
    expect(mockStore.hosts.add).toHaveBeenCalledWith(host);
  });

  test('unlink removes host from store', async () => {
    const label = 'test';
    await client.unlink(label);
    expect(mockStore.hosts.del).toHaveBeenCalledWith(label);
  });
});
