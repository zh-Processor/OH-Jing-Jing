import { randomUUID } from "node:crypto";
import { validateEndpoint, type ModelProfile } from "./models.js";
import type { openStore } from "./store.js";

type Binding = { slot: string | null; origin: string | null };
export type DesktopServiceProfile = { id: string; name: string; address: string; hasCredential: boolean };
export type CredentialFrame = { key?: unknown; binding?: unknown; change?: unknown;
  backup?: { modelId?: unknown; key?: unknown; binding?: unknown } | null;
  subscription?: { key?: unknown; binding?: unknown } | null;
  workspace?: Record<string, { key?: unknown; binding?: unknown }> };
const version = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const modelSlot = /^model:([A-Za-z0-9_-]{1,80})$/u;
const servicePrefix = "service-profile:";
export const legacyServiceProfile = "legacy";
export const isServiceProfileId = (id: unknown): id is string => typeof id === "string" && version.test(id);
const settingsKey = (base: string) => `desktopCredential:${base}`;
const backupKey = (id: string) => `desktopModelBackup:${id}`;
const retiredModelKey = "retiredModelCredential:";

export function openDesktopCredentials(store: ReturnType<typeof openStore>) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_service_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL
  )`);
  const modelRow = db.prepare(`SELECT m.data, s.value AS reference FROM models m
    LEFT JOIN settings s ON s.key=? WHERE m.id=?`);
  const serviceRow = db.prepare(`SELECT
    (SELECT value FROM settings WHERE key='serviceAddress') AS address,
    (SELECT value FROM settings WHERE key=?) AS reference`);
  const profileRow = db.prepare(`SELECT p.id,p.name,p.address,s.value AS reference FROM desktop_service_profiles p
    LEFT JOIN settings s ON s.key=? WHERE p.id=?`);
  const listProfileRows = db.prepare("SELECT id FROM desktop_service_profiles ORDER BY name,id");
  const writeProfile = db.prepare("INSERT OR REPLACE INTO desktop_service_profiles(id,name,address) VALUES (?,?,?)");
  const removeProfile = db.prepare("DELETE FROM desktop_service_profiles WHERE id=?");
  const removeSetting = db.prepare("DELETE FROM settings WHERE key=?");

  function bound(base: string, origin: string | null, reference: unknown, legacy: boolean): Binding {
    if (typeof reference !== "string") return { origin, slot: origin && legacy ? base : null };
    const revision = JSON.parse(reference);
    const slot = origin && typeof revision?.id === "string" && version.test(revision.id) && revision.origin === origin
      ? `${base}:${revision.id}` : null;
    return { origin, slot };
  }

  function model(id: string) {
    const base = `model:${id}`;
    const row = modelRow.get(settingsKey(base), id);
    const profile = row ? JSON.parse(String(row.data)) as ModelProfile : undefined;
    const origin = profile ? validateEndpoint(profile.baseUrl).origin : null;
    return { profile, binding: bound(base, origin, row?.reference, profile?.hasKey === true) };
  }

  function legacyService() {
    const row = serviceRow.get(settingsKey("service"))!;
    const address = typeof row.address === "string" ? JSON.parse(row.address) as string : "";
    const origin = address ? validateEndpoint(address).origin : null;
    return { binding: bound("service", origin, row.reference, true) };
  }

  const activeServiceId = () => store.setting<string | null>("desktopActiveServiceProfile", legacyServiceProfile);
  const serviceEpoch = () => store.setting("desktopServiceEpoch", "");
  function serviceProfile(id: string) {
    if (id === legacyServiceProfile) {
      const { binding } = legacyService();
      const profile: DesktopServiceProfile | undefined = binding.origin ? { id,
        name: store.setting("desktopLegacyServiceName", "默认连接"), address: binding.origin, hasCredential: !!binding.slot } : undefined;
      return { profile, binding };
    }
    const base = servicePrefix + id;
    const row = profileRow.get(settingsKey(base), id);
    const binding = bound(base, row ? validateEndpoint(String(row.address)).origin : null, row?.reference, false);
    const profile: DesktopServiceProfile | undefined = binding.origin && row
      ? { id, name: String(row.name), address: binding.origin, hasCredential: !!binding.slot } : undefined;
    return { profile, binding };
  }

  function service() {
    const profile = activeServiceId();
    return { binding: profile ? serviceProfile(profile).binding : { origin: null, slot: null } };
  }

  function activateService(id: string | null, newCredential = false) {
    if (id !== null && !serviceProfile(id).profile) throw new Error("找不到该服务连接。");
    if (activeServiceId() === id && !newCredential) return false;
    store.saveSetting("desktopActiveServiceProfile", id);
    store.saveSetting("desktopServiceEpoch", randomUUID());
    return true;
  }

  function backupPreference(id: string) {
    return store.setting<string | null>(backupKey(id), null);
  }

  function backup(id: string) {
    const backupId = backupPreference(id);
    if (typeof backupId !== "string" || backupId === id || !modelSlot.test(`model:${backupId}`)) return undefined;
    const { profile, binding } = model(backupId);
    return profile?.hasKey && binding.slot ? { profile, binding } : undefined;
  }

  function matches(actual: Binding, expected: unknown) {
    const item = expected as Partial<Binding> | null;
    return !!item && actual.slot === item.slot && actual.origin === item.origin;
  }

  return {
    model, service, legacyService, serviceProfile, activeServiceId, serviceEpoch, activateService, matches, backup, backupPreference,
    listServices() {
      const byId = [legacyServiceProfile, ...listProfileRows.all().map(row => String(row.id))];
      return byId.flatMap(id => {
        const { profile } = serviceProfile(id);
        return profile ? [profile] : [];
      });
    },
    saveServiceProfile(id: string, name: string, address: string) {
      if (id === legacyServiceProfile) {
        store.saveSetting("desktopLegacyServiceName", name);
        store.saveSetting("serviceAddress", address);
      } else writeProfile.run(id, name, address);
    },
    removeServiceProfile(id: string) {
      if (id === legacyServiceProfile) {
        removeSetting.run("serviceAddress");
        removeSetting.run("desktopLegacyServiceName");
      } else removeProfile.run(id);
      removeSetting.run(settingsKey(id === legacyServiceProfile ? "service" : servicePrefix + id));
    },
    setBackup(id: unknown, backupId: unknown) {
      if (typeof id !== "string" || !modelSlot.test(`model:${id}`) || !model(id).profile) throw new Error("请先保存主模型档案。");
      if (backupId !== null && (typeof backupId !== "string" || id === backupId || !modelSlot.test(`model:${backupId}`) ||
          !model(backupId).profile?.hasKey)) throw new Error("请选择一个已保存 API Key 的其他模型档案。");
      store.saveSetting(backupKey(id), backupId);
    },
    retireModelKey(id: string, binding: Binding, removing: boolean) {
      store.saveSetting(settingsKey("model:" + id), null);
      if (binding.slot) store.saveSetting(retiredModelKey + binding.slot, true);
      db.prepare("DELETE FROM settings WHERE key GLOB 'desktopModelBackup:*' AND value = ?")
        .run(JSON.stringify(id));
      if (removing) removeSetting.run(backupKey(id));
    },
    retiredModelKeys() {
      return db.prepare("SELECT key FROM settings WHERE key GLOB 'retiredModelCredential:model:*' ORDER BY key")
        .all().map(row => String(row.key).slice(retiredModelKey.length));
    },
    finishRetiredModelKey(slot: unknown) {
      if (typeof slot !== "string" || !/^model:[\w-]{1,80}(?::[0-9a-f-]{36})?$/u.test(slot)) {
        throw new Error("待清理模型凭据标识无效。");
      }
      removeSetting.run(retiredModelKey + slot);
      return true;
    },
    plan(base: unknown, stage: boolean, includeBackup = false, legacy = false) {
      const id = typeof base === "string" ? modelSlot.exec(base)?.[1] : undefined;
      const target = typeof base === "string" && base.startsWith(servicePrefix) ? base.slice(servicePrefix.length) : undefined;
      const binding = base === "service" ? (legacy ? legacyService() : service()).binding
        : id ? model(id).binding : isServiceProfileId(target) ? serviceProfile(target).binding : undefined;
      if (!binding) throw new Error("凭据档案无效。");
      const spare = id && includeBackup ? backup(id) : undefined;
      return { binding, replacement: stage ? `${base}:${randomUUID()}` : null,
        backup: spare ? { modelId: spare.profile.id, binding: spare.binding } : null };
    },
    key(frame: CredentialFrame, base: string, current: Binding) {
      if (typeof frame.key !== "string" || !frame.key) return null;
      // The old local protocol remains usable for legacy entries. Native calls attach an exact binding.
      if (!(frame.binding === undefined ? current.slot === base : !!current.slot && matches(current, frame.binding))) {
        throw new Error("模型或服务配置已变更，请刷新后重试。");
      }
      return frame.key;
    },
    commit(base: string, frame: CredentialFrame, current: Binding, nextOrigin: string, reusing: boolean) {
      if (frame.change === undefined) {
        if (store.setting(settingsKey(base), undefined) !== undefined) {
          throw new Error("请使用最新桌宠保存凭据配置。");
        }
        return;
      }
      const change = frame.change as { expected?: unknown; replacement?: unknown } | null;
      if (!change || !matches(current, change.expected)) throw new Error("凭据配置已有更新，请刷新后再保存。");
      if (reusing) {
        if (!current.slot || current.origin !== nextOrigin || change.replacement !== current.slot) {
          throw new Error("凭据仅可在原服务地址继续使用。");
        }
        return;
      }
      const slot = change.replacement;
      if (slot === null) {
        store.saveSetting(settingsKey(base), null);
        return;
      }
      if (typeof slot !== "string" || !slot.startsWith(base + ":") || !version.test(slot.slice(base.length + 1)) || slot === current.slot) {
        throw new Error("准备的新凭据档案无效。");
      }
      store.saveSetting(settingsKey(base), { id: slot.slice(base.length + 1), origin: nextOrigin });
    },
  };
}
