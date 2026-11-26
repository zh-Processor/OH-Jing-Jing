import type { ImChannelPlugin } from "./im-channel.js";
import { oneBotPlugin } from "./onebot.js";
import { milkyPlugin } from "./qq-milky.js";

export function resolveImPlugin(id: string | undefined, additional: readonly ImChannelPlugin[] = []) {
  const available: ImChannelPlugin[] = [oneBotPlugin, milkyPlugin, ...additional];
  const plugins = new Map<string, ImChannelPlugin>();
  for (const plugin of available) {
    const { manifest } = plugin;
    if (!/^[a-z][a-z0-9.-]{1,79}$/u.test(manifest.id) || manifest.apiVersion !== 1 ||
        plugins.has(manifest.id)) {
      throw new Error("IM 渠道插件 ID 重复或接口版本无效。");
    }
    plugins.set(manifest.id, plugin);
  }
  const plugin = plugins.get(id === undefined ? oneBotPlugin.manifest.id : id);
  if (!plugin) throw new Error("配置指定了未安装的 IM 渠道插件。");
  return plugin;
}
