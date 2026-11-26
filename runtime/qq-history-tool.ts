import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { readGroupStickerQuery } from "./qq-group-stickers.js";

const historyName = "read_history";
const stickerName = "find_stickers";
export type FindGroupStickers = (query: string, send: boolean) => string | undefined;

function send(response: ServerResponse, id: unknown, result: object) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, ...result }));
}

export async function openQqTurnTools(scope: "private" | "group", signal: AbortSignal,
    { history, stickers }: { history?: () => string | undefined; stickers?: FindGroupStickers }) {
  signal.throwIfAborted();
  const location = scope === "private" ? "私聊" : "同群";
  const historyTool = { name: historyName, description: `补齐当前发言明确指向的${location}对话细节。当前请求确实缺少对应资料才使用。独立创作、选择题材和换话题时直接回答。`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const stickerTool = { name: stickerName, description: "只在群友请你从本群收藏查找或发送表情时调用。query 用简短中文标签，如早安、鼓掌，不清楚名字可留空查看近期收藏。仅要求查找时用 find，请求直接发图时用 send。",
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 32 }, mode: { enum: ["find", "send"] } },
      required: ["query", "mode"], additionalProperties: false } };
  const tools = [...(history ? [historyTool] : []), ...(scope === "group" && stickers ? [stickerTool] : [])];
  const path = "/" + randomUUID();
  let historyUsed = false;
  let stickerReads = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== path || signal.aborted) { response.writeHead(404).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    let payload = "";
    request.setEncoding("utf8");
    try {
      for await (const chunk of request) {
        payload += chunk;
        if (payload.length > 8192) { response.writeHead(413).end(); return; }
      }
      const message = JSON.parse(payload);
      if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
        send(response, message?.id ?? null, { error: { code: -32600, message: "Invalid request" } });
        return;
      }
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      switch (message.method) {
        case "initialize":
          send(response, message.id, { result: { protocolVersion: "2025-03-26",
            capabilities: { tools: {} }, serverInfo: { name: `ohjingjing-${scope}`, version: "1" } } });
          return;
        case "ping":
          send(response, message.id, { result: {} });
          return;
        case "tools/list":
          send(response, message.id, { result: { tools } });
          return;
        case "tools/call":
          const name = message.params?.name;
          const input = message.params?.arguments === undefined ? {} : message.params.arguments;
          if (!input || typeof input !== "object" || Array.isArray(input) || !tools.some(tool => tool.name === name)) {
            send(response, message.id, { error: { code: -32602, message: "Unknown tool" } });
            return;
          }
          if (signal.aborted) { response.writeHead(404).end(); return; }
          if (name === historyName && history && Object.keys(input).length === 0) {
            const text = historyUsed ? `本轮已读过${location}记录。请根据已返回的资料答复。` : history();
            historyUsed = true;
            send(response, message.id, { result: { content: [{ type: "text", text: text ?? `当前没有可读的${location}记录。` }] } });
            return;
          }
          const query = readGroupStickerQuery(input.query);
          if (name === stickerName && stickers && query !== undefined && Object.keys(input).length === 2 &&
              (input.mode === "find" || input.mode === "send")) {
            const text = stickerReads++ >= 2 ? "本轮已完成两次表情查找。请根据已有结果回复。" : stickers(query, input.mode === "send");
            send(response, message.id, { result: { content: [{ type: "text", text: text ?? "当前没有可读的群表情收藏。" }] } });
            return;
          }
          send(response, message.id, { error: { code: -32602, message: "Invalid tool arguments" } });
          return;
        default:
          send(response, message.id, { error: { code: -32601, message: "Method not found" } });
      }
    } catch {
      if (!response.headersSent) send(response, null, { error: { code: -32700, message: "Could not read request" } });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port + path,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
