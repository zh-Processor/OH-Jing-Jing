import { invoke } from "@tauri-apps/api/core";

export function call<T>(action: string, args: object = {}, secret?: string): Promise<T> {
  return invoke("run_action", { action, args, secret: secret ?? null });
}
