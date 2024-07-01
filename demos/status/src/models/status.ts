import type { IStatus } from "../App";

export function store(status: IStatus) {
  localStorage.setItem("status", status.status);
  localStorage.setItem("updatedAt", new Date().toISOString());
}

export function load(): IStatus | undefined {
  const status = localStorage.getItem("status") ?? undefined;
  const updatedAt = localStorage.getItem("updatedAt") ?? undefined;
  if (!status || !updatedAt) {
    return undefined;
  }
  return { status, updatedAt };
}
