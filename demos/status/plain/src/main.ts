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

    const { setSeed } = await Diplomatic.genWebClient(stateMgr, new URL(hostURL));
    await setSeed(seedHex);
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}
