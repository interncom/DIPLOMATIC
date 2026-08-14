import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'

const msgType = "status";

const statusDiv = document.getElementById('status')!

export async function register(): Promise<void> {
  const stored = localStorage.getItem('status')
  if (stored) statusDiv.textContent = stored

  try {
    const seedHex = (document.getElementById('seed') as HTMLInputElement).value
    const hostURL = (document.getElementById('host') as HTMLInputElement).value

    if (!seedHex) throw new Error('Enter a valid seed (64 hex chars)')
    if (!hostURL) throw new Error('Enter a valid host URL')

    const stateMgr = new Diplomatic.SingletonStateManager(msgType)
    stateMgr.on(msgType, () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      localStorage.setItem('status', bodyStr)
      statusDiv.textContent = bodyStr
    })

    const [enclave, st] = Diplomatic.Enclave.fromBytes(
      Diplomatic.htob(seedHex),
    );
    if (st !== Diplomatic.Status.Success || enclave === undefined) {
      throw new Error(`invalid seed (${st})`);
    }
    const { client } = await Diplomatic.openDiplomaticClient({
      state: stateMgr,
    });
    await client.setSeed(enclave);
    await client.link({ handle: new URL(hostURL), label: "host" });
    await client.connect();
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}

(window as any).register = register;
