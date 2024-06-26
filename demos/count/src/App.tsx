import { useState, useCallback } from 'react'
import './App.css'
import useClient from './lib/useClient'
import { localStorageStore } from './lib/localStorageStore'
import { type IOp, Verb } from '../../../shared/types'
import { htob } from '../../../shared/lib'

export default function App() {
  const [count, setCount] = useState(0);
  const applier = useCallback((op: IOp) => {
    if (op.type === "count" && typeof op.body === "number") {
      setCount(op.body)
    }
  }, [])
  const [client] = useClient({
    store: localStorageStore,
    applier,
    seed: htob("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"),
    hostURL: "https://diplomatic-cloudflare-host.root-a00.workers.dev",
    hostID: "cfhost",
    refreshInterval: 100,
  })
  const countUp = useCallback(() => {
    client.apply({
      ts: new Date().toISOString(),
      type: "count",
      verb: Verb.UPSERT,
      ver: 0,
      body: count + 1,
    })
  }, [client, count])

  return (
    <>
      <h1>COUNT</h1>
      <h2>{count}</h2>
      <button type="button" onClick={countUp}>+1</button>
    </>
  )
}
