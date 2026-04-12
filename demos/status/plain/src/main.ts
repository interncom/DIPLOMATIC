import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'

const msgType = "status";

const statusDiv = document.getElementById('status')!

export async function register(seedHex: string, hostURL: string): Promise<void> {
  const stored = localStorage.getItem('status')
  if (stored) statusDiv.textContent = stored

  try {
    if (!seedHex) throw new Error('Please enter a valid seed')
    if (!hostURL) throw new Error('Please enter a valid host URL')

    const stateMgr = new Diplomatic.SingletonStateManager(msgType)
    stateMgr.on(msgType, () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      localStorage.setItem('status', bodyStr)
      statusDiv.textContent = bodyStr
    })

    const { setSeed } = await Diplomatic.genWebClient(stateMgr, new URL(hostURL));
    await setSeed(seedHex);
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}

(window as any).register = register;
