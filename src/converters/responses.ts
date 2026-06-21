/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI Responses API converters.
 *
 * The Chat Completions API does not surface a reasoning model's reasoning
 * summary — only an opaque `reasoning_tokens` count. The Responses API
 * (`POST /v1/responses`) does: with `reasoning: { summary: "auto" }` it streams
 * `response.reasoning_summary_text.delta` events. This module converts between
 * the ADK/chat shape the rest of the bridge already produces and the Responses
 * API, mapping reasoning summaries to ADK `{ thought: true }` parts.
 *
 * The request side intentionally reuses the chat `messages`/`tools` arrays from
 * {@link convertRequest} and remaps them to Responses `input` items, so the two
 * paths share all the ADK→OpenAI normalization logic.
 *
 * @module converters/responses
 */

import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import type OpenAI from "openai";
import { safeJsonParse } from "../utils/index.js";

/** Reasoning summary verbosity requested from the Responses API. */
export type ReasoningSummary = "auto" | "concise" | "detailed";

/**
 * Accumulator for a Responses API stream.
 *
 * Mirrors the chat {@link StreamAccumulator} role: collect text, reasoning
 * summary, and function calls across events so the terminal `response.completed`
 * event can emit one final aggregated {@link LlmResponse}.
 *
 * @internal
 */
export interface ResponsesAccumulator {
  text: string;
  reasoning: string;
  /** Function calls keyed by output index, accumulated from item events. */
  functionCalls: Map<number, { callId: string; name: string; args: string }>;
}

/** Creates a fresh {@link ResponsesAccumulator}. */
export function createResponsesAccumulator(): ResponsesAccumulator {
  return { text: "", reasoning: "", functionCalls: new Map() };
}

/**
 * Maps an OpenAI Responses `status`/incomplete reason to the ADK FinishReason.
 *
 * @internal
 */
function mapResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
): FinishReason | undefined {
  if (status === "incomplete") {
    return incompleteReason === "max_output_tokens"
      ? FinishReason.MAX_TOKENS
      : FinishReason.OTHER;
  }
  if (status === "completed") return FinishReason.STOP;
  return undefined;
}

/**
 * Maps Responses API usage to ADK `usageMetadata`.
 *
 * @internal
 */
function buildResponsesUsage(
  usage: OpenAI.Responses.ResponseUsage | undefined,
): LlmResponse["usageMetadata"] | undefined {
  if (!usage) return undefined;
  const metadata: NonNullable<LlmResponse["usageMetadata"]> = {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
  };
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined && reasoningTokens !== null) {
    metadata.thoughtsTokenCount = reasoningTokens;
  }
  return metadata;
}

/**
 * Converts the bridge's chat-style request (messages + tools + params, as
 * produced by {@link convertRequest}) into an OpenAI Responses API request body.
 *
 * - `system` chat message  -> `instructions`
 * - `user`/`assistant` messages -> Responses `message` input items
 * - assistant `tool_calls`  -> `function_call` input items
 * - `tool` messages         -> `function_call_output` input items
 * - chat `tools`            -> Responses (flat) function tools
 * - `max_completion_tokens` -> `max_output_tokens`
 * - `reasoning_effort`      -> `reasoning.effort` (+ requested `summary`)
 *
 * @param messages - Chat messages from convertRequest
 * @param model - Resolved model id
 * @param reasoningSummary - Reasoning summary verbosity to request
 * @param tools - Chat tools from convertRequest
 * @param params - Chat params from convertRequest (subset is forwarded)
 * @param toolChoice - Chat tool_choice from convertRequest
 */
export function convertChatRequestToResponses(
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  reasoningSummary: ReasoningSummary,
  tools?: OpenAI.ChatCompletionTool[],
  params?: Record<string, unknown>,
  toolChoice?: OpenAI.ChatCompletionToolChoiceOption,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  let instructions: string | undefined;
  const input: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      instructions = typeof msg.content === "string"
        ? msg.content
        : chatPartsToText(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string"
          ? msg.content
          : chatPartsToText(msg.content),
      });
      continue;
    }

    if (msg.role === "user") {
      input.push({ role: "user", content: userContentToResponses(msg.content) });
      continue;
    }

    if (msg.role === "assistant") {
      if (typeof msg.content === "string" && msg.content) {
        input.push({ role: "assistant", content: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
    }
  }

  const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model,
    input,
    reasoning: {
      summary: reasoningSummary,
      ...(typeof params?.reasoning_effort === "string"
        ? { effort: params.reasoning_effort as "low" | "medium" | "high" }
        : {}),
    },
  };

  if (instructions) body.instructions = instructions;
  if (typeof params?.max_completion_tokens === "number") {
    body.max_output_tokens = params.max_completion_tokens;
  }

  const fnTools: OpenAI.Responses.FunctionTool[] = [];
  for (const t of tools ?? []) {
    if (t.type !== "function") continue;
    fnTools.push({
      type: "function",
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: (t.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
      strict: false,
    });
  }
  if (fnTools.length) {
    body.tools = fnTools;
    if (toolChoice) body.tool_choice = toResponsesToolChoice(toolChoice);
  }

  return body;
}

/** Maps a chat tool_choice to the Responses API tool_choice shape. @internal */
function toResponsesToolChoice(
  choice: OpenAI.ChatCompletionToolChoiceOption,
): OpenAI.Responses.ResponseCreateParamsNonStreaming["tool_choice"] {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "function", name: choice.function.name };
  }
  return undefined;
}

/** Concatenates chat content parts to plain text. @internal */
function chatPartsToText(
  content: OpenAI.ChatCompletionContentPart[] | string | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Maps chat user content (text/image) to Responses input content. @internal */
function userContentToResponses(
  content: OpenAI.ChatCompletionContentPart[] | string,
): string | OpenAI.Responses.ResponseInputContent[] {
  if (typeof content === "string") return content;
  const parts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url") {
      parts.push({
        type: "input_image",
        image_url: p.image_url.url,
        detail: "auto",
      });
    }
  }
  return parts;
}

/**
 * Converts a non-streaming Responses API result to an ADK {@link LlmResponse}.
 *
 * Reasoning summary text becomes `{ thought: true }` parts; message text and
 * function calls follow.
 */
export function convertResponsesResponse(
  response: OpenAI.Responses.Response,
): LlmResponse {
  const parts: Part[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "reasoning") {
      const text = (item.summary ?? [])
        .map((s) => s.text)
        .filter(Boolean)
        .join("");
      if (text) parts.push({ text, thought: true });
    } else if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) parts.push({ text: c.text });
      }
    } else if (item.type === "function_call") {
      parts.push({
        functionCall: {
          id: item.call_id,
          name: item.name,
          args: safeJsonParse(item.arguments),
        },
      });
    }
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    finishReason: mapResponsesFinishReason(
      response.status,
      response.incomplete_details?.reason,
    ),
    usageMetadata: buildResponsesUsage(response.usage),
  };
}

/**
 * Processes one Responses API stream event, mirroring the chat
 * {@link convertStreamChunk} contract: returns partial responses for streamed
 * text/reasoning deltas and one final aggregated response on completion.
 *
 * @param event - The Responses stream event
 * @param acc - The accumulator tracking text/reasoning/function calls
 */
export function convertResponsesStreamEvent(
  event: OpenAI.Responses.ResponseStreamEvent,
  acc: ResponsesAccumulator,
): { response?: LlmResponse; isComplete: boolean } {
  switch (event.type) {
    case "response.reasoning_summary_text.delta": {
      acc.reasoning += event.delta;
      return {
        response: {
          content: { role: "model", parts: [{ text: event.delta, thought: true }] },
          partial: true,
        },
        isComplete: false,
      };
    }

    case "response.output_text.delta": {
      acc.text += event.delta;
      return {
        response: {
          content: { role: "model", parts: [{ text: event.delta }] },
          partial: true,
        },
        isComplete: false,
      };
    }

    case "response.output_item.done": {
      // Capture completed function-call items (name + full arguments + call_id).
      if (event.item.type === "function_call") {
        acc.functionCalls.set(event.output_index, {
          callId: event.item.call_id,
          name: event.item.name,
          args: event.item.arguments,
        });
      }
      return { isComplete: false };
    }

    case "response.completed":
    case "response.incomplete": {
      const parts: Part[] = [];
      if (acc.reasoning) parts.push({ text: acc.reasoning, thought: true });
      if (acc.text) parts.push({ text: acc.text });
      for (const fc of acc.functionCalls.values()) {
        if (fc.name) {
          parts.push({
            functionCall: { id: fc.callId, name: fc.name, args: safeJsonParse(fc.args) },
          });
        }
      }
      const response = event.response;
      return {
        response: {
          content: parts.length ? { role: "model", parts } : undefined,
          turnComplete: true,
          finishReason: mapResponsesFinishReason(
            response.status,
            response.incomplete_details?.reason,
          ),
          usageMetadata: buildResponsesUsage(response.usage),
        },
        isComplete: true,
      };
    }

    case "response.failed":
    case "error": {
      const message =
        event.type === "response.failed"
          ? event.response.error?.message ?? "Responses API request failed"
          : event.message ?? "Responses API stream error";
      return {
        response: { errorCode: "OPENAI_RESPONSES_ERROR", errorMessage: message, turnComplete: true },
        isComplete: true,
      };
    }

    default:
      return { isComplete: false };
  }
}
