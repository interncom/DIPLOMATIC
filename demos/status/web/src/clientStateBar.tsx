import type { IDiplomaticClientState } from "@interncom/diplomatic";

interface IProps {
  state: IDiplomaticClientState;
}
export default function ClientStateBar({ state }: IProps) {
  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 8,
        padding: 8,
        border: '1px solid grey',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-around',
      }}
    >
      <div style={{ marginRight: 16 }}>
        🗝️ {state.hasSeed ? 'SET' : 'NONE'}
      </div>
      <div style={{ marginRight: 16 }}>
        🏛️ {state.hasHost ? 'HOST' : 'NONE'}
      </div>
      <div style={{ marginRight: 16 }}>
        📶 {state.connected ? 'ONLINE' : 'OFFLINE'}
      </div>
      <div style={{ marginRight: 16 }}>
        ⇑ {state.numUploads}
      </div>
      <div>
        ⇓ {state.numDownloads}
      </div>
    </div >
  );
}
