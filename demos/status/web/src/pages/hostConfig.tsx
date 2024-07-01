import type { DiplomaticClient } from "@interncom/diplomatic";
import { useCallback, useEffect, useState } from "react";

interface IProps {
  client: DiplomaticClient;
}
export default function HostConfig({ client }: IProps) {
  // Could make this configurable.
  // const hostURL = "http://localhost:8787";
  const hostURL = "https://diplomatic-cloudflare-host.root-a00.workers.dev";

  const [err, setErr] = useState<Error>();
  const register = useCallback(() => {
    client.register(hostURL)
      .then(() => client.connect(new URL(hostURL)))
      // .then(() => console.info("registered"))
      .catch(err => { setErr(err) });
  }, [client]);
  useEffect(() => { register() }, [register]);

  return (
    <div>
      {/* TODO: in case of error add a retry button. */}
      {err ? err.message : "Registering with host..."}
    </div>
  );
}
