import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createQqIngressCollector, type QqIngressCollectorOptions } from "./qq-ingress.js";

const path = process.env.OHJINGJING_QQ_INGRESS_CONFIG;
if (!path) throw new Error("请配置 QQ 独立收件配置文件位置。");
const config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")) as
  Omit<QqIngressCollectorOptions, "token" | "gatewayToken"> & { port: number };
if (typeof config?.database !== "string" || !config.database || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
  throw new Error("QQ 独立收件需要独立数据库和本机监听端口。");
}
const database = resolve(dirname(path), config.database);
const policyDatabase = config.policyDatabase ? resolve(dirname(path), config.policyDatabase) : undefined;
if (policyDatabase === database) throw new Error("独立收件和主服务需要使用不同的数据库。");
mkdirSync(dirname(database), { recursive: true });
const { server, stop } = createQqIngressCollector({ ...config, database, policyDatabase,
  token: process.env.OHJINGJING_QQ_INGRESS_TOKEN ?? "", gatewayToken: process.env.OHJINGJING_ONEBOT_TOKEN });
server.listen(config.port, "127.0.0.1", () => process.stdout.write("QQ 独立收件服务已启动。\n"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void stop().then(() => process.exit(0), () => process.exit(1));
});
