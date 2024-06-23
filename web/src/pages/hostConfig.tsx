import { useCallback, useEffect, useState } from "react";
import type DiplomaticClient from "../lib/client";

interface IProps {
  client: DiplomaticClient;
}
export default function HostConfig({ client }: IProps) {
  // Could make this configurable.
  const hostURL = "https://localhost:3311";

  const [err, setErr] = useState<Error>();
  const register = useCallback(() => {
    client.register(hostURL)
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
