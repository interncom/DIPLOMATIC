import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'

const msgType = "status";

const statusDiv = document.getElementById('status')!

export async function loadLatestStatus(seedHex: string, hostURL: string): Promise<void> {
  try {
    if (!seedHex) throw new Error('Please enter a valid seed')
    if (!hostURL) throw new Error('Please enter a valid host URL')

    const stateMgr = new Diplomatic.SingletonStateManager(msgType)
    stateMgr.on(msgType, () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      statusDiv.textContent = bodyStr
    })

    const store = new Diplomatic.MemoryStore<URL>(Diplomatic.libsodiumCrypto)
    const client = new Diplomatic.SyncClient<URL>(new Diplomatic.Clock(), stateMgr, store, (host) => new Diplomatic.HTTPTransport(host.handle))

    const seed = Diplomatic.htob(seedHex.trim()) as Diplomatic.MasterSeed
    await client.setSeed(seed)
    await client.link({ handle: new URL(hostURL), label: 'host' })
    await client.connect()

    const syncStatus = await client.sync()
    if (syncStatus !== Diplomatic.Status.Success) throw new Error(`Sync failed: ${syncStatus}`)
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}
