import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'

const statusDiv = document.getElementById('status')!

export async function loadLatestStatus(seed: string, hostUrl: string): Promise<void> {
  try {
    const seedHex = seed.trim() || 'your-seed-here'
    const hostURL = hostUrl.trim() || 'your-host-here'
    if (!seedHex || seedHex === 'your-seed-here') throw new Error('Please enter a valid seed')
    if (!hostURL || hostURL === 'your-host-here') throw new Error('Please enter a valid host URL')
    const url = new URL(hostURL)
    await Diplomatic.libsodiumCrypto.sodium.ready
    const stateMgr = new Diplomatic.SingletonStateManager('status')
    stateMgr.on("status", () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      statusDiv.textContent = bodyStr
    })
    const store = new Diplomatic.MemoryStore(Diplomatic.libsodiumCrypto)
    const client = new Diplomatic.SyncClient(new Diplomatic.Clock(), stateMgr, store, (host) => new Diplomatic.HTTPTransport(host.handle))

    const mseed = Diplomatic.htob(seedHex) as Diplomatic.MasterSeed
    await client.setSeed(mseed)
    await client.link({ handle: url, label: 'host' })
    await client.connect()

    const syncStatus = await client.sync()
    if (syncStatus !== Diplomatic.Status.Success) throw new Error(`Sync failed: ${syncStatus}`)
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}
