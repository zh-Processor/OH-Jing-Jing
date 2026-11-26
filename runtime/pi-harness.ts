/*! Pi Agent Core, Pi AI and Pi Schema 1.6.0
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { runAgentLoop, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message as PiMessage,
  type Model, type Usage } from "@earendil-works/pi-ai";
import type { Message, ModelProfile } from "./models.js";

type Completion = {
  text: string; refused: boolean; inputTokens: number | null; outputTokens: number | null;
  local?: true;
};

export type PiLookup = {
  name: string;
  argument: string;
  label: string;
  instruction: string;
  execute(signal?: AbortSignal): Promise<string>;
  merge?(messages: Message[], result: string): void;
  replyWithoutModel?(result: string): string | undefined;
  formatReply?(answer: string, result: string): string;
};

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function usage(input: number, output: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { ...noCost, total: 0 } };
}

function textContent(content: PiMessage["content"]) {
  return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
}

export async function runPiTurn(profile: ModelProfile, messages: Message[],
    generate: (messages: Message[], signal?: AbortSignal) => Promise<Completion>, signal?: AbortSignal,
    lookup?: PiLookup): Promise<Completion> {
  const model: Model<"openai-completions"> = {
    id: profile.model, name: profile.name, provider: "ohjingjing", api: "openai-completions",
    baseUrl: profile.baseUrl, input: profile.vision ? ["text", "image"] : ["text"], reasoning: false, cost: noCost, contextWindow: 0, maxTokens: 0,
  };
  const timestamp = Date.now();
  function assistant(text: string, tokens: Usage): AssistantMessage {
    return { role: "assistant", content: text ? [{ type: "text", text }] : [], usage: tokens,
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp };
  }
  const instructions: Message[] = lookup && !lookup.merge ? [{ role: "system", content: lookup.instruction }, ...messages] : messages;
  const prompt: PiMessage[] = instructions.map(({ role, content, images }) => {
    if (role === "assistant") return assistant(content, usage(0, 0));
    if (role !== "user" || !images?.length) return { role, content, timestamp };
    const visuals = images.flatMap(image => {
      const match = /^data:(image\/[a-z]+);base64,(.+)$/u.exec(image);
      return match ? [{ type: "image" as const, mimeType: match[1], data: match[2] }] : [];
    });
    return { role, content: [{ type: "text" as const, text: content }, ...visuals], timestamp };
  });
  const tools: AgentTool[] = lookup ? [{
    name: lookup.name, label: lookup.label, description: lookup.instruction,
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: async (_id, _args, toolSignal) => ({
      content: [{ type: "text", text: await lookup.execute(toolSignal) }], details: undefined,
    }),
  }] : [];

  // Keep the transport's nullable token counts and refusal status for billing and failover.
  let completion: Completion | undefined;
  const stream: StreamFn = async (_model, context, options) => {
    options?.signal?.throwIfAborted();
    const result = createAssistantMessageEventStream();
    // The host chooses one read operation; text-only providers need not implement tool calls.
    if (lookup && !context.messages.some(message => message.role === "toolResult")) {
      const message = assistant("", usage(0, 0));
      message.content.push({ type: "toolCall", id: "turn-lookup", name: lookup.name, arguments: { value: lookup.argument } });
      message.stopReason = "toolUse";
      result.push({ type: "done", reason: "toolUse", message });
    } else {
      const transcript: Message[] = [];
      let evidence: string | undefined;
      for (const message of context.messages) {
        if (message.role === "assistant" && message.stopReason === "toolUse") continue;
        if (message.role === "toolResult") {
          const content = textContent(message.content);
          evidence = content;
          if (lookup?.merge) lookup.merge(transcript, content);
          else transcript.push({ role: "user", content: JSON.stringify({ type: "外部网页资料", tool: message.toolName, content }) });
          continue;
        }
        const images = message.role === "user" && Array.isArray(message.content) ? message.content.flatMap(part =>
          part.type === "image" ? [`data:${part.mimeType};base64,${part.data}`] : []) : [];
        transcript.push({ role: message.role, content: textContent(message.content), ...(images.length ? { images } : {}) });
      }
      const localReply = evidence === undefined ? undefined : lookup?.replyWithoutModel?.(evidence);
      completion = localReply
        ? { text: localReply, refused: false, inputTokens: null, outputTokens: null, local: true }
        : await generate(transcript, options?.signal);
      if (!localReply && !completion.refused && evidence !== undefined && lookup?.formatReply) {
        completion = { ...completion, text: lookup.formatReply(completion.text, evidence) };
      }
      const message = assistant(completion.text, usage(completion.inputTokens ?? 0, completion.outputTokens ?? 0));
      result.push({ type: "done", reason: "stop", message });
    }
    return result;
  };
  const output = await runAgentLoop(prompt, { messages: [], tools }, { model, convertToLlm: input => input },
    () => {}, signal, stream);
  const final = output.at(-1);
  if (!completion || final?.role !== "assistant") throw new Error("Pi 回合未返回助手消息。");
  return { ...completion, text: textContent(final.content) };
}
