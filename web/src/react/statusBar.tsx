import type { IDiplomaticClientState, IDiplomaticClientXferState } from "../types";

function GlowingDot({ on }: { on: boolean }) {
  const color = on ? "#01FF70" : "#AAAAAA";
  const size = 6;
  return <div style={{ width: size, height: size, borderRadius: "50%", boxShadow: `0 0 4px ${color}`, backgroundColor: color }} />
}

function DotLabel({ on, label }: { on: boolean, label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "row", marginRight: 16, alignItems: "center", gap: 6 }}>
      <GlowingDot on={on} />
      {label}
    </div >
  )
}

interface IProps {
  state: IDiplomaticClientState;
  xferState: IDiplomaticClientXferState;
}
export default function ClientStatusBar({ state, xferState }: IProps) {
  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 8,
        padding: "8px 16px",
        border: '1px solid grey',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-around',
      }}
    >
      <DotLabel on={state.hasSeed} label="SEED" />
      <DotLabel on={state.hasHost} label="HOST" />
      <DotLabel on={state.connected} label="LINK" />
      <div style={{ marginRight: 16 }}>
        ⇑ {xferState.numUploads}
      </div>
      <div>
        ⇓ {xferState.numDownloads}
      </div>
    </div >
  );
}
