// opencode-acp-v2 — Core Active Context Pruning for OpenCode V2.
//
// A V2-native port of the opencode-acp / DCP design (tool names, config model,
// and compression behavior). This is a Core subset: the five context tools,
// system-prompt nudges, and message-range pruning via the V2 context hook.
//
// The default export is `{ id, setup }` (Plugin.define is a pass-through, so we
// skip the @opencode-ai/plugin dependency entirely to avoid V1/V2 resolution
// issues). Uses the V2 plugin API:
//   - ctx.session.hook("context")  -> mutate system / messages before dispatch
//   - ctx.tool.transform           -> register compress/decompress/search/status tools
//   - ctx.command.transform        -> /acp command
// Config: ctx.options merged with acp.jsonc / dcp.jsonc (config-dir, JSONC tolerant).
//
// License: AGPL-3.0-or-later (derived from the opencode-acp design).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_CONFIG = {
  enabled: true,
  debug: false,
  autoUpdate: false,
  allowSubAgents: false,
  commands: { enabled: true },
  compress: {
    permission: "allow", // "ask" | "allow" | "deny"
    showCompression: false,
    summaryBuffer: false,
    maxContextLimit: 200000,
    minContextLimit: 40000,
    nudgeFrequency: 2,
    minNudgeContextPercent: 70,
    nudgeForce: "soft", // "strong" | "soft"
    protectedTools: ["read", "grep", "glob", "list"],
    protectTags: true,
    protectUserMessages: true,
    maxSummaryLengthHard: 1600,
    minCompressRange: 800,
    preserveRecentMessages: 20,
    preserveRecentTokens: 20000,
    preserveLastUserMessage: true,
  },
};

const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]";

function refOf(n) {
  return "m" + String(n).padStart(5, "0");
}
function blockRefOf(n) {
  return "b" + String(n);
}
function formatMessageIdTag(ref) {
  return `[block ${ref}]`;
}
function wrapCompressedSummary(blockId, summary) {
  const header = COMPRESSED_BLOCK_HEADER;
  const footer = formatMessageIdTag(blockRefOf(blockId));
  const body = (summary || "").trim();
  if (!body) return `${header}\n${footer}`;
  return `${header}\n${body}\n\n${footer}`;
}

// --- minimal token estimation (chars/4) -------------------------------

function countTextChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") n += part.text.length;
    else if (part.type === "reasoning" && typeof part.text === "string") n += part.text.length;
    else if (part.type === "tool-call") {
      n += (part.name || "").length;
      if (typeof part.input === "string") n += part.input.length;
    } else if (part.type === "tool-result") {
      const r = part.result;
      if (r && typeof r === "object" && "value" in r) {
        try {
          n += String(r.value).length;
        } catch {
          n += 0;
        }
      }
    }
  }
  return n;
}

function messageId(m, fallbackIndex) {
  if (m && typeof m.id === "string" && m.id) return m.id;
  return refOf(fallbackIndex + 1);
}

// --- JSONC parsing ----------------------------------------------------

function stripJsonc(input) {
  const src = String(input);
  let out = "";
  let i = 0;
  const n = src.length;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && d === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && d === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out
    .replace(/,(\s*[}\]])/g, "$1") // trailing commas
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function parseJsonc(text) {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function readConfigFile(configDir) {
  const candidates = ["acp.jsonc", "acp.json", "dcp.jsonc", "dcp.json"];
  for (const name of candidates) {
    const full = path.join(configDir, name);
    try {
      if (fs.existsSync(full)) {
        const parsed = parseJsonc(fs.readFileSync(full, "utf8"));
        if (parsed) return parsed;
      }
    } catch {
      // fall through
    }
  }
  return undefined;
}

function resolveConfig(ctx) {
  const merged = structuredClone(DEFAULT_CONFIG);
  const apply = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      if (key === "compress" && value && typeof value === "object") {
        Object.assign(merged.compress, value);
      } else if (key === "commands" && value && typeof value === "object") {
        Object.assign(merged.commands, value);
      } else {
        merged[key] = value;
      }
    }
  };
  apply(ctx.options);
  // config-dir file (acp.jsonc / dcp.jsonc) — lower precedence than options
  const configDir =
    process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
  const fileConfig = readConfigFile(configDir);
  if (fileConfig && fileConfig.compress && typeof fileConfig.compress === "object") {
    // file is allowed to override defaults but not explicit ctx.options
    const hadCompress = Boolean(ctx.options && ctx.options.compress);
    if (!hadCompress) Object.assign(merged.compress, fileConfig.compress);
    if (!hadCompress && fileConfig.enabled !== undefined) merged.enabled = fileConfig.enabled;
    if (fileConfig.commands && typeof fileConfig.commands === "object") {
      Object.assign(merged.commands, fileConfig.commands);
    }
  }
  return merged;
}

// --- session state ----------------------------------------------------

function createSessionState(config) {
  return {
    blocks: new Map(), // blockId -> block
    nextBlockId: 1,
    nextRef: 1,
    refs: new Map(), // ref -> index into lastVisibleMessages
    lastVisibleMessages: [], // copies of the messages seen on the last hook
    lastVisibleIds: [], // stable ids for lastVisibleMessages
    lastVisibleRefs: [], // ref strings in order
    lastTurnTokens: 0,
    lastNudgeTurn: -Infinity,
    modelLimit: typeof config.compress.maxContextLimit === "number" ? config.compress.maxContextLimit : 200000,
    systemPromptTokens: 0,
    turnCount: 0,
    lastCompaction: 0,
  };
}

// --- rendering ----------------------------------------------------------

function renderMessageList(state) {
  const lines = [];
  const visible = state.lastVisibleMessages;
  const refs = state.lastVisibleRefs;
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i];
    const ref = refs[i] || refOf(i + 1);
    let preview = "";
    if (m && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          preview = part.text.replace(/\s+/g, " ").trim();
          break;
        }
      }
    }
    if (!preview && m && typeof m.text === "string") preview = m.text;
    if (preview.length > 80) preview = preview.slice(0, 80) + "...";
    const role = m && typeof m.role === "string" ? m.role : "unknown";
    lines.push(`${ref} = ${role}: ${preview}`);
  }
  if (lines.length === 0) return "(no visible messages yet)";
  return lines.join("\n");
}

function renderBlockList(state) {
  const lines = [];
  for (const block of state.blocks.values()) {
    if (!block.active) continue;
    lines.push(`${blockRefOf(block.blockId)} = [Compressed ${block.mode || "range"}] ${block.topic}`);
  }
  if (lines.length === 0) return "(no compressed blocks)";
  return lines.join("\n");
}

function renderSystemPrompt(config, state, nudgeText) {
  const parts = [];
  parts.push(
    `## Context Management (Active Context Pruning)\n` +
      `You have tools for managing conversation context: compress, decompress, search_context, acp_status, acp_context_recap.\n` +
      `When the conversation grows long, compress older message ranges with the compress tool to keep important details in summaries.`,
  );
  if (config.compress.protectedTools.length > 0) {
    parts.push(
      `Protected tools whose outputs should NOT be compressed: ${config.compress.protectedTools.join(", ")}.`,
    );
  }
  parts.push(`### Current message references\n${renderMessageList(state)}`);
  parts.push(`### Compressed blocks\n${renderBlockList(state)}`);
  parts.push(
    `Message references are of the form m00001 and remain valid for tool calls. Compressed blocks are referenced as b1, b2, ... ` +
      `and can be passed to decompress or included in a compress range.`,
  );
  if (nudgeText) parts.push(nudgeText);
  return parts.join("\n\n");
}

function estimateUsagePercent(state) {
  if (!state.modelLimit || state.modelLimit <= 0) return 0;
  return Math.round((state.lastTurnTokens / state.modelLimit) * 100);
}

function shouldNudge(config, state) {
  if (config.compress.permission === "deny") return undefined;
  const usage = estimateUsagePercent(state);
  if (usage < config.compress.minNudgeContextPercent) return undefined;
  if (state.turnCount - state.lastNudgeTurn < config.compress.nudgeFrequency) return undefined;
  state.lastNudgeTurn = state.turnCount;
  const force = config.compress.nudgeForce === "strong" ? "You MUST" : "Consider";
  return (
    `[ACP] Context usage is at ${usage}% (${state.lastTurnTokens.toLocaleString()} tokens / ${state.modelLimit.toLocaleString()} limit). ` +
    `${force} compressing the oldest least-relevant message ranges with the compress tool now to free context. ` +
    `Keep project-critical details (file paths, decisions, exact values) in the summary.`
  );
}

// --- compression application (context hook) ---------------------------

function applyBlocksToMessages(state, messages, logger, config) {
  if (state.blocks.size === 0) return;
  for (const block of state.blocks.values()) {
    if (!block.active) continue;
    // find the index range covered by this block in the current messages
    let start = -1;
    let end = -1;
    for (let i = 0; i < messages.length; i++) {
      const mid = messageId(messages[i], i);
      if (block.messageIds.has(mid)) {
        if (start === -1) start = i;
        end = i;
      }
    }
    if (start === -1) continue;
    const placeholder = {
      role: "user",
      content: [{ type: "text", text: wrapCompressedSummary(block.blockId, block.summary) }],
      metadata: { acpBlockId: block.blockId },
    };
    messages.splice(start, end - start + 1, placeholder);
    block.applied = true;
    if (logger) logger.info(`[acp] applied block b${block.blockId} (messages ${start}..${end})`);
  }
}

// --- tool: compress -----------------------------------------------------

function compressToolSchema(config) {
  return {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "Fallback topic for entries without their own. Omit when each content entry specifies its own topic.",
      },
      content: {
        type: "array",
        description:
          "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges, give each its own topic.",
        items: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'.",
            },
            startId: {
              type: "string",
              description: "Message or block ID marking the beginning of range (e.g. m00001, b2)",
            },
            endId: {
              type: "string",
              description: "Message or block ID marking the end of range (e.g. m00012, b5)",
            },
            summary: {
              type: "string",
              description:
                "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
            },
          },
          required: ["startId", "endId", "summary"],
        },
      },
      summaryMaxChars: {
        type: "number",
        description: `Override max summary length (default max: ${config.compress.maxSummaryLengthHard} chars).`,
      },
      dangerous: {
        type: "boolean",
        description:
          "Set to true ONLY when you are certain the most recent message(s) must be compressed. Required when a range includes the tail of the conversation.",
      },
      acknowledgeRisk: { type: "boolean" },
    },
    required: ["content"],
  };
}

function resolveBoundary(state, id) {
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  // block ref: b<N>
  const bm = trimmed.match(/^b(\d+)$/);
  if (bm) {
    const block = state.blocks.get(Number(bm[1]));
    if (!block) return undefined;
    return { kind: "block", block };
  }
  // message ref: m<N>
  const mm = trimmed.match(/^m(\d+)$/);
  if (mm) {
    const index = state.lastVisibleRefs.indexOf(trimmed);
    if (index === -1) return undefined;
    return { kind: "message", index, id: state.lastVisibleIds[index] };
  }
  // treat as raw message id
  const rawIndex = state.lastVisibleIds.indexOf(trimmed);
  if (rawIndex === -1) return undefined;
  return { kind: "message", index: rawIndex, id: trimmed };
}

function computeProtectedIds(state, config) {
  const protectedIds = new Set();
  const visible = state.lastVisibleMessages;
  const ids = state.lastVisibleIds;
  // preserve recent messages (tail)
  const tailStart = Math.max(0, ids.length - config.compress.preserveRecentMessages);
  for (let i = tailStart; i < ids.length; i++) protectedIds.add(ids[i]);
  // preserve last user message
  if (config.compress.preserveLastUserMessage) {
    for (let i = visible.length - 1; i >= 0; i--) {
      const m = visible[i];
      if (m && m.role === "user") {
        protectedIds.add(ids[i]);
        break;
      }
    }
  }
  return protectedIds;
}

function planProtectedError(kind, id) {
  return (
    `Selected range includes a protected ${kind} (${id}) — the most recent messages and the last user message must remain in visible context. ` +
    `Choose an older range, or set dangerous:true to force compression of the tail.`
  );
}

function applyCompression(state, entry, index, dangerousInput) {
  const start = resolveBoundary(state, entry.startId);
  const end = resolveBoundary(state, entry.endId);
  if (!start || !end) {
    return {
      error: `Could not resolve range ${entry.startId}..${entry.endId}. Run acp_status to see current message references and block ids.`,
    };
  }
  let startIndex;
  let endIndex;
  if (start.kind === "block") {
    startIndex = findBlockPosition(state, start.block);
    if (startIndex === -1) return { error: `Block ${entry.startId} has no visible placeholder to extend from.` };
  } else {
    startIndex = start.index;
  }
  if (end.kind === "block") {
    endIndex = findBlockPosition(state, end.block);
    if (endIndex === -1) return { error: `Block ${entry.endId} has no visible placeholder to extend to.` };
  } else {
    endIndex = end.index;
  }
  if (startIndex > endIndex) {
    return { error: `startId (${entry.startId}) comes after endId (${entry.endId}).` };
  }
  const ids = state.lastVisibleIds.slice(startIndex, endIndex + 1);
  const messageIds = new Set(ids);
  if (messageIds.size === 0) return { error: "Empty range selected." };
  const topic = entry.topic || "(untitled range)";
  const summary = (entry.summary || "").trim();
  if (!summary) return { error: "summary is required." };
  const maxLen = state.config.compress.maxSummaryLengthHard;
  if (summary.length > maxLen) {
    return {
      error: `Summary too long (${summary.length} chars, max ${maxLen}). Strip noise or pass summaryMaxChars to raise the limit.`,
    };
  }
  const protectedIds = computeProtectedIds(state, state.config || DEFAULT_CONFIG);
  const protectedHit = [...messageIds].find((id) => protectedIds.has(id));
  const isDangerous = dangerousInput === true;
  if (protectedHit && !isDangerous) {
    return { error: planProtectedError("message range", entry.startId + ".." + entry.endId) };
  }
  const block = {
    blockId: state.nextBlockId++,
    active: true,
    mode: "range",
    topic,
    summary,
    messageIds,
    startRef: entry.startId,
    endRef: entry.endId,
    createdAt: Date.now(),
    applied: false,
    index, // caller-supplied batch index
  };
  state.blocks.set(block.blockId, block);
  // estimate savings
  let savedChars = 0;
  for (const mid of ids) {
    const i = state.lastVisibleIds.indexOf(mid);
    const m = state.lastVisibleMessages[i];
    savedChars += countTextChars(m && m.content);
  }
  return {
    blockId: block.blockId,
    savedTokens: Math.round(savedChars / 4),
    topic,
  };
}

function configSummaryMax(state, entry) {
  return state.config.compress.maxSummaryLengthHard;
}

function findBlockPosition(state, block) {
  for (let i = 0; i < state.lastVisibleMessages.length; i++) {
    const meta = state.lastVisibleMessages[i] && state.lastVisibleMessages[i].metadata;
    if (meta && meta.acpBlockId === block.blockId) return i;
  }
  return -1;
}

function makeCompressExecutor(registry) {
  return async (input, toolCtx) => {
    const state = registry.get(toolCtx.sessionID);
    if (!state) return { content: "Error: no session state. Start a conversation first." };
    const content = Array.isArray(input && input.content) ? input.content : [];
    if (content.length === 0) return { content: "Error: content must contain at least one range." };
    const maxLen = input.summaryMaxChars || state.config.compress.maxSummaryLengthHard;
    const results = [];
    const errors = [];
    for (let i = 0; i < content.length; i++) {
      const entry = content[i];
      if (entry.summary && entry.summary.length > maxLen) {
        errors.push(
          `Entry ${i + 1} summary too long (${entry.summary.length} chars, max ${maxLen}). Strip noise or pass summaryMaxChars to raise the limit.`,
        );
        continue;
      }
      const res = applyCompression(state, entry, i, input.dangerous === true);
      if (res.error) errors.push(`Entry ${i + 1} (${entry.startId}..${entry.endId}): ${res.error}`);
      else results.push(res);
    }
    const lines = [];
    for (const r of results) {
      lines.push(
        `Compressed ${r.topic} as block ${blockRefOf(r.blockId)} (~${r.savedTokens} tokens saved). Summary stored. ` +
          `It is now visible only as a placeholder; decompress b${r.blockId} to restore, or include it in a future compress range to nest.`,
      );
    }
    if (errors.length > 0) {
      lines.push("Errors:");
      lines.push(...errors.map((e) => "  - " + e));
    }
    return { content: lines.join("\n") };
  };
}

// --- tool: decompress -----------------------------------------------------

function makeDecompressExecutor(registry) {
  return async (input, toolCtx) => {
    const state = registry.get(toolCtx.sessionID);
    if (!state) return { content: "Error: no session state." };
    const restored = [];
    if (input.blockId !== undefined) {
      const bm = String(input.blockId).match(/^b?(\d+)$/);
      if (!bm) return { content: `Error: invalid block reference: ${input.blockId}` };
      const block = state.blocks.get(Number(bm[1]));
      if (!block) return { content: `Error: block ${input.blockId} not found.` };
      block.active = false;
      restored.push({ blockId: block.blockId, topic: block.topic });
    } else if (input.startId !== undefined && input.endId !== undefined) {
      const blocks = [...state.blocks.values()].filter(
        (b) => b.active && blockInRange(state, b, input.startId, input.endId),
      );
      for (const block of blocks) {
        block.active = false;
        restored.push({ blockId: block.blockId, topic: block.topic });
      }
      if (blocks.length === 0) return { content: "Error: no active block overlaps that range." };
    } else {
      return { content: "Error: provide either blockId, or startId + endId." };
    }
    if (restored.length === 0) return { content: "No blocks matched." };
    return {
      content:
        `Deactivated ${restored.length} block(s): ${restored.map((r) => blockRefOf(r.blockId)).join(", ")}. ` +
        `Original messages will be restored on the next turn.`,
    };
  };
}

function blockInRange(state, block, startId, endId) {
  const start = resolveBoundary(state, startId);
  const end = resolveBoundary(state, endId);
  if (!start || !end) return false;
  let s;
  let e;
  if (start.kind === "block") s = findBlockPosition(state, start.block);
  else s = start.index;
  if (end.kind === "block") e = findBlockPosition(state, end.block);
  else e = end.index;
  const pos = findBlockPosition(state, block);
  return pos >= s && pos <= e;
}

// --- tool: search_context -------------------------------------------------

function makeSearchExecutor(registry) {
  return async (input, toolCtx) => {
    const state = registry.get(toolCtx.sessionID);
    if (!state) return { content: "Error: no session state." };
    const query = String(input.query || "").toLowerCase().trim();
    if (!query) return { content: "Error: query is required." };
    const limit = Number(input.limit) || 10;
    const terms = query.split(/\s+/).filter(Boolean);
    const results = [];
    for (const block of state.blocks.values()) {
      if (!block.active) continue;
      const haystack = `${block.topic}\n${block.summary}`.toLowerCase();
      if (terms.every((t) => haystack.includes(t))) {
        results.push({
          blockId: block.blockId,
          topic: block.topic,
          summary: block.summary,
        });
      }
      if (results.length >= limit) break;
    }
    if (results.length === 0) {
      return {
        content: `No compressed blocks matched "${input.query}". Use acp_status to see all compressed blocks, or search the visible conversation directly.`,
      };
    }
    const lines = results.map(
      (r) =>
        `b${r.blockId} [${r.topic}]: ${r.summary.length > 600 ? r.summary.slice(0, 600) + "..." : r.summary}`,
    );
    return { content: `Found ${results.length} matching compressed block(s):\n\n` + lines.join("\n\n") };
  };
}

// --- tool: acp_status ------------------------------------------------------

function makeStatusExecutor(registry) {
  return async (_input, toolCtx) => {
    const state = registry.get(toolCtx.sessionID);
    if (!state) return { content: "Error: no session state." };
    const usage = estimateUsagePercent(state);
    const blocks = [...state.blocks.values()].filter((b) => b.active);
    const totalTokens = blocks.reduce((sum, b) => sum + (b.savedTokens || 0), 0);
    const lines = [];
    lines.push(`Context usage: ${usage}% (${state.lastTurnTokens.toLocaleString()} / ${state.modelLimit.toLocaleString()} tokens)`);
    lines.push(`Visible messages: ${state.lastVisibleMessages.length}`);
    lines.push(`Active compressed blocks: ${blocks.length} (~${totalTokens.toLocaleString()} tokens saved)`);
    lines.push("");
    lines.push("Compressed blocks:");
    if (blocks.length === 0) lines.push("  (none)");
    for (const b of blocks) {
      lines.push(`  ${blockRefOf(b.blockId)} [${b.topic}] — ${b.summary.slice(0, 120)}${b.summary.length > 120 ? "..." : ""}`);
    }
    lines.push("");
    lines.push("Message references (visible):");
    lines.push(renderMessageList(state).split("\n").map((l) => "  " + l).join("\n"));
    return { content: lines.join("\n") };
  };
}

// --- tool: acp_context_recap ------------------------------------------------

function makeRecapExecutor(registry) {
  return async (input, toolCtx) => {
    const state = registry.get(toolCtx.sessionID);
    if (!state) return { content: "Error: no session state." };
    const blocks = [...state.blocks.values()].filter((b) => b.active);
    const lines = [];
    lines.push(`Conversation recap (${state.lastVisibleMessages.length} visible messages, ${blocks.length} compressed blocks):`);
    if (blocks.length > 0) {
      lines.push("");
      lines.push("Compressed context:");
      for (const b of blocks) {
        lines.push(`  b${b.blockId} [${b.topic}]: ${b.summary}`);
      }
    }
    lines.push("");
    lines.push("Most recent visible context:");
    const recent = state.lastVisibleMessages.slice(-10);
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const ref = state.lastVisibleRefs[Math.max(0, state.lastVisibleMessages.length - 10 + i)];
      const text = m && Array.isArray(m.content)
        ? m.content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ").slice(0, 200)
        : "";
      lines.push(`  ${ref} (${m && m.role}): ${text}`);
    }
    return { content: lines.join("\n") };
  };
}

// --- system prompt injection ------------------------------------------------

const ACP_SYSTEM_MARKER = "Context Management (Active Context Pruning)";

function systemPromptBuilder(registry) {
  return async (event) => {
    const config = registry.config;
    if (!config.enabled) return;
    const state = registry.get(event.sessionID);
    if (!state) return;
    if (state.isSubAgent && !config.allowSubAgents) return;
    // apply compression blocks first (replace pruned ranges with placeholders)
    const messages = Array.isArray(event.messages) ? event.messages : [];
    applyBlocksToMessages(state, messages, registry.logger, config);
    // capture visible snapshot for tool execution and status
    state.lastVisibleMessages = messages.map((m) => m);
    state.lastVisibleIds = messages.map((m, i) => messageId(m, i));
    state.lastVisibleRefs = messages.map((m, i) => {
      const id = messageId(m, i);
      if (state.refs.has(id)) return state.refs.get(id);
      const ref = refOf(state.nextRef++);
      state.refs.set(id, ref);
      return ref;
    });
    // token estimate
    let chars = 0;
    for (const m of messages) chars += countTextChars(m && m.content);
    state.lastTurnTokens = Math.round(chars / 4);
    state.turnCount++;
    // model limit hint if provided
    const systemText = (event.system || [])
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    state.systemPromptTokens = Math.round(systemText.length / 4);
    // skip internal agents
    if (/InternalOpenCodeAgent|Sub-Agent|subagent/i.test(systemText)) {
      state.isSubAgent = true;
    }
    const nudge = shouldNudge(config, state);
    const promptText = renderSystemPrompt(config, state, nudge);
    const system = Array.isArray(event.system) ? event.system : [];
    const existing = system.findIndex((p) => p && p.type === "text" && p.text && p.text.includes(ACP_SYSTEM_MARKER));
    if (existing >= 0) {
      system[existing] = { type: "text", text: promptText };
    } else {
      system.push({ type: "text", text: promptText });
    }
  };
}

// --- main plugin ------------------------------------------------------------

export default {
  id: "opencode-acp",
  setup: async (ctx) => {
    const config = resolveConfig(ctx);
    if (!config.enabled) return () => {};
    const logger = config.debug
      ? {
          info: (...a) => console.error("[acp]", ...a),
          warn: (...a) => console.error("[acp]", ...a),
          error: (...a) => console.error("[acp]", ...a),
        }
      : { info: () => {}, warn: () => {}, error: (...a) => console.error("[acp]", ...a) };
    const registry = {
      config,
      logger,
      sessions: new Map(),
      get(sessionID) {
        if (!sessionID) return undefined;
        let s = this.sessions.get(sessionID);
        if (!s) {
          s = createSessionState(config);
          s.config = config;
          this.sessions.set(sessionID, s);
        }
        return s;
      },
    };
    logger.info(`opencode-acp v0.1.0 (V2) enabled — permission=${config.compress.permission}, maxContextLimit=${config.compress.maxContextLimit}`);

    // 1) context hook: system prompt + message pruning
    await ctx.session.hook("context", systemPromptBuilder(registry));

    // 2) tools
    await ctx.tool.transform((tools) => {
      const opts = { codemode: false, permission: config.compress.permission };
      tools.add({
        name: "compress",
        description:
          "Compress older message ranges into a short technical summary to free context. Pass one or more ranges with start/end message references (m00001) or block references (b2) and a summary. Use acp_status to see current references.",
        input: compressToolSchema(config),
        execute: makeCompressExecutor(registry),
        options: opts,
      });
      tools.add({
        name: "decompress",
        description:
          "Restore a compressed block's original messages. Pass a block reference (b2) to restore that block, or a startId/endId range to restore any active blocks within it.",
        input: {
          type: "object",
          properties: {
            blockId: {
              type: "string",
              description: 'Block reference to decompress (e.g., "b0", "b2"). Mutually exclusive with startId/endId.',
            },
            startId: {
              type: "string",
              description: 'Range start: message ref (e.g., "m00150") or block ref (e.g., "b2"). Used with endId.',
            },
            endId: {
              type: "string",
              description: 'Range end: message ref (e.g., "m00200") or block ref (e.g., "b5"). Used with startId.',
            },
            full: { type: "boolean", description: "Restore all content down to original messages." },
          },
        },
        execute: makeDecompressExecutor(registry),
        options: opts,
      });
      tools.add({
        name: "search_context",
        description:
          "Search inside compressed blocks by keywords or phrase. Returns matching block references and their summaries. Use when a previous topic's details were compressed and you need them back.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query — keywords or phrase to find" },
            limit: { type: "number", description: "Maximum results to return (default: 10)" },
            deep: { type: "boolean", description: "If true, also search visible messages (default: false)" },
          },
          required: ["query"],
        },
        execute: makeSearchExecutor(registry),
        options: opts,
      });
      tools.add({
        name: "acp_status",
        description:
          "Show the current context compression state: context usage, visible message references (m00001...), and active compressed blocks (b1...). Run this before compress to see valid message/block references.",
        input: {
          type: "object",
          properties: {},
        },
        execute: makeStatusExecutor(registry),
        options: opts,
      });
      tools.add({
        name: "acp_context_recap",
        description:
          "Produce a recap of the conversation: what has been compressed (with summaries) plus the most recent visible context. Use to get up to speed after a long session or before continuing work.",
        input: {
          type: "object",
          properties: {
            detail: { type: "string", description: "Optional area of focus for the recap." },
          },
        },
        execute: makeRecapExecutor(registry),
        options: opts,
      });
    });

    // 3) /acp command
    if (config.commands.enabled) {
      await ctx.command.transform((commands) => {
        const existing = commands.get("acp");
        commands.update("acp", (cmd) => {
          cmd.description = "Show available ACP (Active Context Pruning) commands";
          if (!cmd.template) cmd.template = existing && existing.template ? existing.template : "";
        });
      }).catch((e) => logger.warn(`acp command registration failed: ${e && e.message}`));
    }

    // cleanup
    return () => {
      registry.sessions.clear();
    };
  },
};
