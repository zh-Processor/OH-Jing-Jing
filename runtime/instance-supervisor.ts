import { fork, type ChildProcess } from "node:child_process";
import { instanceConfigIsCurrent, type InstanceEntry, type InstancePreflightFailure, type InstanceStartupResult } from "./instance-config.js";

export type InstanceAction = "start" | "stop" | "restart";
type State = "stopped" | "starting" | "running" | "stopping" | "waiting";
type Instance = {
  entry: InstanceEntry; state: State; wanted: boolean; child?: ChildProcess; closed?: Promise<void>;
  restart: boolean; failures: number; started?: number; retryAt?: string; retry?: ReturnType<typeof setTimeout>;
  lastExit: number | null; updating?: boolean;
};
type ConfigurationTrial = { checks: NodeJS.ProcessEnv; commit: () => void };

export function superviseInstances(entries: InstanceEntry[], serverEntry: string, execArgv: string[]) {
  const instances = new Map<string, Instance>(entries.map(entry => [entry.id, {
    entry, state: "stopped", wanted: entry.start, restart: false, failures: 0, lastExit: null,
  }]));
  let closing = false;

  function requestStop(instance: Instance) {
    const child = instance.child;
    if (!child || instance.state === "stopping") return;
    instance.state = "stopping";
    const timeout = setTimeout(() => { if (instance.child === child) child.kill(); }, 10_000);
    timeout.unref();
    child.once("close", () => clearTimeout(timeout));
    if (child.connected) child.send("shutdown", () => {});
  }

  function afterExit(instance: Instance) {
    instance.state = "stopped";
    if (closing || !instance.wanted) return;
    if (instance.restart) {
      instance.restart = false;
      instance.failures = 0;
      launch(instance);
      return;
    }
    if (instance.started && Date.now() - instance.started >= 30_000) instance.failures = 0;
    const delay = 1_000 * 2 ** Math.min(instance.failures++, 5);
    instance.state = "waiting";
    instance.retryAt = new Date(Date.now() + delay).toISOString();
    instance.retry = setTimeout(() => {
      instance.retry = undefined;
      instance.retryAt = undefined;
      launch(instance);
    }, delay);
  }

  function launch(instance: Instance, trial?: ConfigurationTrial): Promise<InstanceStartupResult> {
    if (closing || !instance.wanted || instance.child) return Promise.resolve({ ok: false });
    if (!instanceConfigIsCurrent(instance.entry)) {
      instance.state = "stopped";
      instance.wanted = false;
      instance.lastExit = 1;
      return Promise.resolve({ ok: false });
    }
    instance.state = "starting";
    instance.started = undefined;
    let child: ChildProcess;
    try {
      child = fork(serverEntry, [], { env: { ...instance.entry.env, ...trial?.checks, OHJINGJING_CONFIG_TRIAL: trial ? "1" : undefined }, execArgv, windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"] });
    } catch {
      instance.lastExit = 1;
      if (!trial) afterExit(instance);
      else instance.state = "stopped";
      return Promise.resolve({ ok: false });
    }
    instance.child = child;
    const startup = setTimeout(() => requestStop(instance), trial ? 22_000 : 15_000);
    startup.unref();
    let committed = !trial;
    let failure: InstancePreflightFailure | undefined;
    return new Promise(resolveReady => {
      child.on("message", (message: unknown) => {
        const frame = message as { type?: string; preflightFailure?: InstancePreflightFailure } | null;
        const type = frame?.type;
        if (instance.state !== "starting") return;
        if (trial && !committed && frame?.preflightFailure) { failure = frame.preflightFailure; return; }
        if (trial && !committed && type === "ready") {
          try { trial.commit(); }
          catch { requestStop(instance); return; }
          committed = true;
          child.send("activate", () => {});
          return;
        }
        if (type !== (trial ? "activated" : "ready") || !committed) return;
        clearTimeout(startup);
        instance.started = Date.now();
        instance.state = "running";
        resolveReady({ ok: true });
      });
      child.on("error", () => { instance.lastExit = 1; });
      instance.closed = new Promise(resolve => child.once("close", (code, signal) => {
        clearTimeout(startup);
        instance.lastExit = code ?? (signal ? 1 : instance.lastExit);
        instance.child = undefined;
        instance.closed = undefined;
        if (committed) afterExit(instance);
        else instance.state = "stopped";
        resolveReady({ ok: !!trial && committed, failure });
        resolve();
      }));
    });
  }

  function apply(instance: Instance, action: InstanceAction) {
    clearTimeout(instance.retry);
    instance.retry = undefined;
    instance.retryAt = undefined;
    instance.wanted = action !== "stop";
    if (instance.child) {
      if (action === "stop") instance.restart = false;
      else if (action === "restart" || instance.state === "stopping") instance.restart = true;
      if (action !== "start") requestStop(instance);
    } else if (instance.wanted) {
      instance.failures = 0;
      launch(instance);
    } else instance.state = "stopped";
  }

  return {
    start() { for (const instance of instances.values()) launch(instance); },
    list() { return [...instances.values()].map(instance => ({
      id: instance.entry.id, name: instance.entry.name, address: instance.entry.address, state: instance.state,
      wanted: instance.wanted, pid: instance.child?.pid ?? null, lastExit: instance.lastExit, retryAt: instance.retryAt ?? null,
      updating: instance.updating ?? false,
    })); },
    entries() { return [...instances.values()].map(instance => instance.entry); },
    control(id: string, action: InstanceAction) {
      const instance = instances.get(id);
      if (closing || !instance) return "missing";
      if (instance.updating) return "busy";
      if (action !== "stop" && !instanceConfigIsCurrent(instance.entry)) return "changed";
      apply(instance, action);
      return "accepted";
    },
    async publish(candidate: InstanceEntry, previous: InstanceEntry, trial: ConfigurationTrial): Promise<InstanceStartupResult> {
      const instance = instances.get(candidate.id);
      if (closing || !instance || instance.updating) return { ok: false };
      instance.updating = true;
      const wanted = instance.wanted;
      try {
        const closed = instance.closed;
        apply(instance, "stop");
        await closed;
        if (closing) return { ok: false };
        instance.entry = candidate;
        instance.wanted = wanted;
        let failed: InstanceStartupResult = { ok: false };
        if (wanted) {
          failed = await launch(instance, trial);
          if (failed.ok) return failed;
        } else {
          try { trial.commit(); return { ok: true }; } catch { /* Keep using the previous configuration. */ }
        }
        instance.entry = previous;
        instance.wanted = wanted;
        if (!closing && wanted) {
          instance.failures = 0;
          await launch(instance);
        }
        return failed;
      } finally {
        instance.updating = false;
      }
    },
    async close() {
      closing = true;
      const pending = [...instances.values()].flatMap(instance => instance.closed ? [instance.closed] : []);
      for (const instance of instances.values()) apply(instance, "stop");
      await Promise.all(pending);
    },
  };
}
