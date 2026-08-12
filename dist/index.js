// node_modules/acp-kernel/dist/index.js
import { createRequire } from "module";
var REF_WIDTH = 5;
var MIN_INDEX = 1;
var MAX_INDEX = 99999;
var REF_PATTERN = /^m0*(\d{1,5})$/;
var BLOCKED_REF = "BLOCKED";
function indexToRef(index) {
  if (!Number.isInteger(index) || index < MIN_INDEX || index > MAX_INDEX) {
    throw new RangeError(
      `ref index out of bounds: ${index} (allowed ${MIN_INDEX}-${MAX_INDEX})`
    );
  }
  return `m${String(index).padStart(REF_WIDTH, "0")}`;
}
function refToIndex(ref) {
  const match = REF_PATTERN.exec(ref.trim().toLowerCase());
  if (!match) return null;
  const index = Number(match[1]);
  if (index < MIN_INDEX || index > MAX_INDEX) return null;
  return index;
}
function refForRaw(map, rawId) {
  return map.byRaw[rawId] ?? null;
}
function assignRefs(messages, options) {
  const map = {
    byRaw: { ...options.existing.byRaw },
    byRef: { ...options.existing.byRef }
  };
  let cursor = Number.isInteger(options.nextIndex) && options.nextIndex >= MIN_INDEX ? options.nextIndex : MIN_INDEX;
  let newlyAssigned = 0;
  for (const message of messages) {
    if (!message.id || options.shouldSkip?.(message)) continue;
    if (map.byRaw[message.id]) continue;
    if (options.isProtected?.(message)) {
      map.byRaw[message.id] = BLOCKED_REF;
      continue;
    }
    const ref = allocateFreeRef(map, cursor);
    cursor = ref.index + 1;
    map.byRaw[message.id] = ref.text;
    map.byRef[ref.text] = message.id;
    newlyAssigned++;
  }
  return { map, nextIndex: cursor, newlyAssigned };
}
function allocateFreeRef(map, start) {
  let candidate = Math.max(start, MIN_INDEX);
  while (candidate <= MAX_INDEX) {
    const text = indexToRef(candidate);
    if (!map.byRef[text]) {
      return { text, index: candidate };
    }
    candidate++;
  }
  throw new Error(
    `ref capacity exhausted: cannot allocate beyond ${indexToRef(MAX_INDEX)}`
  );
}
function highestUsedIndex(map) {
  let highest = 0;
  for (const ref of Object.values(map.byRaw)) {
    const index = ref === BLOCKED_REF ? null : refToIndex(ref);
    if (index !== null && index > highest) highest = index;
  }
  return highest;
}
function createInitialState() {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      baselineTokens: 0,
      anchors: {},
      lastShownByTier: {}
    },
    stats: { tokensCompressed: 0, compressionCount: 0 },
    nextBlockId: 1,
    nextRunId: 1
  };
}
function allocateBlockId(state) {
  const id = state.nextBlockId;
  state.nextBlockId = Math.max(1, id) + 1;
  return `b${id}`;
}
function allocateRunId(state) {
  const id = state.nextRunId;
  state.nextRunId = Math.max(1, id) + 1;
  return `r${id}`;
}
function blockById(state, blockId) {
  return state.blocks.find((block) => block.blockId === blockId);
}
function activeBlocks(state) {
  return state.blocks.filter((block) => block.active);
}
function coveredMessageIds(state) {
  const covered = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}
function advanceSurvival(state, promotionThreshold) {
  for (const block of state.blocks) {
    if (!block.active) continue;
    block.survivedCount += 1;
    if (block.survivedCount >= promotionThreshold) {
      block.generation = "old";
    }
  }
}
var SUMMARY_HEADER = "[Compressed conversation section]";
function prune(messages, state, options = {}) {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];
  const inject = options.injectSummaries ?? true;
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user"
  );
  const indexById = /* @__PURE__ */ new Map();
  messages.forEach((message, index) => indexById.set(message.id, index));
  const anchors = inject ? collectSummaryAnchors(state, indexById) : [];
  return stripOrphanedToolResults(
    stripOrphanedToolCalls(
      rebuildMessages(messages, covered, firstUserIndex, anchors)
    )
  );
}
function collectSummaryAnchors(state, indexById) {
  const anchors = [];
  for (const block of activeBlocks(state)) {
    let earliest = null;
    for (const id of block.effectiveMessageIds) {
      const index = indexById.get(id);
      if (index !== void 0 && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      insertAt: earliest ?? 0
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}
function rebuildMessages(messages, covered, firstUserIndex, anchors) {
  const result = [];
  const pending = [...anchors];
  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0].insertAt === index) {
      result.push(renderSummary(pending.shift()));
    }
    if (index === firstUserIndex && firstUserIndex >= 0) {
      result.push(messages[index]);
      continue;
    }
    if (covered.has(messages[index].id)) continue;
    result.push(messages[index]);
  }
  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()));
  }
  return result;
}
function renderSummary(anchor) {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic ? `${SUMMARY_HEADER} \u2014 ${anchor.topic}` : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}
${body}`;
  return {
    id: `acp_summary_${anchor.blockId}`,
    role: "system",
    contentType: "text",
    text
  };
}
function stripOrphanedToolResults(messages) {
  const knownCallIds = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      knownCallIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) => m.contentType !== "tool-result" || !m.toolCallId || knownCallIds.has(m.toolCallId)
  );
}
function stripOrphanedToolCalls(messages) {
  const knownResultIds = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-result" && m.toolCallId) {
      knownResultIds.add(m.toolCallId);
    }
  }
  return messages.filter(
    (m) => m.contentType !== "tool-call" || !m.toolCallId || m.toolName === "compress" || knownResultIds.has(m.toolCallId)
  );
}
function syncBlocks(messages, state) {
  const presentIds = new Set(messages.map((message) => message.id));
  const deactivated = [];
  const result = {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds]
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef }
    },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId
  };
  const consumedBlockIds = /* @__PURE__ */ new Set();
  for (const block of result.blocks) {
    for (const consumedId of block.directBlockIds) {
      consumedBlockIds.add(consumedId);
    }
  }
  for (const block of result.blocks) {
    if (consumedBlockIds.has(block.blockId)) {
      block.active = false;
      continue;
    }
    block.active = true;
    const stillPresent = block.effectiveMessageIds.some(
      (id) => presentIds.has(id)
    );
    if (!stillPresent) {
      block.active = false;
      deactivated.push(block.blockId);
    }
  }
  return { state: result, deactivated };
}
var require2 = createRequire(import.meta.url);
function defaultCountTokens(text) {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk?.length ?? 0;
  return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}
function defaultConfig(modelContextLimit, overrides = {}) {
  const base = {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 5e4,
      growthCap: 5e4,
      minGrowthFloor: 2e4,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.8
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: {
      minCompressRange: 5e3,
      maxSummaryLength: 2e4,
      minSummaryLength: 50
    },
    protectedTools: [],
    preserveRecentMessages: 5,
    preserveRecentTokens: 5e3,
    modelContextLimit
  };
  return {
    ...base,
    ...overrides,
    tiers: { ...base.tiers, ...overrides.tiers },
    nudge: { ...base.nudge, ...overrides.nudge },
    truncate: { ...base.truncate, ...overrides.truncate },
    compress: { ...base.compress, ...overrides.compress }
  };
}
function validateConfig(config) {
  const errors = [];
  if (!Number.isFinite(config.modelContextLimit) || config.modelContextLimit <= 0) {
    errors.push("modelContextLimit must be a positive number");
  }
  if (config.nudge.minContextLimitPct > config.nudge.maxContextLimitPct) {
    errors.push(
      "nudge.minContextLimitPct must not exceed nudge.maxContextLimitPct"
    );
  }
  if (config.promotionThreshold < 1) {
    errors.push("promotionThreshold must be >= 1");
  }
  if (config.truncate.threshold <= 0 || config.truncate.threshold > 1) {
    errors.push("truncate.threshold must be in (0, 1]");
  }
  for (const tier of [config.tiers.tier2Trigger, config.tiers.tier3Trigger]) {
    if (tier < 1) errors.push("tier triggers must be >= 1");
  }
  if (config.tiers.tier3Trigger <= config.tiers.tier2Trigger) {
    errors.push("tiers.tier3Trigger must be greater than tiers.tier2Trigger");
  }
  return errors;
}
var MESSAGE_REF_PATTERN = /^m0*(\d{1,5})$/;
var BLOCK_REF_PATTERN = /^b(\d{1,9})$/;
function parseBoundary(ref) {
  const normalized = ref.trim().toLowerCase();
  const messageMatch = MESSAGE_REF_PATTERN.exec(normalized);
  if (messageMatch) {
    const numericId = Number(messageMatch[1]);
    if (numericId >= 1 && numericId <= 99999) {
      return { kind: "message", numericId, raw: normalized };
    }
  }
  const blockMatch = BLOCK_REF_PATTERN.exec(normalized);
  if (blockMatch) {
    const numericId = Number(blockMatch[1]);
    if (numericId >= 1) return { kind: "block", numericId, raw: normalized };
  }
  return null;
}
function resolveBoundaries(input) {
  const start = parseBoundary(input.startRef);
  const end = parseBoundary(input.endRef);
  if (!start || !end) {
    throw new Error(
      `Invalid boundary ref(s): startId="${input.startRef}", endId="${input.endRef}". Use mNNNNN or bN.`
    );
  }
  const indexByRawId = /* @__PURE__ */ new Map();
  input.messages.forEach(
    (message, index) => indexByRawId.set(message.id, index)
  );
  let startIndex = resolveAnchorIndex(start, input.state, indexByRawId);
  let endIndex = resolveAnchorIndex(end, input.state, indexByRawId);
  if (startIndex === null || endIndex === null) {
    throw new Error(
      `Boundary not found in visible context (likely consumed by an existing block). startId="${input.startRef}", endId="${input.endRef}".`
    );
  }
  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
  }
  const messageIds = [];
  for (let index = startIndex; index <= endIndex; index++) {
    const message = input.messages[index];
    if (message) messageIds.push(message.id);
  }
  const boundaryKind = start.kind === "block" || end.kind === "block" ? "block" : "message";
  const nestedBlockIds = [];
  const nestedSeen = /* @__PURE__ */ new Set();
  for (const block of activeBlocks(input.state)) {
    const anchor = earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
    if (anchor !== null && anchor >= startIndex && anchor <= endIndex) {
      if (!nestedSeen.has(block.blockId)) {
        nestedSeen.add(block.blockId);
        nestedBlockIds.push(block.blockId);
      }
    }
  }
  const protectedGaps = [];
  return {
    startIndex,
    endIndex,
    messageIds,
    nestedBlockIds,
    boundaryKind,
    protectedGaps
  };
}
function resolveAnchorIndex(boundary, state, indexByRawId) {
  if (boundary.kind === "message") {
    const rawId = state.messageRefs.byRef[boundary.raw] ?? state.messageRefs.byRef[formatPaddedRef(boundary.numericId)];
    if (!rawId) return null;
    const index = indexByRawId.get(rawId);
    return index === void 0 ? null : index;
  }
  const block = blockById(state, `b${boundary.numericId}`);
  if (!block || !block.active) return null;
  return earliestIndexOfIds(block.effectiveMessageIds, indexByRawId);
}
function formatPaddedRef(index) {
  return `m${String(index).padStart(5, "0")}`;
}
function earliestIndexOfIds(ids, indexByRawId) {
  let earliest = null;
  for (const id of ids) {
    const index = indexByRawId.get(id);
    if (index !== void 0 && (earliest === null || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}
var TRUNCATION_MARKER = "[truncated for context space]";
var DEFAULTS = {
  minOutputTokens: 1e3,
  keepPrefixChars: 2e3,
  keepSuffixChars: 2e3,
  protectRecentMessages: 3
};
function truncateLargeToolOutputs(messages, tokenCount, config, countTokens, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (config.modelContextLimit <= 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  const threshold = config.truncate.threshold * config.modelContextLimit;
  if (tokenCount < threshold) return { messages, truncatedCount: 0, savedTokens: 0 };
  const protectedIndex = messages.length - opts.protectRecentMessages;
  const candidates = [];
  for (let index = 0; index < messages.length; index++) {
    if (index >= protectedIndex) break;
    const message = messages[index];
    if (message.contentType !== "tool-result") continue;
    const text = message.text ?? "";
    if (text.length === 0 || text.includes(TRUNCATION_MARKER)) continue;
    const tokens = countTokens(text);
    if (tokens < opts.minOutputTokens) continue;
    candidates.push({ index, tokens });
  }
  if (candidates.length === 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  candidates.sort((left, right) => right.tokens - left.tokens);
  const targetTokens = threshold * 0.9;
  let savedTokens = 0;
  const edits = /* @__PURE__ */ new Map();
  let truncatedCount = 0;
  for (const candidate of candidates) {
    if (tokenCount - savedTokens <= targetTokens) break;
    const original = messages[candidate.index].text ?? "";
    if (original.length <= opts.keepPrefixChars + opts.keepSuffixChars) continue;
    const prefix = original.slice(0, opts.keepPrefixChars);
    const suffix = original.slice(-opts.keepSuffixChars);
    const replacement = prefix + `

...${TRUNCATION_MARKER} \u2014 original ~${candidate.tokens} tokens]...

` + suffix;
    edits.set(candidate.index, replacement);
    savedTokens += candidate.tokens - countTokens(replacement);
    truncatedCount++;
  }
  if (truncatedCount === 0) return { messages, truncatedCount: 0, savedTokens: 0 };
  const updated = messages.map(
    (message, index) => edits.has(index) ? { ...message, text: edits.get(index) } : message
  );
  return { messages: updated, truncatedCount, savedTokens };
}
var KEEP_LAST_ORPHANED = 0;
function rangeKey(startRef, endRef) {
  return `${startRef}::${endRef}`;
}
function rewriteCompressText(text, liveKeys) {
  let parsed;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed;
  const content = obj.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const kept = content.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const s = typeof entry.startId === "string" ? entry.startId : typeof entry.messageId === "string" ? entry.messageId : "";
    const e = typeof entry.endId === "string" ? entry.endId : typeof entry.messageId === "string" ? entry.messageId : "";
    return liveKeys.has(rangeKey(s, e));
  });
  if (kept.length === content.length || kept.length === 0) return null;
  return JSON.stringify({ ...obj, content: kept });
}
function hideConsumedCompressCalls(state, messages) {
  const allBlockCallIds = /* @__PURE__ */ new Set();
  const activeCallIds = /* @__PURE__ */ new Set();
  const liveRangeKeysByCallId = /* @__PURE__ */ new Map();
  const legacyLiveByCallId = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    allBlockCallIds.add(block.compressCallId);
    if (!block.active) continue;
    activeCallIds.add(block.compressCallId);
    if (block.startRef === void 0 || block.endRef === void 0) {
      legacyLiveByCallId.add(block.compressCallId);
      continue;
    }
    let keys = liveRangeKeysByCallId.get(block.compressCallId);
    if (!keys) {
      keys = /* @__PURE__ */ new Set();
      liveRangeKeysByCallId.set(block.compressCallId, keys);
    }
    keys.add(rangeKey(block.startRef, block.endRef));
  }
  const lastOrphanedCallIds = [];
  for (let i = messages.length - 1; i >= 0 && lastOrphanedCallIds.length < KEEP_LAST_ORPHANED; i--) {
    const message = messages[i];
    if (message.toolName !== "compress" || message.contentType !== "tool-call") continue;
    const callId = message.toolCallId;
    if (callId && !allBlockCallIds.has(callId)) {
      lastOrphanedCallIds.push(callId);
    }
  }
  const keepCallIds = /* @__PURE__ */ new Set([...activeCallIds, ...lastOrphanedCallIds]);
  const hiddenCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.toolName === "compress" && message.contentType === "tool-call" && (!message.toolCallId || !keepCallIds.has(message.toolCallId))) {
      if (message.toolCallId) hiddenCallIds.add(message.toolCallId);
    }
  }
  let hidden = 0;
  const result = [];
  for (const message of messages) {
    if (message.toolName === "compress" && message.contentType === "tool-call" && (!message.toolCallId || !keepCallIds.has(message.toolCallId))) {
      hidden++;
      continue;
    }
    if (message.contentType === "tool-result" && message.toolCallId && hiddenCallIds.has(message.toolCallId)) {
      hidden++;
      continue;
    }
    if (message.toolName === "compress" && message.contentType === "tool-call" && message.toolCallId && keepCallIds.has(message.toolCallId)) {
      const liveKeys = liveRangeKeysByCallId.get(message.toolCallId);
      if (liveKeys && liveKeys.size > 0 && !legacyLiveByCallId.has(message.toolCallId)) {
        const rewritten = rewriteCompressText(message.text, liveKeys);
        if (rewritten !== null) {
          result.push({ ...message, text: rewritten });
          continue;
        }
      }
    }
    result.push(message);
  }
  return { messages: result, hidden };
}
var registry = /* @__PURE__ */ new Map();
function listMessageFilters() {
  return [...registry.values()];
}
function applyMessageFilters(messages, config) {
  if (!config?.enabled) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }
  const active = listMessageFilters().filter(
    (filter) => config.filters?.[filter.name]?.enabled !== false
  );
  if (active.length === 0) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }
  let working = messages.map((message) => ({ ...message }));
  const tally = { partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  const total = working.length;
  const immediate = active.filter((filter) => !filter.keepLastOnly);
  for (let index = 0; index < working.length; index++) {
    const message = working[index];
    const text = message.text ?? "";
    if (text.length === 0) continue;
    let current = text;
    const baseCtx = {
      text: current,
      role: message.role,
      messageIndex: index,
      totalMessages: total,
      toolName: message.toolName
    };
    for (const filter of immediate) {
      let decision;
      try {
        decision = filter.filter(baseCtx);
      } catch {
        continue;
      }
      if (decision.action === "keep") continue;
      tally.partsFiltered++;
      if (decision.action === "drop") {
        current = "";
        tally.partsDropped++;
      } else if (decision.action === "modify" && decision.text !== void 0) {
        current = decision.text;
        tally.partsModified++;
      }
      baseCtx.text = current;
    }
    if (current !== text) working[index] = { ...message, text: current };
  }
  const keepLast = active.filter((filter) => filter.keepLastOnly);
  for (const filter of keepLast) {
    let foundLast = false;
    for (let index = working.length - 1; index >= 0; index--) {
      const message = working[index];
      const text = message.text ?? "";
      if (text.length === 0) continue;
      const ctx = {
        text,
        role: message.role,
        messageIndex: index,
        totalMessages: total,
        toolName: message.toolName
      };
      let decision;
      try {
        decision = filter.filter(ctx);
      } catch {
        continue;
      }
      if (decision.action !== "drop" && decision.action !== "modify") continue;
      if (foundLast) {
        tally.partsFiltered++;
        tally.partsDropped++;
        working[index] = { ...message, text: "" };
      } else {
        foundLast = true;
        if (decision.action === "modify" && decision.text !== void 0) {
          tally.partsFiltered++;
          tally.partsModified++;
          working[index] = { ...message, text: decision.text };
        }
      }
    }
  }
  return { messages: working, ...tally };
}
function formatTokens(tokens) {
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e4) return (tokens / 1e3).toFixed(1) + "K";
  return Math.round(tokens / 1e3) + "K";
}
function classifyType(message) {
  if (message.contentType === "tool-call" || message.contentType === "tool-result") {
    return message.toolName || "tool";
  }
  return message.contentType;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var LT = "<";
var GT = ">";
var TAG_OPEN = LT + "acp ";
var TAG_CLOSE = LT + "/acp" + GT;
function acpTag(ref, tokens, type) {
  return TAG_OPEN + 'tokens="' + formatTokens(tokens) + '" type="' + type + '"' + GT + ref + TAG_CLOSE;
}
function renderMessage(message, map, countTokens, strategy) {
  const ref = refForRaw(map, message.id);
  if (!ref || ref === BLOCKED_REF) return message;
  if (strategy === "none") return message;
  if (strategy === "text-only" && message.contentType !== "text") {
    return message;
  }
  const ownTagRe = new RegExp(
    "^" + escapeRegex(TAG_OPEN) + "[^>]*" + GT + escapeRegex(ref) + escapeRegex(TAG_CLOSE) + "\\n?"
  );
  const cleanText = (message.text || "").replace(ownTagRe, "");
  const tokens = countTokens(cleanText);
  const type = classifyType(message);
  const prefix = acpTag(ref, tokens, type) + "\n";
  if (!cleanText) return { ...message, text: prefix };
  return { ...message, text: prefix + cleanText };
}
function renderVisibleRefs(messages, state, countTokens = (text) => Math.ceil(text.length / 4), strategy = "all") {
  const map = state.messageRefs;
  return messages.map(
    (message) => renderMessage(message, map, countTokens, strategy)
  );
}
function createRenderRefsNode(strategy) {
  return {
    name: "render-refs",
    run(io, ctx) {
      return {
        ...io,
        messages: renderVisibleRefs(io.messages, io.state, ctx.countTokens, strategy)
      };
    }
  };
}
var renderRefsNode = createRenderRefsNode("all");
var ALWAYS_PROTECTED_TOOLS = ["compress"];
var NEVER_PRESERVE_RECENT_TOOLS = [
  "decompress",
  "search_context",
  "read",
  "bash"
];
function isNeverPreserveRecent(msg) {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result") {
    return false;
  }
  if (!msg.toolName) return false;
  return NEVER_PRESERVE_RECENT_TOOLS.includes(msg.toolName);
}
function matchToolPattern(toolName, pattern) {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}
function isMessageProtected(msg, config) {
  if (msg.contentType !== "tool-call" && msg.contentType !== "tool-result" || !msg.toolName) {
    return false;
  }
  if (ALWAYS_PROTECTED_TOOLS.includes(msg.toolName)) {
    return true;
  }
  for (const pattern of config.protectedTools) {
    if (matchToolPattern(msg.toolName, pattern)) return true;
  }
  if (config.isToolProtected?.(msg.toolName, msg.text)) return true;
  return false;
}
function collectProtectedToolCallIds(messages, config) {
  const ids = /* @__PURE__ */ new Set();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId && isMessageProtected(m, config)) {
      ids.add(m.toolCallId);
    }
  }
  return ids;
}
function isMessageProtectedWithPairing(msg, config, protectedCallIds) {
  if (isMessageProtected(msg, config)) return true;
  if (msg.contentType === "tool-result" && msg.toolCallId && protectedCallIds.has(msg.toolCallId)) {
    return true;
  }
  return false;
}
function adjustBoundariesForToolPairs(startIndex, endIndex, messages, maxScan = 20) {
  const callIdsInRange = /* @__PURE__ */ new Set();
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (!msg || !msg.toolCallId) continue;
    if (msg.toolName === "compress") continue;
    callIdsInRange.add(msg.toolCallId);
  }
  if (callIdsInRange.size === 0) {
    return { startIndex, endIndex };
  }
  let newEndIndex = endIndex;
  for (let i = endIndex + 1; i < messages.length && i <= endIndex + maxScan; i++) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newEndIndex = i;
    } else if (newEndIndex > endIndex) {
      break;
    }
  }
  let newStartIndex = startIndex;
  for (let i = startIndex - 1; i >= 0 && i >= startIndex - maxScan; i--) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newStartIndex = i;
    } else if (newStartIndex < startIndex) {
      break;
    }
  }
  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
function refNum(ref) {
  const n = parseInt(ref.slice(1), 10);
  return Number.isNaN(n) ? -1 : n;
}
function estimateTextTokens(text) {
  return Math.ceil(text.length / 4);
}
function isToolMessage(message) {
  return message.contentType === "tool-call" || message.contentType === "tool-result";
}
function isSyntheticOrPruned(message, state) {
  if (message.text?.startsWith("[Compressed conversation section]")) return true;
  for (const block of state.blocks) {
    if (block.active && block.effectiveMessageIds.includes(message.id)) return true;
  }
  return false;
}
function computeProtectedRefs(messages, state, config, countTokens = estimateTextTokens) {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;
  const result = /* @__PURE__ */ new Set();
  const visible = [];
  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    if (isNeverPreserveRecent(msg)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: countTokens(msg.text ?? "") });
  }
  if (preserveN > 0) {
    for (const m of visible.slice(-preserveN)) {
      result.add(m.ref);
    }
  }
  if (preserveTokens > 0) {
    let tokenAccum = 0;
    for (let i = visible.length - 1; i >= 0 && tokenAccum < preserveTokens; i--) {
      result.add(visible[i].ref);
      tokenAccum += visible[i].tokens;
    }
  }
  if (preserveN > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user" || isSyntheticOrPruned(msg, state)) continue;
      const ref = state.messageRefs.byRaw[msg.id];
      if (ref && ref !== "BLOCKED") result.add(ref);
      break;
    }
  }
  return result;
}
function buildCompressibleRanges(messages, state, config, protectedZoneRefs, countTokens = estimateTextTokens) {
  const compressibleMsgs = [];
  const protectedMsgs = [];
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, state)) continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    const rn = refNum(ref);
    if (isMessageProtectedWithPairing(msg, config, protectedCallIds)) {
      protectedMsgs.push({
        ref,
        refNum: rn,
        tokens: countTokens(msg.text ?? ""),
        tools: msg.toolName ? [msg.toolName] : []
      });
      continue;
    }
    if (protectedZoneRefs?.has(ref)) {
      continue;
    }
    compressibleMsgs.push({
      ref,
      refNum: rn,
      tokens: countTokens(msg.text ?? ""),
      isTool: isToolMessage(msg),
      isUser: msg.role === "user"
    });
  }
  const compressible = [];
  let cur = null;
  let prevRefNum = -2;
  for (const info of compressibleMsgs) {
    const hasGap = info.refNum > prevRefNum + 1;
    if (cur && (info.isUser && cur.count >= 3 || hasGap)) {
      compressible.push(cur);
      cur = null;
    }
    prevRefNum = info.refNum;
    if (!cur) {
      cur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        toolPct: info.isTool ? 100 : 0,
        textPct: info.isTool ? 0 : 100
      };
    } else {
      cur.endRef = info.ref;
      cur.count++;
      cur.tokens += info.tokens;
      if (info.isTool) {
        cur.toolPct = Math.round((cur.toolPct * (cur.count - 1) + 100) / cur.count);
      } else {
        cur.toolPct = Math.round(cur.toolPct * (cur.count - 1) / cur.count);
      }
      cur.textPct = 100 - cur.toolPct;
    }
  }
  if (cur) compressible.push(cur);
  const protectedRanges = [];
  let pcur = null;
  let pPrevRefNum = -2;
  for (const info of protectedMsgs) {
    const hasGap = info.refNum > pPrevRefNum + 1;
    if (pcur && hasGap) {
      protectedRanges.push(pcur);
      pcur = null;
    }
    pPrevRefNum = info.refNum;
    if (!pcur) {
      pcur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        tools: [...info.tools]
      };
    } else {
      pcur.endRef = info.ref;
      pcur.count++;
      pcur.tokens += info.tokens;
      for (const t of info.tools) {
        if (!pcur.tools.includes(t)) pcur.tools.push(t);
      }
    }
  }
  if (pcur) protectedRanges.push(pcur);
  return {
    compressible: compressible.filter((g) => g.tokens > 0),
    protected: protectedRanges
  };
}
function runPipeline(nodes, initial, ctx) {
  let io = initial;
  for (const node of nodes) {
    if (node.enabled && !node.enabled(io, ctx)) continue;
    io = node.run(io, ctx);
  }
  return io;
}
function createCore(ports = {}) {
  const countTokens = ports.countTokens ?? defaultCountTokens;
  function applyCompression(input) {
    const state = cloneState(input.state);
    const runId = allocateRunId(state);
    let blocksCreated = 0;
    let tokensCompressed = 0;
    const errors = [];
    const warnings = [];
    const protectedMessageIds = input.protectedMessageIds ?? computeProtectedRefs(input.messages, input.state, input.config, countTokens);
    const preExistingCoverage = collectCoverage(state);
    const rangeIndexSets = [];
    for (const spec of input.ranges) {
      let resolved;
      try {
        resolved = resolveBoundaries({
          startRef: spec.startRef,
          endRef: spec.endRef,
          messages: input.messages,
          state
        });
      } catch {
        continue;
      }
      const indices = resolved.messageIds.map(
        (id) => input.messages.findIndex((m) => m.id === id)
      ).filter((i) => i >= 0);
      rangeIndexSets.push({ spec, indices });
    }
    const sortedRanges = [...rangeIndexSets].sort((a, b) => {
      const aMin = a.indices.length > 0 ? Math.min(...a.indices) : Infinity;
      const bMin = b.indices.length > 0 ? Math.min(...b.indices) : Infinity;
      return aMin - bMin;
    });
    const skipSpecs = /* @__PURE__ */ new Set();
    let acceptedMaxIndex = -1;
    for (const entry of sortedRanges) {
      const entryMax = entry.indices.length > 0 ? Math.max(...entry.indices) : -1;
      const entryMin = entry.indices.length > 0 ? Math.min(...entry.indices) : -1;
      if (entryMin >= 0 && entryMin <= acceptedMaxIndex) {
        skipSpecs.add(entry.spec);
        warnings.push(
          `Skipped range (${entry.spec.startRef}..${entry.spec.endRef}) \u2014 overlaps an earlier range in the batch; the earlier range takes precedence. Keep ranges disjoint.`
        );
        continue;
      }
      if (entryMax > acceptedMaxIndex) acceptedMaxIndex = entryMax;
    }
    if (input.config.compress.minCompressRange > 0 && input.ranges.length > 0) {
      let totalRangeChars = 0;
      let hasBlockBoundaryRange = false;
      for (const spec of input.ranges) {
        if (skipSpecs.has(spec)) continue;
        let resolved;
        try {
          resolved = resolveBoundaries({
            startRef: spec.startRef,
            endRef: spec.endRef,
            messages: input.messages,
            state
          });
        } catch {
          continue;
        }
        if (resolved.boundaryKind === "block") {
          hasBlockBoundaryRange = true;
          continue;
        }
        for (const id of resolved.messageIds) {
          const msg = input.messages.find((m) => m.id === id);
          totalRangeChars += msg?.text?.length ?? 0;
        }
      }
      if (!hasBlockBoundaryRange && totalRangeChars < input.config.compress.minCompressRange) {
        return {
          state: input.state,
          result: {
            blocksCreated: 0,
            tokensCompressed: 0,
            errors: [
              `Total compressible content too small (${totalRangeChars} chars across ${input.ranges.length} range(s), min ${input.config.compress.minCompressRange}). Combine more messages into your range(s) to meet the threshold.`
            ],
            warnings: []
          }
        };
      }
    }
    for (const spec of input.ranges) {
      if (skipSpecs.has(spec)) continue;
      try {
        const outcome = applySingleRange({
          spec,
          messages: input.messages,
          state,
          runId,
          config: input.config,
          protectedMessageIds,
          countTokens,
          preExistingCoverage
        });
        blocksCreated++;
        tokensCompressed += outcome.tokens;
        warnings.push(...outcome.warnings);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    state.stats.compressionCount += blocksCreated;
    state.stats.tokensCompressed += tokensCompressed;
    if (blocksCreated > 0) {
      state.nudge.lastPerMessageNudgeTokens = 0;
      state.nudge.lastNudgeShownTokens = 0;
      state.nudge.lastShownByTier = {};
    }
    return { state, result: { blocksCreated, tokensCompressed, errors, warnings } };
  }
  function processTurn(input) {
    const configErrors = validateConfig(input.config);
    if (configErrors.length > 0) {
      console.warn(`[acp-kernel] Config validation warnings: ${configErrors.join("; ")}. Thresholds may not fire correctly.`);
    }
    const ctx = {
      config: input.config,
      tokenCount: input.tokenCount,
      countTokens
    };
    const initial = {
      messages: input.messages,
      state: input.state,
      effects: {}
    };
    const strategy = input.renderTags ?? "all";
    const nodes = buildNodes(strategy);
    const result = runPipeline(nodes, initial, ctx);
    return {
      messages: result.messages,
      state: result.state,
      nudge: result.effects.nudge
    };
  }
  function decompress(blockId, state) {
    return blockById(state, blockId);
  }
  function search(query, state) {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    if (terms.length === 0) return [];
    const scored = activeBlocks(state).map((block) => ({ block, score: scoreRelevance(block, terms) })).filter((entry) => entry.score > 0.1).sort((left, right) => right.score - left.score);
    return scored.map((entry) => entry.block);
  }
  function status(state, tokenCount, config) {
    const active = activeBlocks(state);
    const usage = config.modelContextLimit > 0 ? tokenCount / config.modelContextLimit : 0;
    return {
      contextUsage: usage,
      tokenCount,
      modelContextLimit: config.modelContextLimit,
      activeBlocks: active.length,
      totalBlocks: state.blocks.length,
      tokensCompressed: state.stats.tokensCompressed,
      breakdown: { active: active.length, total: state.blocks.length }
    };
  }
  function defaultNodes() {
    return buildNodes("all");
  }
  function buildNodes(strategy) {
    const base = [
      assignRefsNode,
      syncBlocksNode,
      pruneNode,
      filterNode,
      hideCompressCallsNode,
      recommendNode,
      nudgeNode,
      emergencyTruncateNode
    ];
    if (strategy === "none") return base;
    return [...base, createRenderRefsNode(strategy)];
  }
  return { processTurn, applyCompression, defaultNodes, decompress, search, status };
}
var assignRefsNode = {
  name: "assign-refs",
  run(io, ctx) {
    const hasProtection = ctx.config.protectedTools.length > 0 || !!ctx.config.isToolProtected;
    const protectedFn = hasProtection ? (m) => isMessageProtected(m, ctx.config) : void 0;
    const refResult = assignRefs(io.messages, {
      existing: io.state.messageRefs,
      nextIndex: highestUsedIndex(io.state.messageRefs) + 1,
      isProtected: protectedFn
    });
    return { ...io, state: { ...io.state, messageRefs: refResult.map } };
  }
};
var syncBlocksNode = {
  name: "sync-blocks",
  run(io, ctx) {
    const synced = syncBlocks(io.messages, io.state);
    advanceSurvival(synced.state, ctx.config.promotionThreshold);
    return { ...io, state: synced.state };
  }
};
var pruneNode = {
  name: "prune",
  run(io) {
    return { ...io, messages: prune(io.messages, io.state) };
  }
};
var filterNode = {
  name: "filter",
  enabled: (_io, ctx) => !!ctx.config.messageFilters?.enabled && listMessageFilters().length > 0,
  run(io, ctx) {
    const applied = applyMessageFilters(io.messages, ctx.config.messageFilters);
    return { ...io, messages: applied.messages };
  }
};
var hideCompressCallsNode = {
  name: "hide-compress-calls",
  run(io) {
    const hidden = hideConsumedCompressCalls(io.state, io.messages);
    return { ...io, messages: hidden.messages };
  }
};
var recommendNode = {
  name: "recommend",
  run(io, ctx) {
    const protectedRefs = computeProtectedRefs(
      io.messages,
      io.state,
      ctx.config,
      ctx.countTokens
    );
    const contextRanges = buildCompressibleRanges(
      io.messages,
      io.state,
      ctx.config,
      protectedRefs,
      ctx.countTokens
    );
    const nothingToCompress = contextRanges.compressible.length === 0;
    const recommendation = {
      contextRanges,
      recommendedRanges: contextRanges.compressible,
      nothingToCompress
    };
    return { ...io, effects: { ...io.effects, recommendation } };
  }
};
var nudgeNode = {
  name: "nudge-inject",
  run(io, ctx) {
    const nudge = decideNudge({
      tokenCount: ctx.tokenCount,
      config: ctx.config,
      state: io.state,
      messages: io.messages,
      recommendation: io.effects.recommendation,
      countTokens: ctx.countTokens
    });
    const baseline = io.state.nudge.lastPerMessageNudgeTokens;
    const nudgeGrowthTokens = resolveAdaptiveGrowth(
      ctx.config.modelContextLimit,
      ctx.config.nudge
    );
    let stamped = { ...io.state.nudge };
    if (baseline > 0 && ctx.tokenCount < baseline - nudgeGrowthTokens) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
      stamped.lastNudgeShownTokens = 0;
    }
    if (stamped.lastPerMessageNudgeTokens === 0) {
      stamped.lastPerMessageNudgeTokens = ctx.tokenCount;
    }
    if (nudge.shouldInject) {
      stamped.lastNudgeShownTokens = ctx.tokenCount;
      if (nudge.tier !== null) {
        stamped.lastShownByTier = { ...stamped.lastShownByTier, [nudge.tier]: ctx.tokenCount };
      }
    }
    return {
      ...io,
      state: { ...io.state, nudge: stamped },
      effects: { ...io.effects, nudge }
    };
  }
};
var emergencyTruncateNode = {
  name: "emergency-truncate",
  run(io, ctx) {
    const usage = ctx.config.modelContextLimit > 0 ? ctx.tokenCount / ctx.config.modelContextLimit : 0;
    if (usage < ctx.config.truncate.threshold) return io;
    const trunc = truncateLargeToolOutputs(
      io.messages,
      ctx.tokenCount,
      ctx.config,
      ctx.countTokens,
      { protectRecentMessages: ctx.config.preserveRecentMessages }
    );
    return {
      ...io,
      messages: trunc.messages,
      effects: { ...io.effects, truncatedCount: trunc.truncatedCount }
    };
  }
};
function applySingleRange(input) {
  const warnings = [];
  const resolved = resolveBoundaries({
    startRef: input.spec.startRef,
    endRef: input.spec.endRef,
    messages: input.messages,
    state: input.state
  });
  const rangeMessageIds = applyToolPairAdjustment(
    resolved,
    input.messages
  );
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByRawId = /* @__PURE__ */ new Map();
    input.messages.forEach((m, i) => indexByRawId.set(m.id, i));
    const adjustedStart = indexByRawId.get(rangeMessageIds[0]) ?? resolved.startIndex;
    const adjustedEnd = indexByRawId.get(rangeMessageIds[rangeMessageIds.length - 1]) ?? resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block2 of activeBlocks(input.state)) {
      if (nestedSeen.has(block2.blockId)) continue;
      const anchor = earliestIndexOfIds(block2.effectiveMessageIds, indexByRawId);
      if (anchor !== null && anchor >= adjustedStart && anchor <= adjustedEnd) {
        nestedSeen.add(block2.blockId);
        resolved.nestedBlockIds.push(block2.blockId);
      }
    }
  }
  const isBlockBoundary = resolved.boundaryKind === "block";
  const targetTier = resolveTargetTier(
    input.state,
    resolved.nestedBlockIds,
    isBlockBoundary
  );
  const outputTier = isBlockBoundary ? Math.min(3, targetTier + 1) : 1;
  const consumedBlockIds = resolved.nestedBlockIds.filter((id) => {
    const block2 = blockById(input.state, id);
    return block2?.active && block2.tier === targetTier;
  });
  const effectiveMessageIds = new Set(rangeMessageIds);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      for (const id of consumed.effectiveMessageIds)
        effectiveMessageIds.add(id);
    }
  }
  const directMessageIds = [...effectiveMessageIds].filter(
    (id) => !input.preExistingCoverage.has(id)
  );
  let filteredIds = filterProtectedToolMessages(
    directMessageIds,
    input.messages,
    input.config
  );
  if (filteredIds.length < directMessageIds.length) {
    const kept = new Set(filteredIds);
    for (const id of directMessageIds) {
      if (!kept.has(id)) effectiveMessageIds.delete(id);
    }
  }
  const protectedRefs = input.protectedMessageIds;
  const hitProtectedRaw = protectedRefs ? filteredIds.filter((id) => {
    const ref = input.state.messageRefs.byRaw[id];
    return ref !== void 0 && protectedRefs.has(ref);
  }) : [];
  if (hitProtectedRaw.length > 0) {
    const protectedSet = new Set(hitProtectedRaw);
    filteredIds = filteredIds.filter((id) => !protectedSet.has(id));
    for (const id of hitProtectedRaw) effectiveMessageIds.delete(id);
    const hitRefs = hitProtectedRaw.map((id) => input.state.messageRefs.byRaw[id]).filter((v) => typeof v === "string");
    if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
      const recentN = input.config.preserveRecentMessages;
      throw new Error(
        `Range is entirely within the protected zone (the last ${recentN} messages and/or the most recent user message): ${hitRefs.join(
          ", "
        )}. Adjust startId/endId to older messages.`
      );
    }
    warnings.push(
      `Excluded ${hitProtectedRaw.length} protected message(s) ${hitRefs.join(
        ", "
      )} from compression range (recent/last-user zone).`
    );
  }
  validateCompressionRange(input, filteredIds, consumedBlockIds.length);
  let compressedTokens = 0;
  for (const id of filteredIds) {
    const message = input.messages.find((entry) => entry.id === id);
    compressedTokens += input.countTokens(message?.text ?? "");
  }
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      compressedTokens += input.countTokens(consumed.summary);
    }
  }
  const blockId = allocateBlockId(input.state);
  const block = {
    blockId,
    runId: input.runId,
    tier: outputTier,
    topic: input.spec.topic,
    summary: input.spec.summary,
    directMessageIds: filteredIds,
    effectiveMessageIds: [...effectiveMessageIds],
    directBlockIds: [...consumedBlockIds],
    compressedTokens,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: input.spec.compressCallId,
    startRef: input.spec.startRef,
    endRef: input.spec.endRef
  };
  input.state.blocks.push(block);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) consumed.active = false;
  }
  return { tokens: compressedTokens, warnings };
}
function applyToolPairAdjustment(resolved, messages) {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  const adjusted = adjustBoundariesForToolPairs(
    resolved.startIndex,
    resolved.endIndex,
    messages
  );
  if (adjusted.startIndex === resolved.startIndex && adjusted.endIndex === resolved.endIndex) {
    return resolved.messageIds;
  }
  const ids = [];
  for (let i = adjusted.startIndex; i <= adjusted.endIndex; i++) {
    const msg = messages[i];
    if (msg) ids.push(msg.id);
  }
  return ids;
}
function validateCompressionRange(input, directMessageIds, consumedBlockCount) {
  const cfg = input.config.compress;
  const summary = input.spec.summary?.trim() ?? "";
  if (summary.length === 0) {
    throw new Error(
      "Summary is empty \u2014 provide a meaningful summary of the compressed range."
    );
  }
  if (cfg.minSummaryLength > 0 && summary.length < cfg.minSummaryLength) {
    throw new Error(
      `Summary too short (${summary.length} chars, min ${cfg.minSummaryLength}). The summary must capture the compressed range's key information.`
    );
  }
  const effectiveMax = input.spec.summaryMaxChars ?? cfg.maxSummaryLength;
  if (effectiveMax > 0 && summary.length > effectiveMax) {
    throw new Error(
      `Summary too long (${summary.length} chars, max ${effectiveMax}). Strip noise \u2014 keep critical paths, decisions, errors, and code references. Or pass summaryMaxChars to increase the limit \u2014 don't lose critical info just to fit.`
    );
  }
  if (directMessageIds.length === 0 && consumedBlockCount === 0) {
    throw new Error(
      "Range contains no compressible messages \u2014 all are already covered by active blocks or protected."
    );
  }
}
function filterProtectedToolMessages(directMessageIds, messages, config) {
  const protectedCallIds = /* @__PURE__ */ new Set();
  const removedIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (isMessageProtected(msg, config) && msg.toolCallId) {
      protectedCallIds.add(msg.toolCallId);
    }
  }
  for (const id of directMessageIds) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (isMessageProtected(msg, config)) {
      removedIds.add(id);
      if (msg.toolCallId) protectedCallIds.add(msg.toolCallId);
    }
  }
  for (const id of directMessageIds) {
    if (removedIds.has(id)) continue;
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (msg.contentType === "tool-result" && msg.toolCallId && protectedCallIds.has(msg.toolCallId)) {
      removedIds.add(id);
    }
  }
  return directMessageIds.filter((id) => !removedIds.has(id));
}
function resolveTargetTier(state, nestedBlockIds, isBlockBoundary) {
  if (!isBlockBoundary) return 1;
  if (nestedBlockIds.length === 0) return 1;
  let minTier = 3;
  for (const id of nestedBlockIds) {
    const block = blockById(state, id);
    if (block && block.tier < minTier) minTier = block.tier;
  }
  return minTier;
}
function collectCoverage(state) {
  const coverage = /* @__PURE__ */ new Set();
  for (const block of activeBlocks(state)) {
    for (const id of block.effectiveMessageIds) coverage.add(id);
  }
  return coverage;
}
function resolveAdaptiveGrowth(modelContextLimit, nudge) {
  if (!modelContextLimit || modelContextLimit <= 0) return nudge.growthFloor;
  return Math.min(
    nudge.growthCap,
    Math.max(
      nudge.growthFloor,
      Math.round(modelContextLimit * nudge.growthRatio)
    )
  );
}
function pendingByTier(state, recommendation, countTokens) {
  const out = {};
  const compressible = recommendation?.contextRanges.compressible ?? [];
  out[1] = { pending: compressible.reduce((s, r) => s + r.tokens, 0), targetBlocks: [] };
  const active = activeBlocks(state);
  const t1 = active.filter((b) => b.tier === 1);
  const t2 = active.filter((b) => b.tier === 2);
  out[2] = { pending: t1.reduce((s, b) => s + countTokens(b.summary), 0), targetBlocks: t1 };
  out[3] = { pending: t2.reduce((s, b) => s + countTokens(b.summary), 0), targetBlocks: t2 };
  return out;
}
function decideNudge(input) {
  const { config, state, tokenCount, recommendation, countTokens } = input;
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;
  const nudgeGrowthTokens = resolveAdaptiveGrowth(limit, config.nudge);
  const emergencyOverride = usage >= config.nudge.emergencyThresholdPct;
  const baseline = state.nudge.lastPerMessageNudgeTokens;
  const hadPendingNudge = state.nudge.lastNudgeShownTokens > 0;
  const hasPendingNudge = hadPendingNudge;
  const effectiveThreshold = hasPendingNudge ? Math.floor(nudgeGrowthTokens / 2) : nudgeGrowthTokens;
  const growthReference = state.nudge.lastNudgeShownTokens > 0 ? state.nudge.lastNudgeShownTokens : baseline > 0 ? baseline : tokenCount;
  const growthFloor = Math.max(
    config.nudge.minGrowthFloor,
    config.nudge.minGrowthRatio * nudgeGrowthTokens
  );
  const growthSinceReference = tokenCount - growthReference;
  const rec = recommendation;
  const tiers = pendingByTier(state, rec, countTokens);
  let injectedTier = null;
  let injectedReason = "";
  const growthReady = growthSinceReference >= growthFloor;
  if (!emergencyOverride && growthReady) {
    for (const tier of [1, 2, 3]) {
      if (!config.tiers.enabled && tier > 1) break;
      const info = tiers[tier];
      if (!info || info.pending < nudgeGrowthTokens) continue;
      const lastShown = state.nudge.lastShownByTier[tier] ?? 0;
      const cadenceMet = lastShown === 0 || tokenCount - lastShown >= growthFloor;
      if (!cadenceMet) continue;
      injectedTier = tier;
      injectedReason = tier === 1 ? `T1 compressible ${info.pending} >= ${nudgeGrowthTokens}, growth ${growthSinceReference}, usage ${Math.round(usage * 100)}%` : `T${tier} distill ready: ${info.targetBlocks.length} tier-${tier - 1} blocks (${info.pending} tokens) >= ${nudgeGrowthTokens}, usage ${Math.round(usage * 100)}%`;
      break;
    }
  }
  const shouldInject = emergencyOverride || injectedTier !== null;
  let reason;
  if (emergencyOverride) {
    reason = `EMERGENCY: usage ${Math.round(usage * 100)}% >= ${Math.round(config.nudge.emergencyThresholdPct * 100)}%`;
  } else if (injectedTier !== null) {
    reason = injectedReason;
  } else {
    const tiersList = [1, 2, 3];
    const eligible = tiersList.filter((t) => config.tiers.enabled || t === 1);
    const ready = eligible.filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens).map((t) => `T${t} ${tiers[t].pending}`);
    const readyHint = ready.length > 0 ? `, ready: ${ready.join(", ")}` : "";
    const blocked = eligible.filter((t) => (tiers[t]?.pending ?? 0) >= nudgeGrowthTokens && (state.nudge.lastShownByTier[t] ?? 0) > 0 && tokenCount - (state.nudge.lastShownByTier[t] ?? 0) < growthFloor).map((t) => `T${t} (cadence)`);
    const blockedHint = blocked.length > 0 ? `, blocked: ${blocked.join(", ")}` : "";
    const maxPending = Math.max(0, ...Object.values(tiers).map((t) => t.pending));
    const pendingShort = maxPending < nudgeGrowthTokens;
    const growthShort = growthSinceReference < growthFloor;
    const parts = [];
    if (pendingShort) parts.push(`max compressible ${maxPending} < threshold ${nudgeGrowthTokens}`);
    if (growthShort) parts.push(`growth ${growthSinceReference} < floor ${growthFloor}`);
    if (parts.length === 0) parts.push(`max compressible ${maxPending}, growth ${growthSinceReference}`);
    reason = `${parts.join("; ")}${readyHint}${blockedHint}`;
  }
  const ctxBreakdown = computeContextBreakdown(input.messages, tokenCount, growthSinceReference, countTokens);
  return {
    shouldInject,
    reason,
    compressibleRanges: rec?.recommendedRanges ?? [],
    protectedRanges: rec?.contextRanges.protected ?? [],
    tierTargetBlocks: injectedTier ? tiers[injectedTier].targetBlocks : [],
    contextUsage: usage,
    tier: injectedTier,
    breakdown: {
      usage,
      growth: growthSinceReference,
      growthReference,
      effectiveThreshold,
      nudgeGrowthTokens,
      growthFloor,
      hasPendingNudge: hasPendingNudge ? 1 : 0,
      emergencyOverride: emergencyOverride ? 1 : 0,
      pendingT1: tiers[1].pending,
      pendingT2: tiers[2].pending,
      pendingT3: tiers[3].pending
    },
    contextBreakdown: ctxBreakdown
  };
}
function computeContextBreakdown(messages, total, growth, countTokens) {
  const count = countTokens ?? ((t) => Math.ceil(t.length / 4));
  let system = 0, tool = 0, summaries = 0, code = 0, text = 0;
  for (const msg of messages) {
    const tokens = count(msg.text ?? "");
    if (msg.text?.startsWith("[Compressed conversation section]")) {
      summaries += tokens;
    } else if (msg.contentType === "tool-call" || msg.contentType === "tool-result") {
      tool += tokens;
    } else if (msg.role === "system") {
      system += tokens;
    } else if (msg.text?.includes("```")) {
      code += tokens;
    } else {
      text += tokens;
    }
  }
  return { system, tool, summaries, code, text, total, growth };
}
function cloneState(state) {
  return {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds]
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef }
    },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId
  };
}
function scoreRelevance(block, terms) {
  const topic = (block.topic ?? "").toLowerCase();
  const summary = block.summary.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const topicHits = countOccurrences(topic, term);
    if (topicHits > 0) score += Math.min(topicHits * 0.15, 0.45);
    const summaryHits = countOccurrences(summary, term);
    if (summaryHits > 0) score += Math.min(summaryHits * 0.04, 0.2);
  }
  return Math.min(score, 1);
}
function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}
var COMPRESS_PHILOSOPHY = `Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format \u2014 the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.`;
var HOW_TO_COMPRESS_RULES = `HOW TO COMPRESS

When you call \`compress\`, the summary you write becomes the only record of the replaced conversation. Make it self-contained and complete: every user request, experiment purpose, and work task in the range must be accurately captured. A later reader (or you, after decompressing) should be able to continue the task WITHOUT needing the original.

KEEP VERBATIM \u2014 never paraphrase or abbreviate these:
- Full file paths with line numbers, directory prefix on every mention (\`lib/hooks.ts:347\`, \`src/index.ts:12-18\`, \`gatenet_v3/model.py:45\`). Never abbreviate to a bare filename (\`hooks.ts\`, \`model.py\`) \u2014 they are ambiguous and cannot be grepped or decompressed-to later.
- Function, class, and type signatures (exact names, params, return types) AND critical code lines that encode logic \u2014 the line that IS the finding, not just the function name (e.g. \`kv_keys += define_gate * a_key[i](emb)\` is more useful than "see model_kvnet.py").
- Error messages and stack traces (exact text \u2014 you need the literal string to grep for it later).
- Key details from reports and analyses \u2014 not just the conclusion. Keep the comparison numbers and the mechanism, not "X is worse" alone (write "1.76\xD7 PPL gap because KV store is static", not "KVNet underperforms").
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing; without it the decision looks arbitrary).
- Constraints discovered ("must support Node 22", "no new dependencies", "AGENTS.md forbids \`as any\`").
- Exact values: versions, config keys, thresholds, magic numbers.
- User intent \u2014 quote short user messages verbatim. When the message is too long to quote, preserve intent with extra care: do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Mark them clearly as past quotes (e.g., "User said: ..."), not as current directives. Losing these changes the task itself.
- The user's overall goal and any changes to it \u2014 the big-picture objective plus how it evolved during the compressed range. Each summary must reflect the goal as it stood at the end of the range, including pivots (e.g., "initially: fix bug X \u2192 pivoted to: refactor module Y after discovering root cause"). Losing the goal or its evolution makes all subsequent work appear unmotivated.
- Purpose behind each significant action \u2014 preserve not just what was done but why: the hypothesis behind each experiment, the question behind each exploration, the task goal behind each work action. Without purpose, the summary reads as disconnected technical steps with no through-line.
- Open questions and unresolved TODOs \u2014 losing these changes what work appears to remain.
- Message refs of key anchors (\`m00420\`, \`m00510\u2013m00520\`) \u2014 they let you or a later reader jump back via decompress to the exact original.

DROP \u2014 extract the signal, discard the vessel:
- Verbose logs (build/test/\`npm\` output) once you have captured the error line or the result.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration \u2014 search hits, agent return values, successful tool outputs \u2014 once you have extracted the facts you need (same rule as dead-ends, but nothing went wrong; the content is simply spent).
- Dead-end exploration \u2014 but PRESERVE the lesson in one line: "tried X, failed because Y".
- Back-and-forth discussion and self-corrections once the final position is captured (keep the outcome, drop the journey to it).
- Repeated status checks (\`git status\`, \`ls\`) once state is known.

For each significant item you DROP (scripts, reports, large analyses, long tool outputs), add a one-line CONTENT description of what it covers \u2014 not where it lives. Bad: "probe script at /path/probe_kvnet.py". Good: "probe_kvnet.py: tests n-gram baseline, generation quality, long-range dependency, position sensitivity, op pipeline, QUERY attention." This lets a later decompress target the right block by relevance, not by guessing locations.

PRIORITY \u2014 when the summary must be compact, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints (losing these changes the task).
2. Decisions and rationale.
3. Exact technical artifacts: paths, signatures, errors, values.
4. Conclusions and key findings.
5. Lessons learned: what failed and why.

Write dense, scannable bullets \u2014 not narrative prose. If the range spans distinct concerns (request \u2192 findings \u2192 decision), group bullets under short thematic headers so a reader can scan to the part they need. Every line must earn its place. Do not mimic the style of existing summaries in context; follow these rules.`;
var TIER2_DISTILL_RULES = `TIER 2 COMPRESSION \u2014 DISTILLATION

You are compressing historical summaries (not raw conversation). These summaries have already captured the details. Your job is to DISTILL them: extract only what matters for future work, discard the process.

KEEP \u2014 these are the only things that survive distillation:
- Decisions and their rationale ("chose X over Y because Z" \u2014 the "because" is load-bearing).
- Final outcomes: version numbers shipped, PR numbers merged/closed, bugs fixed or deferred.
- Key lessons: what failed and why ("tried X, failed because Y"). These prevent repeating mistakes.
- Critical constraints discovered ("must support Node 22", "AGENTS.md forbids as any").
- Design decisions with architectural impact ("chose compress-as-anchor over synthetic messages because prefix cache").
- Whether content is OBSOLETE or SUPERSEDED \u2014 mark with one line: "[SUPERSEDED by PR #NNN]" or "[OBSOLETE: deleted in vX.Y.Z]". Do NOT keep the obsolete content's details \u2014 just the marker and reason.
- Function/class/type names and module paths that are the SUBJECT of the work \u2014 e.g., "fixed filterCompressedRanges in prune.ts", "added SessionStateRegistry in state.ts". Not exact line numbers or full signatures \u2014 just enough to LOCATE the code without searching.
- Exploration findings: if a block was exploratory with no decision, keep the CONCLUSION in one line ("explored X, not viable because Y"). Do not keep the exploration process.

DROP \u2014 these were useful during the work but are no longer needed:
- Exact line numbers, diffs, verbose function signatures, full code listings.
- Build/deploy process details, test execution steps.
- Review process details (who reviewed, what rounds, test counts).
- Verbose logs, command output, intermediate debugging steps.

FORMAT:
- Start each distilled block with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
  Example: \`Source: b5+b7 (56K+44K\u2192268 tok, 375x). [Tool-result recap + publish]\`
- 3-5 bullet points per source block, each a self-contained fact.
- Dense, scannable \u2014 no narrative prose.
- Start with the outcome, not the process: "v1.13.0 shipped (7 PRs bundled)" not "implemented 7 PRs then reviewed then merged".
- Cross-block synthesis: if multiple source blocks cover the same topic (same PR, same feature, same bug), MERGE them into a single group of bullets. Do not repeat the same fact from different blocks \u2014 keep it once under the most relevant source header.

SIZE TARGET: 50-150 tokens per source block (excluding the header). If you can't fit it in 150 tokens, you're keeping too much process. If a block has nothing worth keeping (pure noise), output just the header followed by "[no actionable content]."`;
var TIER3_CONDENSE_RULES = `TIER 3 COMPRESSION \u2014 ULTRA-CONDENSATION

You are compressing distilled summaries (Tier 2) into ultra-condensed facts (Tier 3). The distilled summaries already contain only decisions and outcomes. Your job is to reduce them to bare factual references.

PRIORITY \u2014 when a source block has more facts than the size target allows, keep in this order:
1. Shipped outcomes (versions released, PRs merged) \u2014 these are permanent record.
2. Open work (PRs/issues still pending) \u2014 these may need follow-up.
3. Key decisions with architectural impact ("chose X over Y because Z").
4. Critical constraints ("must support Node 22").
Drop everything else. Tier 3 is a lookup index, not a knowledge base.

FORMAT:
- Start with a source header line:
  \`Source: bN+bM+... (XK\u2192YK tok, Zx). [original topic]\`
- Output 1-3 facts per source block. Each fact is a single line: subject + outcome.
- No explanations, no rationale, no process \u2014 just the fact.
- Format: "[PR/Issue/Version] \u2014 [outcome in \u22648 words]"
- Merge related facts from different source blocks if they concern the same topic.

EXAMPLES:
- "v1.13.0 shipped \u2014 quality gate + GC fix (7 PRs)"
- "PR #196 merged \u2014 preserve-first-user (supersedes #169)"
- "Bug 1214 fixed \u2014 compress consumed all user messages"
- "Chose compress-as-anchor \u2014 prefix cache benefit over synthetic injection"
- "Constraint: AGENTS.md forbids as any \u2014 never suppress types"

DROP:
- Multi-sentence context. If a fact needs >1 sentence, it's too detailed for Tier 3.
- Lessons learned ("tried X, failed because Y") \u2014 drop UNLESS the failure is likely to recur and the block is <30 days old.
- Design rationale details \u2014 keep the decision, drop the "because" unless it's a critical constraint.
- Anything marked [OBSOLETE] or [SUPERSEDED] \u2014 drop entirely, note "[N blocks obsolete]" in the summary.

SIZE TARGET: 30-60 tokens per source block (including header). For a batch of N source blocks, total output \u2248 N \xD7 40 tokens. If a source block has only one trivial fact, output just the header + one line.`;
var EFFICIENCY_NOTE = `This is an efficiency nudge to compress early and keep context lean \u2014 not an overflow warning. A separate, stronger alert will appear if the context is actually full.

${COMPRESS_PHILOSOPHY}`;
var EMERGENCY_HEADER = `\u26A0\uFE0F Context limit reached \u2014 compress now. Prioritize consumed tool outputs.

${COMPRESS_PHILOSOPHY}`;
function formatK(n) {
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}
function formatBreakdown(bd) {
  if (!bd) return "";
  const parts = [];
  if (bd.system > 0) parts.push(`${formatK(bd.system)} system`);
  if (bd.tool > 0) parts.push(`${formatK(bd.tool)} tool`);
  if (bd.summaries > 0) parts.push(`${formatK(bd.summaries)} summaries`);
  if (bd.code > 0) parts.push(`${formatK(bd.code)} code`);
  if (bd.text > 0) parts.push(`${formatK(bd.text)} text`);
  const growth = bd.growth > 0 ? `
+${formatK(bd.growth)} since last nudge` : "";
  return `Context breakdown: ${parts.join(" | ")}${growth}`;
}
function formatTierTargetBlocks(blocks) {
  if (blocks.length === 0) {
    return "Target blocks: (none \u2014 no tier blocks found)";
  }
  const lines = blocks.map((b) => {
    const summaryTokens = Math.ceil((b.summary ?? "").length / 4);
    const topic = b.topic ? `  "${b.topic}"` : "";
    return `  ${b.blockId}  ${b.effectiveMessageIds.length} msgs  ${formatK(b.compressedTokens)}\u2192${formatK(summaryTokens)}${topic}`;
  });
  return `Target ${blocks[0].tier === 1 ? "tier-1" : "tier-2"} blocks to distill (${blocks.length}):
${lines.join("\n")}`;
}
function formatRanges(compressible, protectedRanges) {
  if (compressible.length === 0 && protectedRanges.length === 0) {
    return "[No specific ranges detected \u2014 compress any consumed content.]";
  }
  const refNum2 = (ref) => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const entries = [];
  for (const r of compressible) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum2(r.startRef),
      endNum: refNum2(r.endRef),
      count: r.count,
      tokens: r.tokens,
      toolPct: r.toolPct,
      textPct: r.textPct,
      compressibleTokens: r.tokens,
      compressibleCount: r.count,
      protectedTokens: 0,
      protectedCount: 0,
      protectedTools: [],
      dangerous: r.dangerous ?? false
    });
  }
  for (const r of protectedRanges) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum2(r.startRef),
      endNum: refNum2(r.endRef),
      count: r.count,
      tokens: r.tokens,
      toolPct: 0,
      textPct: 0,
      compressibleTokens: 0,
      compressibleCount: 0,
      protectedTokens: r.tokens,
      protectedCount: r.count,
      protectedTools: [...r.tools],
      dangerous: false
    });
  }
  entries.sort((a, b) => a.startNum - b.startNum);
  const merged = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && e.startNum <= last.endNum + 1) {
      last.endRef = e.endRef;
      last.endNum = Math.max(last.endNum, e.endNum);
      last.count += e.count;
      last.tokens += e.tokens;
      last.compressibleTokens += e.compressibleTokens;
      last.compressibleCount += e.compressibleCount;
      last.protectedTokens += e.protectedTokens;
      last.protectedCount += e.protectedCount;
      if (e.dangerous) last.dangerous = true;
      for (const t of e.protectedTools) {
        if (!last.protectedTools.includes(t)) last.protectedTools.push(t);
      }
    } else {
      merged.push({ ...e });
    }
  }
  const lines = merged.map((e) => {
    const suffix = e.dangerous && e.compressibleTokens > 0 ? "  \u26A0\uFE0F NOT recommended unless you are certain." : "";
    if (e.protectedTokens > 0 && e.compressibleTokens === 0) {
      return `  ${e.startRef}\u2013${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [PROTECTED: ${e.protectedTools.join(", ")} \u2014 not compressible]${suffix}`;
    }
    if (e.protectedTokens > 0 && e.compressibleTokens > 0) {
      return `  ${e.startRef}\u2013${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [${formatK(e.compressibleTokens)} compressible | ${formatK(e.protectedTokens)} protected: ${e.protectedTools.join(", ")}]${suffix}`;
    }
    return `  ${e.startRef}\u2013${e.endRef}  ${e.count} msgs  ${formatK(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${suffix}`;
  });
  return `Compressible ranges (${merged.length}, oldest first):
${lines.join("\n")}`;
}
function renderNudgeText(decision) {
  const breakdownStr = formatBreakdown(decision.contextBreakdown);
  const rangesStr = formatRanges(decision.compressibleRanges, decision.protectedRanges ?? []);
  if (decision.tier !== null && decision.tier >= 2) {
    const isT2 = decision.tier === 2;
    const targets = decision.tierTargetBlocks ?? [];
    const blockList = formatTierTargetBlocks(targets);
    const startId = targets[0]?.blockId ?? "b1";
    const endId = targets[targets.length - 1]?.blockId ?? "b5";
    return {
      voice: "gentle",
      text: [
        EFFICIENCY_NOTE,
        "",
        breakdownStr,
        "",
        `[TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"} TRIGGER]`,
        isT2 ? `Your tier-1 compression summaries have accumulated. Distill them into a single denser tier-2 summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-2 block as well \u2014 apply HOW TO COMPRESS to those raw messages and the TIER 2 distillation rules to the existing summaries, so the whole span is covered and nothing is lost.` : `Your tier-2 compression summaries have accumulated. Condense them further into a tier-3 ultra-condensed summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-3 block as well \u2014 apply HOW TO COMPRESS to those raw messages and the TIER 3 condensation rules to the existing summaries, so the whole span is covered and nothing is lost.`,
        blockList,
        `Example: compress({ content: [{ startId: "${startId}", endId: "${endId}", summary: "..." }] })`,
        "",
        HOW_TO_COMPRESS_RULES,
        "",
        isT2 ? TIER2_DISTILL_RULES : TIER3_CONDENSE_RULES
      ].join("\n")
    };
  }
  const isEmergency = !!decision.breakdown?.emergencyOverride;
  if (isEmergency) {
    return {
      voice: "emergency",
      text: [
        EMERGENCY_HEADER,
        "",
        breakdownStr,
        "",
        HOW_TO_COMPRESS_RULES,
        "",
        `{ "topic": "...", "content": [{ "startId": "<ID>", "endId": "<ID>", "summary": "..." }] }`,
        "Only use IDs from visible messages above. Compress older work first.",
        "",
        rangesStr
      ].join("\n")
    };
  }
  return {
    voice: "gentle",
    text: [
      EFFICIENCY_NOTE,
      "",
      breakdownStr,
      "",
      HOW_TO_COMPRESS_RULES,
      "",
      rangesStr,
      "",
      `\u{1F4A1} Compress all ranges in one call (pass multiple content entries: \`content: [{...}, {...}]\`).`
    ].join("\n")
  };
}
function parseBlockIdArg(arg) {
  const normalized = arg.trim().toLowerCase();
  const refMatch = /^b0*(\d+)$/.exec(normalized);
  if (refMatch && refMatch[1] !== void 0) return `b${refMatch[1]}`;
  const numMatch = /^(\d+)$/.exec(normalized);
  if (numMatch && numMatch[1] !== void 0) return `b${numMatch[1]}`;
  return null;
}
function collectBlockContent(state, block, messages, options = {}) {
  const full = options.full ?? false;
  const targetIds = new Set(block.effectiveMessageIds);
  if (full) {
    const msgs = messages.filter((m) => targetIds.has(m.id));
    if (msgs.length === 0) return { text: "", count: 0 };
    return { text: msgs.map(formatMessage).join("\n\n"), count: msgs.length };
  }
  const nestedChildren = [];
  const nestedCovered = /* @__PURE__ */ new Set();
  for (const childId of block.directBlockIds) {
    const child = state.blocks.find((b) => b.blockId === childId);
    if (!child?.active) continue;
    nestedChildren.push(child);
    for (const id of child.effectiveMessageIds) nestedCovered.add(id);
  }
  const parts = [];
  for (const child of nestedChildren) {
    const label = child.topic ? `${child.blockId}: ${child.topic}` : child.blockId;
    parts.push(`${SUMMARY_HEADER} \u2014 ${label}
${child.summary}`);
  }
  let directCount = 0;
  for (const m of messages) {
    if (targetIds.has(m.id) && !nestedCovered.has(m.id)) {
      parts.push(formatMessage(m));
      directCount++;
    }
  }
  const count = directCount + nestedChildren.length;
  if (count === 0) return { text: "", count: 0 };
  return { text: parts.join("\n\n"), count };
}
function formatMessage(message) {
  const text = message.text ?? "";
  if (message.toolName && message.contentType !== "text") {
    return `[${message.role} \u2022 ${message.toolName}]
${text}`;
  }
  return `[${message.role}]
${text}`;
}
function formatTokens2(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
}
function pct(n, total) {
  if (n <= 0 || total <= 0) return 0;
  return Math.max(1, Math.round(n / total * 100));
}
function numericPart2(blockId) {
  const match = /^b(\d+)$/.exec(blockId);
  return match && match[1] !== void 0 ? Number(match[1]) : 0;
}
function summaryTokensOf(block, countTokens) {
  return countTokens(block.summary);
}
function effectiveCompressedTokens(block, _state, _countTokens) {
  return block.compressedTokens;
}
function tierLabel(block) {
  return `T${block.tier}`;
}
function tierBreakdown(blocks, countTokens) {
  const tierTokens = {};
  for (const block of blocks) {
    tierTokens[block.tier] = (tierTokens[block.tier] ?? 0) + summaryTokensOf(block, countTokens);
  }
  const tiers = Object.keys(tierTokens).map(Number);
  if (tiers.length <= 1) return null;
  const parts = [];
  for (const tier of [1, 2, 3]) {
    if (tierTokens[tier]) parts.push(`T${tier}: ${formatTokens2(tierTokens[tier])}`);
  }
  return parts.join(" | ");
}
function collectVisible(messages, state, countTokens) {
  const coveredIds = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) coveredIds.add(id);
  }
  let summaryTokens = 0;
  for (const block of state.blocks) {
    if (block.active) summaryTokens += summaryTokensOf(block, countTokens);
  }
  const visible = [];
  messages.forEach((message, index) => {
    if (coveredIds.has(message.id)) return;
    const ref = refForRaw(state.messageRefs, message.id);
    if (!ref) return;
    const tokens = countTokens(message.text ?? "");
    const tool = message.toolName ?? "text";
    if (tokens > 0) visible.push({ ref, tokens, tool, index });
  });
  return { visible, summaryTokens };
}
function buildStatusReport(state, messages, countTokens, options = {}) {
  const scope = options.scope;
  const view = options.view ?? "ranges";
  const toolFilter = options.tool;
  const sort = options.sort ?? "size";
  const limit = options.limit ?? 30;
  const activeBlocks2 = state.blocks.filter((b) => b.active).sort((a, b) => numericPart2(a.blockId) - numericPart2(b.blockId));
  if (scope === "compressed") {
    return renderCompressedDrilldown(activeBlocks2, state, sort, limit, countTokens);
  }
  const { visible, summaryTokens } = collectVisible(messages, state, countTokens);
  if (scope === "uncompressed") {
    if (view === "messages") {
      return renderMessageDrilldown(visible, toolFilter, sort, limit);
    }
    return renderUncompressedRanges(visible);
  }
  return renderOverview(visible, summaryTokens, activeBlocks2, state, countTokens, limit);
}
function renderOverview(visible, summaryTokens, blocks, state, countTokens, limit) {
  const lines = [];
  const toolTypeMap = /* @__PURE__ */ new Map();
  for (const message of visible) {
    toolTypeMap.set(message.tool, (toolTypeMap.get(message.tool) ?? 0) + message.tokens);
  }
  const topTool = [...toolTypeMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const totalTool = visible.filter((m) => m.tool !== "text").reduce((sum, m) => sum + m.tokens, 0);
  const totalText = visible.filter((m) => m.tool === "text").reduce((sum, m) => sum + m.tokens, 0);
  const total = summaryTokens + totalTool + totalText;
  lines.push("CONTEXT BREAKDOWN");
  lines.push(
    `  ${formatTokens2(totalTool)} tool (${pct(totalTool, total)}%) | ${formatTokens2(totalText)} text (${pct(totalText, total)}%) | ${formatTokens2(summaryTokens)} summaries (${pct(summaryTokens, total)}%)`
  );
  const topTypes = [...toolTypeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topTypes.length > 0) {
    lines.push(`  Top tools: ${topTypes.map(([t, n]) => `${t} (${pct(n, total)}%)`).join(", ")}`);
  }
  lines.push("");
  if (blocks.length === 0) {
    lines.push("COMPRESSED BLOCKS");
    lines.push("  No compressed blocks.");
  } else {
    const totalSummary = blocks.reduce((s, b) => s + summaryTokensOf(b, countTokens), 0);
    const totalEffective = blocks.reduce(
      (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
      0
    );
    lines.push(
      `COMPRESSED BLOCKS \u2014 ${blocks.length} active (${formatTokens2(totalSummary)} summary, ${formatTokens2(totalEffective)} original)`
    );
    const breakdown = tierBreakdown(blocks, countTokens);
    if (breakdown) lines.push(`  Tier usage: ${breakdown}`);
    lines.push("");
    const sorted = [...blocks].sort(
      (a, b) => effectiveCompressedTokens(b, state, countTokens) - effectiveCompressedTokens(a, state, countTokens) || b.createdAt - a.createdAt
    );
    for (const block of sorted.slice(0, limit)) {
      const topic = block.topic ?? "(no topic)";
      const eff = effectiveCompressedTokens(block, state, countTokens);
      lines.push(
        `  ${block.blockId} (${tierLabel(block)})  ${formatTokens2(eff)}\u2192${formatTokens2(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  "${topic}"`
      );
    }
  }
  lines.push("");
  lines.push(
    `Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"${topTool ?? "bash"}"}) for per-message listing`
  );
  return lines.join("\n");
}
function renderUncompressedRanges(visible) {
  const lines = [];
  const totalTokens = visible.reduce((s, m) => s + m.tokens, 0);
  lines.push(`UNCOMPRESSED \u2014 ${formatTokens2(totalTokens)} | ${visible.length} visible messages`);
  lines.push("");
  if (visible.length === 0) {
    lines.push("  (no uncompressed messages)");
    return lines.join("\n");
  }
  const refNum2 = (ref) => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const merged = [];
  for (const m of visible) {
    const num = refNum2(m.ref);
    const last = merged[merged.length - 1];
    if (last && num === last.startNum + last.count) {
      last.endRef = m.ref;
      last.count += 1;
      last.tokens += m.tokens;
    } else {
      merged.push({ startRef: m.ref, endRef: m.ref, startNum: num, count: 1, tokens: m.tokens, tool: m.tool });
    }
  }
  for (const r of merged.slice(0, 30)) {
    const range = r.count === 1 ? r.startRef : `${r.startRef}\u2013${r.endRef}`;
    lines.push(`  ${range}  (${r.count} msgs, ${formatTokens2(r.tokens)}${r.count > 1 ? ` (${Math.round(r.tokens / r.count)}/msg)` : ""}) ${r.tool}`);
  }
  if (merged.length > 30) {
    lines.push(`  ... and ${merged.length - 30} more ranges`);
  }
  return lines.join("\n");
}
function renderMessageDrilldown(visible, toolFilter, sort, limit) {
  let filtered = visible;
  if (toolFilter) filtered = filtered.filter((m) => m.tool === toolFilter);
  if (sort === "time") filtered.sort((a, b) => a.index - b.index);
  else if (sort === "tool") filtered.sort((a, b) => a.tool.localeCompare(b.tool) || b.tokens - a.tokens);
  else filtered.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = filtered.reduce((s, m) => s + m.tokens, 0);
  const allTokens = visible.reduce((s, m) => s + m.tokens, 0);
  const header = toolFilter ? `UNCOMPRESSED \u2014 ${toolFilter}: ${formatTokens2(totalTokens)} | ${filtered.length} msgs | ${pct(totalTokens, allTokens)}% of visible` : `UNCOMPRESSED \u2014 ${formatTokens2(totalTokens)} | ${filtered.length} msgs`;
  const lines = [header, `Sorted by ${sort}`, ""];
  const shown = filtered.slice(0, limit);
  for (const message of shown) {
    lines.push(`  ${message.ref} (${formatTokens2(message.tokens)}) ${message.tool}`);
  }
  if (filtered.length > shown.length) {
    lines.push("");
    lines.push(`${shown.length} of ${filtered.length} shown.`);
  }
  return lines.join("\n");
}
function renderCompressedDrilldown(blocks, state, sort, limit, countTokens) {
  let sorted = [...blocks];
  if (sort === "time") sorted.sort((a, b) => a.createdAt - b.createdAt);
  else if (sort === "age") sorted.sort((a, b) => b.survivedCount - a.survivedCount);
  else
    sorted.sort(
      (a, b) => effectiveCompressedTokens(b, state, countTokens) - effectiveCompressedTokens(a, state, countTokens) || b.createdAt - a.createdAt
    );
  const totalSummary = sorted.reduce((s, b) => s + summaryTokensOf(b, countTokens), 0);
  const totalEffective = sorted.reduce(
    (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
    0
  );
  const lines = [
    `COMPRESSED \u2014 ${sorted.length} blocks | ${formatTokens2(totalEffective)} original \u2192 ${formatTokens2(totalSummary)} summary`
  ];
  const breakdown = tierBreakdown(sorted, countTokens);
  if (breakdown) lines.push(`Tier usage: ${breakdown}`);
  lines.push("");
  const shown = sorted.slice(0, limit);
  for (const block of shown) {
    const nested = block.directBlockIds.length > 0 ? ` nested=[${block.directBlockIds.join(",")}]` : "";
    const topic = block.topic ?? "(no topic)";
    const eff = effectiveCompressedTokens(block, state, countTokens);
    lines.push(
      `  ${block.blockId} (${tierLabel(block)})  ${formatTokens2(eff)}\u2192${formatTokens2(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  age=${block.survivedCount} ${block.generation}${nested}`
    );
    lines.push(`    "${topic}"`);
  }
  if (sorted.length > shown.length) {
    lines.push("");
    lines.push(`${shown.length} of ${sorted.length} shown.`);
  }
  return lines.join("\n");
}
var substringAlgorithm = {
  name: "substring",
  description: "Exact substring counting (original baseline). Predictable, no normalization.",
  score(docs, query) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    return docs.map((d) => {
      const haystack = d.text.toLowerCase();
      let score = 0;
      for (const term of terms) score += countOccurrences2(haystack, term);
      return { ref: d.ref, score };
    });
  }
};
function countOccurrences2(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes")) w = w.slice(0, -2);
  else if (w.endsWith("ches") || w.endsWith("shes")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("ation") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("tion") && w.length > 5) w = w.slice(0, -4) + "t";
  else if (w.endsWith("ion") && w.length > 4) w = w.slice(0, -3);
  if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  return w;
}
var CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
var CJK_RUN = new RegExp(`${CJK.source}+`, "g");
var LATIN_WORD = /[a-z][a-z0-9_]*[a-z0-9]|[a-z0-9]/g;
function tokenize(text, opts = {}) {
  const lower = text.toLowerCase();
  const tokens = [];
  const latin = lower.match(LATIN_WORD) ?? [];
  for (let w of latin) {
    if (w.length >= 2) {
      if (opts.stem) w = stem(w);
      tokens.push(w);
    }
  }
  const cjkRuns = lower.match(CJK_RUN) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
      for (const ch of run) tokens.push(ch);
    }
  }
  return tokens;
}
function charBigrams(text) {
  const grams = [];
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair.trim().length === pair.length) grams.push(pair);
  }
  return grams;
}
function tfMap(text, stem2) {
  const m = /* @__PURE__ */ new Map();
  for (const t of tokenize(text, { stem: stem2 })) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
var bm25Algorithm = {
  name: "bm25",
  description: "BM25 with stemming + CJK bigram tokenization. IR-standard relevance ranking.",
  score(docs, query) {
    const N = docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const parsed = docs.map((d) => {
      const text = d.text;
      const tf = tfMap(text, true);
      let len = 0;
      for (const v of tf.values()) len += v;
      return { id: d.ref, tf, len };
    });
    const avgdl = parsed.reduce((s, d) => s + d.len, 0) / (N || 1);
    const qTerms = tokenize(query, { stem: true });
    if (qTerms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    const idf = /* @__PURE__ */ new Map();
    for (const t of new Set(qTerms)) {
      let df = 0;
      for (const d of parsed) if (d.tf.has(t)) df++;
      idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
    return parsed.map((d) => {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t) ?? 0;
        if (f === 0) continue;
        const idfT = idf.get(t) ?? 0;
        score += idfT * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (avgdl || 1)));
      }
      return { ref: d.id, score };
    });
  }
};
var fuzzyAlgorithm = {
  name: "fuzzy",
  description: "Character bigram overlap. Typo-tolerant, script-agnostic, high recall.",
  score(docs, query) {
    const qTokens = query.toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 4);
    if (qTokens.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    const qGrams = /* @__PURE__ */ new Set();
    for (const t of qTokens) for (const g of charBigrams(t)) qGrams.add(g);
    if (qGrams.size === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    return docs.map((d) => {
      const haystack = d.text.toLowerCase();
      const docGrams = new Set(charBigrams(haystack));
      let hits = 0;
      for (const g of qGrams) if (docGrams.has(g)) hits++;
      return { ref: d.ref, score: hits / qGrams.size };
    });
  }
};
var W_BM25 = 0.7;
var W_FUZZY = 0.3;
var hybridAlgorithm = {
  name: "hybrid",
  description: "Weighted BM25(stem) + fuzzy n-gram. Default \u2014 best precision + recall.",
  score(docs, query) {
    const bm = bm25Algorithm.score(docs, query);
    const fz = fuzzyAlgorithm.score(docs, query);
    const maxBm = Math.max(...bm.map((r) => r.score), 1e-9);
    const maxFz = Math.max(...fz.map((r) => r.score), 1e-9);
    const bmMap = new Map(bm.map((r) => [r.ref, r.score / maxBm]));
    const fzMap = new Map(fz.map((r) => [r.ref, r.score / maxFz]));
    return docs.map((d) => ({
      ref: d.ref,
      score: W_BM25 * (bmMap.get(d.ref) ?? 0) + W_FUZZY * (fzMap.get(d.ref) ?? 0)
    }));
  }
};
var registry2 = /* @__PURE__ */ new Map();
function registerSearchAlgorithm(algo) {
  registry2.set(algo.name, algo);
}
function getSearchAlgorithm(name) {
  return registry2.get(name);
}
registerSearchAlgorithm(substringAlgorithm);
registerSearchAlgorithm(bm25Algorithm);
registerSearchAlgorithm(fuzzyAlgorithm);
registerSearchAlgorithm(hybridAlgorithm);
var DEFAULT_ROLE_WEIGHTS = {
  user: 1.5,
  assistant: 1,
  tool: 0.6,
  block: 1
};
var DEFAULT_ALGORITHM = "hybrid";
function blockDocs(state) {
  return state.blocks.map((b) => ({
    kind: "block",
    ref: b.blockId,
    text: `${b.topic ?? ""} ${b.summary ?? ""}`,
    title: b.topic ?? b.blockId,
    blockId: b.blockId,
    tier: b.tier ?? 1,
    tokens: b.compressedTokens
  }));
}
function messageDocs(msgs) {
  return msgs.map((m) => ({
    kind: "message",
    ref: m.ref,
    text: m.text,
    title: `${m.role}: ${m.text.slice(0, 60)}`,
    role: m.role,
    blockId: m.blockId,
    tier: m.tier,
    tokens: m.tokens
  }));
}
function applyRoleWeight(scored, docs, rw) {
  if (docs.length === 0) return scored;
  const docByRef = new Map(docs.map((d) => [d.ref, d]));
  return scored.map((s) => {
    const doc = docByRef.get(s.ref);
    if (!doc) return s;
    const w = doc.kind === "message" ? doc.role === "user" ? rw.user : doc.role === "assistant" ? rw.assistant : rw.tool : rw.block;
    return { ref: s.ref, score: s.score * w };
  });
}
function runSearch(docs, query, options) {
  const limit = options.limit ?? 10;
  const previewLength = options.previewLength ?? 200;
  const minScore = options.minScore ?? 0.01;
  const algoName = options.algorithm ?? DEFAULT_ALGORITHM;
  const rw = { ...DEFAULT_ROLE_WEIGHTS, ...options.roleWeights };
  const algo = getSearchAlgorithm(algoName);
  if (!algo) return [];
  if (docs.length === 0) return [];
  const scoredOrPromise = algo.score(docs, query);
  const buildResults = (weighted) => {
    const byRef = new Map(docs.map((d) => [d.ref, d]));
    return weighted.map((s) => {
      const doc = byRef.get(s.ref);
      if (!doc) return null;
      return {
        kind: doc.kind,
        ref: doc.ref,
        blockId: doc.blockId,
        tier: doc.tier ?? 1,
        score: s.score,
        title: doc.title,
        preview: makePreview(doc.text, query, previewLength),
        role: doc.role,
        tokens: doc.tokens
      };
    }).filter((r) => r !== null && r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, limit);
  };
  if (scoredOrPromise instanceof Promise) {
    return scoredOrPromise.then((raw) => buildResults(applyRoleWeight(raw, docs, rw)));
  }
  return buildResults(applyRoleWeight(scoredOrPromise, docs, rw));
}
function searchBlocks(docs, query, options = {}) {
  const result = runSearch(docs, query, options);
  if (result instanceof Promise) {
    throw new Error(
      `searchBlocks: algorithm "${options.algorithm ?? DEFAULT_ALGORITHM}" is async (e.g. semantic). Use searchBlocksAsync() instead.`
    );
  }
  return result;
}
function makePreview(text, query, len) {
  if (!text) return "";
  const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return text.slice(0, len);
  const lower = text.toLowerCase();
  let hitIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      hitIdx = idx;
      break;
    }
  }
  if (hitIdx < 0) return text.slice(0, len);
  const half = Math.max(0, Math.floor(len / 2) - 10);
  const start = Math.max(0, hitIdx - half);
  const end = Math.min(text.length, start + len);
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < text.length ? "\u2026" : "";
  return prefix + text.slice(start, end).trim() + suffix;
}

// src/state.ts
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
var STATE_DIR = process.env.BILI_ACP_STATE_DIR || path.join(os.homedir(), ".cache", "opencode-bili-acp");
function stateFileFor(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.acp.json`);
}
var MAX_CACHED_STATES = 32;
var SessionStateStore = class {
  cache = /* @__PURE__ */ new Map();
  async load(sessionId) {
    const hit = this.cache.get(sessionId);
    if (hit) {
      this.bump(sessionId, hit);
      return hit;
    }
    let state = createInitialState();
    try {
      const raw = await fs.readFile(stateFileFor(sessionId), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.blocks)) state = mergeInitialState(parsed);
    } catch {
    }
    this.bump(sessionId, state);
    return state;
  }
  async save(state, sessionId) {
    this.bump(sessionId, state);
    const file = stateFileFor(sessionId);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch(() => {
    });
    const tmp = path.join(dir, `.bili-tmp-${sessionId}-${process.pid}`);
    await fs.writeFile(tmp, JSON.stringify(state), "utf8");
    await fs.rename(tmp, file);
  }
  /** Insert (or refresh) a cache entry and evict the least-recently-used entry
   *  if over cap. `delete` before `set` reorders Map insertion order so
   *  `keys()` yields entries oldest-first — that's what makes LRU eviction
   *  correct. Only the in-memory cache is dropped on eviction; disk state in
   *  ~/.cache/opencode-bili-acp is untouched and reloaded on next load(). */
  bump(sessionId, state) {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, state);
    while (this.cache.size > MAX_CACHED_STATES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === void 0) break;
      this.cache.delete(oldest);
    }
  }
  invalidate(sessionId) {
    if (sessionId) this.cache.delete(sessionId);
    else this.cache.clear();
  }
};
function mergeInitialState(parsed) {
  const fresh = createInitialState();
  const safeNextBlockId = typeof parsed.nextBlockId === "number" && Number.isFinite(parsed.nextBlockId) && parsed.nextBlockId > fresh.nextBlockId ? parsed.nextBlockId : fresh.nextBlockId;
  const safeNextRunId = typeof parsed.nextRunId === "number" && Number.isFinite(parsed.nextRunId) && parsed.nextRunId > fresh.nextRunId ? parsed.nextRunId : fresh.nextRunId;
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...parsed.nudge ?? {} },
    stats: { ...fresh.stats, ...parsed.stats ?? {} },
    nextBlockId: safeNextBlockId,
    nextRunId: safeNextRunId
  };
}

// src/config.ts
var FALLBACK_LIMIT = 2e5;
function envInt(name) {
  const raw = process.env[name];
  if (!raw) return void 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : void 0;
}
function resolveConfig(adapter, liveLimit) {
  const modelContextLimit = adapter.modelContextLimit ?? envInt("BILI_MODEL_CONTEXT_LIMIT") ?? envInt("ACP_MODEL_CONTEXT_LIMIT") ?? (liveLimit && liveLimit > 0 ? liveLimit : void 0) ?? FALLBACK_LIMIT;
  const protectedTools = adapter.protectedTools ?? [];
  const preserveRecentMessages = adapter.preserveRecentMessages ?? 5;
  const kernel = defaultConfig(modelContextLimit, {
    protectedTools,
    preserveRecentMessages,
    ...adapter.coreOverrides
  });
  return {
    kernel,
    modelContextLimit,
    protectedTools,
    preserveRecentMessages
  };
}

// src/log.ts
var DEBUG = Boolean(process.env.BILI_ACP_DEBUG || process.env.ACP_DEBUG);
function ts() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
}
function debug(...args) {
  if (!DEBUG) return;
  console.error(`[bili-acp ${ts()}]`, ...args);
}
function warn(...args) {
  console.error(`[bili-acp ${ts()}] WARN`, ...args);
}

// src/runtime.ts
var MAX_SESSIONS_IN_MEMORY = 32;
var AcpRuntime = class {
  core = createCore();
  store = new SessionStateStore();
  adapter;
  locks = /* @__PURE__ */ new Map();
  cores = /* @__PURE__ */ new Map();
  modelLimits = /* @__PURE__ */ new Map();
  turnCache = /* @__PURE__ */ new Map();
  /** Resolved config cache keyed by live model limit. `this.adapter` is fixed
   *  after plugin init, so the only varying input is the per-session model
   *  context limit — cache on it so the hot transform/status paths don't
   *  rebuild (and reallocate) the whole kernel config on every call. */
  configCache = /* @__PURE__ */ new Map();
  constructor(adapter) {
    this.adapter = adapter;
  }
  configFor(liveLimit) {
    const key = liveLimit && liveLimit > 0 ? liveLimit : 0;
    const hit = this.configCache.get(key);
    if (hit) return hit;
    const resolved = resolveConfig(this.adapter, key > 0 ? key : void 0);
    this.configCache.set(key, resolved);
    return resolved;
  }
  async stateFor(sessionId) {
    return this.store.load(sessionId);
  }
  async save(state, sessionId) {
    await this.store.save(state, sessionId);
  }
  /** Cache a processTurn result so acp_status can reuse it instead of
   *  recomputing the full pipeline. Only valid until the next save/cores change. */
  cacheTurn(sessionId, state, cores, tokenCount, result) {
    this.turnCache.set(sessionId, { state, cores, tokenCount, result });
  }
  /** Return a cached processTurn result if it is still fresh (same cores array
   *  reference + same state reference + same tokenCount). acp_status uses this
   *  to avoid recomputing the pipeline on every call. Returns undefined if stale. */
  getCachedTurn(sessionId, state, cores, tokenCount) {
    const entry = this.turnCache.get(sessionId);
    if (!entry) return void 0;
    if (entry.state !== state || entry.cores !== cores || entry.tokenCount !== tokenCount) return void 0;
    return entry.result;
  }
  /** Serialize async work per session. `fn` runs only after all previously
   *  queued work for `sessionId` has settled (success OR failure — failures
   *  don't block the chain).
   *
   *  Contract: the returned promise REJECTS if `fn` rejects. Callers MUST
   *  attach a .catch() (or await in a try/catch) — the stored chain is
   *  suppressed internally so it never surfaces as an unhandled rejection,
   *  but the caller-observed promise is the raw `next` and will throw.
   *  All current callers (messages.transform hook, the four acp_ tools)
   *  catch it. */
  acquireLock(sessionId, fn) {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const stored = next.catch(() => {
    });
    this.locks.set(sessionId, stored);
    stored.then(() => {
      if (this.locks.get(sessionId) === stored) this.locks.delete(sessionId);
    });
    return next;
  }
  setCores(sessionId, cores) {
    this.touch(sessionId);
    this.turnCache.delete(sessionId);
    this.cores.set(sessionId, cores);
  }
  getCores(sessionId) {
    return this.cores.get(sessionId);
  }
  setModelLimit(sessionId, limit) {
    this.touch(sessionId);
    this.modelLimits.set(sessionId, limit);
  }
  getModelLimit(sessionId) {
    return this.modelLimits.get(sessionId);
  }
  /** Drop all in-memory state for a session. Persistent state on disk is
   *  untouched. Safe to call repeatedly.
   *
   *  NOTE: not currently wired to any opencode lifecycle event — opencode's
   *  plugin API exposes no stable session-end signal as of v1.14. In-memory
   *  release therefore relies on the LRU cap in `touch()` (MAX_SESSIONS_IN_MEMORY).
   *  This method exists so a future session-end hook can call it directly. */
  dropSession(sessionId) {
    this.cores.delete(sessionId);
    this.modelLimits.delete(sessionId);
    this.locks.delete(sessionId);
    this.turnCache.delete(sessionId);
    this.store.invalidate(sessionId);
    debug("drop-session", { sid: sessionId });
  }
  /** Drop all in-memory state (plugin unload / reload). Disk state is kept. */
  dropAll() {
    this.cores.clear();
    this.modelLimits.clear();
    this.locks.clear();
    this.turnCache.clear();
    this.store.invalidate();
  }
  /** Mark a session as recently used (moves it to the end of insertion order)
   *  and evict the oldest session if we've exceeded the cap. */
  touch(sessionId) {
    const c = this.cores.get(sessionId);
    if (c !== void 0) {
      this.cores.delete(sessionId);
      this.cores.set(sessionId, c);
    }
    const m = this.modelLimits.get(sessionId);
    if (m !== void 0) {
      this.modelLimits.delete(sessionId);
      this.modelLimits.set(sessionId, m);
    }
    while (this.cores.size > MAX_SESSIONS_IN_MEMORY) {
      const oldest = this.cores.keys().next().value;
      if (oldest === void 0) break;
      debug("evict-session", { sid: oldest, size: this.cores.size });
      this.cores.delete(oldest);
      this.modelLimits.delete(oldest);
      this.turnCache.delete(oldest);
    }
  }
};

// src/messages.ts
function messageBaseId(m, index) {
  if (typeof m.id === "string" && m.id) return m.id;
  return `__msg${index}`;
}
function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function resultValueToText(result) {
  if (!result || typeof result !== "object") return "";
  const value = result.value;
  switch (result.type) {
    case "error":
      return `Error: ${safeStringify(value)}`;
    case "json":
      return safeStringify(value);
    case "content":
      if (Array.isArray(value)) {
        return value.map((c) => {
          if (c && typeof c === "object" && c.type === "file") {
            const f = c;
            return `[file ${f.uri ?? ""} (${f.mime ?? ""})]`;
          }
          const t = c;
          return typeof t.text === "string" ? t.text : "";
        }).join("\n");
      }
      return safeStringify(value);
    default:
      return safeStringify(value);
  }
}
function v2ToCoreMessages(msgs) {
  const cores = [];
  const origin = /* @__PURE__ */ new Map();
  const partToCoreIds = /* @__PURE__ */ new Map();
  msgs.forEach((msg, mi) => {
    const base = messageBaseId(msg, mi);
    const parts = Array.isArray(msg.content) ? msg.content : [];
    parts.forEach((part, pi) => {
      const key = `${mi}:${pi}`;
      if (part.type === "text") {
        const id = `${base}#t${pi}`;
        cores.push({ id, role: msg.role === "assistant" ? "assistant" : "user", contentType: "text", text: part.text ?? "" });
        origin.set(id, { mi, pi });
        partToCoreIds.set(key, [id]);
      } else if (part.type === "reasoning") {
        const id = `${base}#r${pi}`;
        cores.push({ id, role: "assistant", contentType: "reasoning", text: part.text ?? "" });
        origin.set(id, { mi, pi });
        partToCoreIds.set(key, [id]);
      } else if (part.type === "tool-call" && typeof part.id === "string") {
        const callId = `${part.id}#call`;
        const resultId = `${part.id}#result`;
        cores.push({
          id: callId,
          role: "assistant",
          contentType: "tool-call",
          toolName: part.name,
          toolCallId: part.id,
          text: safeStringify(part.input)
        });
        origin.set(callId, { mi, pi });
        partToCoreIds.set(key, [callId, resultId]);
      } else if (part.type === "tool-result" && typeof part.id === "string") {
        const id = `${part.id}#result`;
        cores.push({
          id,
          role: "tool",
          contentType: "tool-result",
          toolName: part.name,
          toolCallId: part.id,
          text: resultValueToText(part.result)
        });
        origin.set(id, { mi, pi });
        partToCoreIds.set(key, [id]);
      }
    });
  });
  return { cores, origin, partToCoreIds };
}
function hasCompressiblePart(msg) {
  const parts = Array.isArray(msg.content) ? msg.content : [];
  return parts.some((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool-call" || p.type === "tool-result");
}
function syntheticMessage(core) {
  const text = core.text ?? "";
  if (core.id.startsWith("acp_summary_")) {
    return {
      id: `bili_summary_${core.id.replace("acp_summary_", "")}`,
      role: "user",
      content: [{ type: "text", text }]
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text }]
  };
}
function partSurvives(part, coreIds, outById) {
  if (!coreIds || coreIds.length === 0) return true;
  if (part.type === "tool-call") {
    return coreIds.every((id) => outById.has(id));
  }
  if (part.type === "tool-result" && typeof part.id === "string") {
    return outById.has(`${part.id}#call`) && outById.has(`${part.id}#result`);
  }
  return coreIds.some((id) => outById.has(id));
}
function reassemble(outputCores, inputMsgs, conversion, sessionID) {
  const { origin, partToCoreIds } = conversion;
  const outById = new Map(outputCores.map((c) => [c.id, c]));
  const result = [];
  const emitted = /* @__PURE__ */ new Set();
  let cursor = 0;
  const emitMessage = (mi) => {
    if (mi < 0 || mi >= inputMsgs.length || emitted.has(mi)) return;
    emitted.add(mi);
    const orig = inputMsgs[mi];
    const parts = [];
    const srcParts = Array.isArray(orig.content) ? orig.content : [];
    for (let pi = 0; pi < srcParts.length; pi++) {
      const part = srcParts[pi];
      const coreIds = partToCoreIds.get(`${mi}:${pi}`);
      if (!coreIds || partSurvives(part, coreIds, outById)) {
        if (part.type === "text" && coreIds && coreIds.length > 0) {
          const tagged = outById.get(coreIds[0]);
          parts.push(tagged ? { ...part, text: tagged.text ?? part.text } : part);
        } else {
          parts.push(part);
        }
      }
    }
    if (parts.length > 0) result.push({ ...orig, content: parts });
  };
  for (const core of outputCores) {
    const ref = origin.get(core.id);
    if (ref === void 0) {
      result.push(syntheticMessage(core));
      continue;
    }
    while (cursor < ref.mi) {
      if (!emitted.has(cursor) && !hasCompressiblePart(inputMsgs[cursor])) emitMessage(cursor);
      cursor++;
    }
    if (cursor === ref.mi) cursor++;
    emitMessage(ref.mi);
  }
  while (cursor < inputMsgs.length) {
    if (!emitted.has(cursor) && !hasCompressiblePart(inputMsgs[cursor])) emitMessage(cursor);
    cursor++;
  }
  debug("reassemble", { sid: sessionID, inMsgs: inputMsgs.length, outMsgs: result.length, kept: emitted.size });
  return result;
}
function makeNudgeMessage(id, sessionID, text) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }]
  };
}

// src/tokens.ts
var COMPRESS_TOOL_NAMES = /* @__PURE__ */ new Set(["acp_compress"]);
function estimateTokens(messages, coveredIds) {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName && COMPRESS_TOOL_NAMES.has(m.toolName)) continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += defaultCountTokens(m.text ?? "");
  }
  return tokens;
}

// src/compress-tool.ts
function formatK2(n) {
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
}
var rangeShape = {
  type: "object",
  properties: {
    startId: { type: "string", description: 'Message ref, e.g. "m00005" (from the bili tag), or a block id "b3".' },
    endId: { type: "string", description: "Inclusive end ref. Must be at or after startId." },
    summary: { type: "string", description: "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, signatures, decisions, exact values)." },
    topic: { type: "string", description: "Short label (3-5 words) for THIS range. Omit to use top-level topic." }
  },
  required: ["startId", "endId", "summary"]
};
function makeCompressTool(runtime) {
  return {
    name: "acp_compress",
    description: "Replace older conversation ranges with detailed summaries you write. Single range: acp_compress({ content: [{ startId, endId, summary }] }). Batch multiple ranges: acp_compress({ content: [{ topic, startId, endId, summary }, ...] }) \u2014 each entry gets its own block.",
    input: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Fallback topic for entries without their own." },
        content: {
          type: "array",
          items: rangeShape,
          description: "One or more ranges to compress, each with start/end boundaries and a summary."
        },
        summaryMaxChars: { type: "number", description: "Override max summary length (default 20000). Use when content needs more detail." }
      },
      required: ["content"]
    },
    async execute(args, ctx) {
      const ranges = Array.isArray(args.content) ? args.content : [];
      if (ranges.length === 0) return { content: "No ranges provided." };
      return runtime.acquireLock(ctx.sessionID, () => handleCompress(args, runtime, ctx));
    }
  };
}
async function handleCompress(args, runtime, ctx) {
  const ranges = Array.isArray(args.content) ? args.content : [];
  const state = await runtime.stateFor(ctx.sessionID);
  const cores = runtime.getCores(ctx.sessionID) ?? [];
  const resolved = runtime.configFor(runtime.getModelLimit(ctx.sessionID) ?? 0);
  const beforeTokens = estimateTokens(cores, coveredMessageIds(state));
  const summaryMaxChars = typeof args.summaryMaxChars === "number" ? args.summaryMaxChars : void 0;
  const topLevelTopic = typeof args.topic === "string" ? args.topic : void 0;
  debug("compress-in", {
    sid: ctx.sessionID,
    ranges: ranges.length,
    spans: ranges.map((r) => `${r.startId}..${r.endId}`),
    blocksBefore: state.blocks.length,
    beforeTokens
  });
  const applied = runtime.core.applyCompression({
    ranges: ranges.map((r) => ({
      startRef: r.startId,
      endRef: r.endId,
      summary: r.summary,
      topic: r.topic ?? topLevelTopic,
      summaryMaxChars,
      compressCallId: ctx.id ?? ctx.messageID
    })),
    messages: cores,
    state,
    config: resolved.kernel
  });
  await runtime.save(applied.state, ctx.sessionID);
  const { blocksCreated, tokensCompressed, errors, warnings } = applied.result;
  const afterTokens = Math.max(0, beforeTokens - tokensCompressed);
  debug("compress-out", { sid: ctx.sessionID, blocksCreated, tokensCompressed, beforeTokens, afterTokens, errors: errors.length });
  const lines = [`bili ACP | ${formatK2(beforeTokens)} \u2192 ${formatK2(afterTokens)} tokens (~${formatK2(tokensCompressed)} reclaimed, ${blocksCreated} block${blocksCreated > 1 ? "s" : ""})`];
  if (warnings.length > 0) lines.push("\u26A0\uFE0F " + warnings.join("; "));
  if (errors.length > 0) lines.push("Errors: " + errors.join("; "));
  return { content: lines.join("\n") };
}

// src/decompress-tool.ts
import { writeFile, mkdir } from "fs/promises";
import { resolve, relative, isAbsolute, join as join2 } from "path";
import { tmpdir, homedir as homedir2 } from "os";
import { randomUUID } from "crypto";
var AUTO_DIR = join2(homedir2() || tmpdir(), ".cache", "opencode-bili-acp", "decompress");
var PREVIEW_CHARS = 600;
var MESSAGE_INLINE_THRESHOLD = 2e3;
var ALLOWED_DIRS = [
  tmpdir(),
  join2(homedir2(), ".cache", "opencode"),
  join2(homedir2(), ".cache", "opencode-bili-acp")
];
function resolveToFilePath(targetPath) {
  const expanded = targetPath.startsWith("~/") ? join2(homedir2(), targetPath.slice(2)) : targetPath;
  const resolved = resolve(expanded);
  const isAllowed = ALLOWED_DIRS.some((dir) => {
    const rel = relative(dir, resolved);
    return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!isAllowed) {
    return { error: `Error: toFile path must be under ${tmpdir()}, ~/.cache/opencode, or ~/.cache/opencode-bili-acp. Got: ${targetPath}` };
  }
  return resolved;
}
function autoFilePath(blockId) {
  return join2(AUTO_DIR, `${blockId}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
}
function headPreview(text) {
  if (text.length <= PREVIEW_CHARS) return text;
  return text.slice(0, PREVIEW_CHARS) + "\n\n... (truncated; use read tool for full content)";
}
function findMessageContent(ref, cores) {
  for (const cm of cores) {
    if (cm.id === ref) return { text: cm.text ?? "", role: cm.role };
  }
  return null;
}
function makeDecompressTool(runtime) {
  return {
    name: "acp_decompress",
    description: 'Restore a previously compressed block, or a single message by its ref. The block/message stays compressed \u2014 context is not disrupted. BLOCK decompress (blockId "b5") defaults to writing a file; use inline:true to return inline. MESSAGE decompress (blockId = a message ref from acp_search results) returns that ONE message original text, default inline. full:true recurses through nested tiers (block mode only).',
    input: {
      type: "object",
      properties: {
        blockId: { type: "string", description: 'Block id to restore, e.g. "b5". Also accepts a message ref from acp_search results \u2014 resolves to the owning block automatically.' },
        full: { type: "boolean", description: "Recurse through all nested blocks to original messages. Default: false (one tier up)." },
        toFile: { type: "string", description: "Write restored content to this path (must be under /tmp, ~/.cache/opencode, or ~/.cache/opencode-bili-acp)." },
        inline: { type: "boolean", description: "Return content inline as this tool result. Default: false for blocks (file), true for single messages." }
      }
    },
    async execute(args, ctx) {
      return runtime.acquireLock(ctx.sessionID, () => handleDecompress(args, runtime, ctx));
    }
  };
}
async function handleDecompress(args, runtime, ctx) {
  const state = await runtime.stateFor(ctx.sessionID);
  const cores = runtime.getCores(ctx.sessionID) ?? [];
  const arg = String(args.blockId ?? "").trim();
  if (!arg) return { content: "Error: blockId is required." };
  const owner = state.blocks.find((b) => b.effectiveMessageIds.includes(arg));
  if (owner) return { content: await handleMessageRef(arg, owner.blockId, args, cores) };
  const blockId = parseBlockIdArg(arg);
  if (!blockId) return { content: `Invalid blockId: ${args.blockId}. Expected format like "b5", "5", or a message ref from acp_search results.` };
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block) {
    const active = state.blocks.filter((b) => b.active).map((b) => b.blockId).join(", ");
    return { content: `Block ${blockId} not found. Active blocks: ${active || "(none)"}.` };
  }
  const full = args.full === true;
  const { text, count } = collectBlockContent(state, block, cores, { full });
  if (count === 0) return { content: `Block ${blockId} has no restorable message content.` };
  if (args.inline === true && args.toFile === void 0) {
    debug("decompress", { blockId, full, count, mode: "inline" });
    return { content: `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}) inline:

${text}` };
  }
  const targetPath = args.toFile !== void 0 ? resolveToFilePath(String(args.toFile)) : autoFilePath(blockId);
  if (typeof targetPath === "object" && "error" in targetPath) return { content: targetPath.error };
  await mkdir(AUTO_DIR, { recursive: true }).catch(() => {
  });
  await writeFile(targetPath, text, "utf8");
  debug("decompress", { blockId, full, count, mode: "file", path: targetPath, chars: text.length });
  const itemWord = count === 1 ? "item" : "items";
  return {
    content: [
      `Block ${blockId} (${count} ${itemWord}, ${text.length} chars) written to ${targetPath}.`,
      "Block stays compressed \u2014 context unchanged. Use the read tool to access the content.",
      "",
      "Preview:",
      headPreview(text)
    ].join("\n")
  };
}
async function handleMessageRef(ref, ownerBlockId, args, cores) {
  const found = findMessageContent(ref, cores);
  if (!found || !found.text) {
    return `Message ${ref} (in block ${ownerBlockId}) has no restorable text content.`;
  }
  const { text, role } = found;
  const wantFile = args.toFile !== void 0 || args.inline === false || text.length >= MESSAGE_INLINE_THRESHOLD;
  if (!wantFile) {
    debug("decompress-message", { ref, ownerBlockId, mode: "inline", chars: text.length });
    return `Message ${ref} (${role}, block ${ownerBlockId}, ${text.length} chars) restored inline:

${text}`;
  }
  const targetPath = args.toFile !== void 0 ? resolveToFilePath(String(args.toFile)) : autoFilePath(`msg-${ref}`);
  if (typeof targetPath === "object" && "error" in targetPath) return targetPath.error;
  await mkdir(AUTO_DIR, { recursive: true }).catch(() => {
  });
  await writeFile(targetPath, text, "utf8");
  debug("decompress-message", { ref, ownerBlockId, mode: "file", chars: text.length });
  return [
    `Message ${ref} (${role}, block ${ownerBlockId}, ${text.length} chars) written to ${targetPath}.`,
    "Block stays compressed \u2014 context unchanged. Use the read tool to access the content.",
    "",
    "Preview:",
    headPreview(text)
  ].join("\n");
}

// src/search-index.ts
function buildMessageOwnerMap(state) {
  const m = /* @__PURE__ */ new Map();
  for (const b of state.blocks) {
    for (const id of b.effectiveMessageIds) {
      if (!m.has(id)) m.set(id, b.blockId);
    }
  }
  return m;
}
function buildSearchCoveredRefs(state) {
  const s = /* @__PURE__ */ new Set();
  for (const b of state.blocks) for (const id of b.effectiveMessageIds) s.add(id);
  return s;
}
function toRole(cm) {
  if (cm.role === "user") return "user";
  if (cm.role === "assistant") return "assistant";
  if (cm.role === "tool") return "tool";
  return null;
}
function buildSearchDocs(state, cores) {
  const covered = buildSearchCoveredRefs(state);
  const ownerMap = buildMessageOwnerMap(state);
  const blockTier = /* @__PURE__ */ new Map();
  for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);
  const msgs = [];
  for (const cm of cores) {
    if (!cm.id) continue;
    const role = toRole(cm);
    if (!role) continue;
    if (!covered.has(cm.id)) continue;
    const text = cm.text ?? "";
    if (!text || text.length < 2) continue;
    const ownerBlock = ownerMap.get(cm.id);
    msgs.push({
      ref: cm.id,
      role,
      text,
      tokens: defaultCountTokens(text),
      blockId: ownerBlock,
      tier: ownerBlock ? blockTier.get(ownerBlock) : void 0
    });
  }
  return [...blockDocs(state), ...messageDocs(msgs)];
}

// src/search-tool.ts
function makeSearchTool(runtime) {
  return {
    name: "acp_search",
    description: "Search compressed blocks AND historical messages by keyword. Use to cheaply locate detail before decompressing. Returns ranked results with ref, size, preview, and the acp_decompress command to retrieve full content.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to locate detail folded into compressed summaries or historical messages." },
        limit: { type: "number", description: "Max results (default 10)." }
      },
      required: ["query"]
    },
    async execute(args, ctx) {
      return runtime.acquireLock(ctx.sessionID, () => handleSearch(args, runtime, ctx));
    }
  };
}
async function handleSearch(args, runtime, ctx) {
  const state = await runtime.stateFor(ctx.sessionID);
  const cores = runtime.getCores(ctx.sessionID) ?? [];
  const docs = buildSearchDocs(state, cores);
  const msgCount = docs.filter((d) => d.kind === "message").length;
  const blockCount = docs.filter((d) => d.kind === "block").length;
  const query = String(args.query ?? "");
  if (!query) return { content: "Error: query is required." };
  const results = searchBlocks(docs, query, { limit: typeof args.limit === "number" ? args.limit : void 0 });
  if (results.length === 0) {
    return { content: `No matches for "${query}" across ${state.blocks.length} block(s) and ${msgCount} historical message(s).` };
  }
  const lines = [`Found ${results.length} match(es) for "${query}" (searched ${blockCount} blocks + ${msgCount} messages):`];
  for (const r of results) lines.push("", formatResult(r));
  return { content: lines.join("\n") };
}
function formatResult(r) {
  const sizeStr = r.tokens != null ? formatSize(r.tokens) : "";
  const meta = [
    r.kind === "message" ? `message ${r.ref}` : `block ${r.ref}`,
    r.role ? `(${r.role})` : "",
    `T${r.tier}`,
    `score:${r.score.toFixed(2)}`,
    sizeStr
  ].filter(Boolean).join(" ");
  const header = `${meta}  "${truncate(r.title, 50)}"`;
  const decompressHint = r.kind === "block" ? `\u2192 acp_decompress({ blockId: "${r.ref}" })` : r.blockId ? `\u2192 acp_decompress({ blockId: "${r.blockId}" })  (block containing message ${r.ref})` : `(message ${r.ref} is still visible in context)`;
  return `${header}
  ${r.preview}
  ${decompressHint}`;
}
function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "\u2026";
}
function formatSize(tokens) {
  if (tokens < 1e3) return `${tokens}tok`;
  if (tokens < 1e6) return `${(tokens / 1e3).toFixed(1)}K`;
  return `${(tokens / 1e6).toFixed(1)}M`;
}

// src/status-tool.ts
function makeStatusTool(runtime) {
  return {
    name: "acp_status",
    description: "Context status: overview, compressed blocks, or uncompressed ranges/messages. No args = overview + totals + compressible ranges. scope:'uncompressed' + view:'messages' for per-message listing. scope:'compressed' for block drilldown.",
    input: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["compressed", "uncompressed"], description: '"compressed" = drill into blocks; "uncompressed" = show visible messages/ranges. Default: overview.' },
        view: { type: "string", enum: ["ranges", "messages"], description: 'For uncompressed scope: "ranges" (default) or "messages".' },
        tool: { type: "string", description: 'Filter by tool name (e.g. "bash", "read"). uncompressed+messages only.' },
        sort: { type: "string", enum: ["size", "time", "tool", "age"], description: "Sort order. Default: size." },
        limit: { type: "number", description: "Max items to show (default 30)." }
      }
    },
    async execute(args, ctx) {
      return runtime.acquireLock(ctx.sessionID, () => handleStatus(args, runtime, ctx));
    }
  };
}
async function handleStatus(args, runtime, ctx) {
  const state = await runtime.stateFor(ctx.sessionID);
  const cores = runtime.getCores(ctx.sessionID) ?? [];
  const resolved = runtime.configFor(runtime.getModelLimit(ctx.sessionID) ?? 0);
  const tokenCount = estimateTokens(cores, coveredMessageIds(state));
  const turn = runtime.getCachedTurn(ctx.sessionID, state, cores, tokenCount) ?? runtime.core.processTurn({
    messages: cores,
    state,
    config: resolved.kernel,
    tokenCount,
    renderTags: "text-only"
  });
  const base = buildStatusReport(turn.state, turn.messages, defaultCountTokens, {
    scope: args.scope,
    view: args.view,
    tool: args.tool,
    sort: args.sort,
    limit: args.limit
  });
  if (args.scope) return { content: base };
  const nudge = turn.nudge;
  const ranges = nudge?.compressibleRanges ?? [];
  const protectedRanges = nudge?.protectedRanges ?? [];
  const extra = [];
  if (nudge) {
    extra.push("");
    extra.push(nudge.shouldInject ? `Nudge: ACTIVE \u2014 ${nudge.reason}` : `Nudge: idle \u2014 ${nudge.reason}`);
  }
  if (ranges.length > 0 || protectedRanges.length > 0) {
    extra.push("");
    extra.push(formatRanges(ranges, protectedRanges));
  }
  return { content: extra.length > 0 ? `${base}
${extra.join("\n")}` : base };
}

// src/system-prompt.ts
var SYSTEM_PROMPT = `${COMPRESS_PHILOSOPHY}

BILI CONTEXT MANAGEMENT (billion-context)

You have four context-management tools. Each message in the conversation carries an acp tag like \`<acp tokens="2" type="text">m00001</acp>\` showing its ref (mNNNNN), approximate token size, and content type. Use these refs to compress ranges.

- acp_compress({ content: [{ startId, endId, summary }] }) \u2014 replace an older conversation range with a detailed summary you write. Batch multiple unrelated ranges, each with its own topic.
- acp_decompress({ blockId }) \u2014 restore a compressed block or a single message ref to inspect exact detail (file contents, errors, signatures). Block stays compressed; output goes to a file by default \u2014 use the read tool to view it.
- acp_search({ query }) \u2014 keyword-search compressed blocks and folded historical messages to locate detail before decompressing.
- acp_status({}) \u2014 context status: usage, compressible ranges, active blocks.

WHEN TO COMPRESS
- Verbose tool output (build/test/logs) once you have the result you need.
- Consumed exploration and duplicate reads.
- Resolved discussion threads; intermediate steps of a completed task.
- A task phase has ended.

WHEN NOT TO COMPRESS
- Content the current step is actively using.
- Important user messages (preserve intent verbatim).

COMPRESSION SUMMARY RULES
Keep verbatim: full file paths with line numbers, function/type signatures and critical code lines, exact error strings, decisions and rationale ("chose X over Y because Z"), exact values/versions, user intent.
Drop: verbose logs once the error/result is captured, duplicate reads, dead-end exploration (but keep the one-line lesson: "tried X, failed because Y").
Each summary must be self-contained so the task can continue without the original.

Compress when acp_status shows compressible ranges or when a nudge is injected. The nudge growth threshold adapts to the model's context limit (clamped to a floor and cap), so smaller-context models get nudged sooner.`;

// src/index.ts
var SYSTEM_MARKER = "BILI CONTEXT MANAGEMENT";
var index_default = {
  id: "billion-context-opencode-v2",
  setup: async (ctx) => {
    const options = ctx.options ?? {};
    const adapter = {
      modelContextLimit: numOpt(options.modelContextLimit),
      protectedTools: strArrayOpt(options.protectedTools),
      preserveRecentMessages: numOpt(options.preserveRecentMessages),
      debug: boolOpt(options.debug),
      coreOverrides: options.coreOverrides
    };
    if (adapter.debug) process.env.BILI_ACP_DEBUG = "1";
    const runtime = new AcpRuntime(adapter);
    const modelLimits = /* @__PURE__ */ new Map();
    const resolveModelLimit = async (model) => {
      if (!model || typeof model.id !== "string" || typeof model.providerID !== "string") return void 0;
      const key = `${model.providerID}/${model.id}`;
      if (modelLimits.has(key)) return modelLimits.get(key);
      let limit;
      try {
        const out = await ctx.catalog.model.list();
        const found = out.data.find((m) => m.id === model.id && m.providerID === model.providerID);
        limit = typeof found?.limit?.context === "number" ? found.limit.context : void 0;
      } catch (err) {
        warn("catalog.model.list failed:", err instanceof Error ? err.message : String(err));
      }
      modelLimits.set(key, limit);
      return limit;
    };
    await ctx.tool.transform((tools) => {
      const opts = { codemode: false, permission: "allow" };
      tools.add({ ...makeCompressTool(runtime), options: opts });
      tools.add({ ...makeDecompressTool(runtime), options: opts });
      tools.add({ ...makeSearchTool(runtime), options: opts });
      tools.add({ ...makeStatusTool(runtime), options: opts });
    });
    await ctx.session.hook("context", async (event) => {
      const sessionID = event.sessionID;
      const msgs = Array.isArray(event.messages) ? event.messages : [];
      if (!sessionID || msgs.length === 0) return;
      try {
        const limit = await resolveModelLimit(event.model);
        if (limit && limit > 0) runtime.setModelLimit(sessionID, limit);
        await runtime.acquireLock(sessionID, () => runPipeline2(msgs, sessionID, runtime, event));
      } catch (err) {
        warn("context hook failed:", err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      runtime.dropAll();
    };
  }
};
async function runPipeline2(msgs, sessionID, runtime, event) {
  const conversion = v2ToCoreMessages(msgs);
  const { cores } = conversion;
  const state = await runtime.stateFor(sessionID);
  const coveredIds = coveredMessageIds(state);
  const tokenCount = estimateTokens(cores, coveredIds);
  const resolved = runtime.configFor(runtime.getModelLimit(sessionID));
  debug("transform-in", { sid: sessionID, msgs: msgs.length, cores: cores.length, tokens: tokenCount, limit: resolved.modelContextLimit, blocks: state.blocks.length });
  const turn = runtime.core.processTurn({
    messages: cores,
    state,
    config: resolved.kernel,
    tokenCount,
    renderTags: "text-only"
  });
  runtime.setCores(sessionID, cores);
  runtime.cacheTurn(sessionID, turn.state, cores, tokenCount, turn);
  await runtime.save(turn.state, sessionID);
  const reassembled = reassemble(turn.messages, msgs, conversion, sessionID);
  if (turn.nudge && turn.nudge.shouldInject) {
    const rendered = renderNudgeText(turn.nudge);
    const text = [rendered.voice ? `[${rendered.voice}]` : "", rendered.text].filter(Boolean).join("\n");
    reassembled.push(makeNudgeMessage(`bili_nudge_${turn.nudge.tier ?? 0}_${Date.now()}`, sessionID, text));
    debug("nudge-injected", { sid: sessionID, tier: turn.nudge.tier, reason: turn.nudge.reason });
  }
  msgs.splice(0, msgs.length, ...reassembled);
  const system = event.system;
  if (Array.isArray(system)) {
    const idx = system.findIndex((p) => p.type === "text" && p.text && p.text.includes(SYSTEM_MARKER));
    const part = { type: "text", text: SYSTEM_PROMPT };
    if (idx >= 0) system[idx] = part;
    else system.push(part);
  }
  debug("transform-out", { sid: sessionID, outMsgs: reassembled.length, nudge: !!turn.nudge?.shouldInject });
}
function numOpt(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : void 0;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function strArrayOpt(v) {
  return Array.isArray(v) ? v.map(String) : void 0;
}
function boolOpt(v) {
  return typeof v === "boolean" ? v : void 0;
}
export {
  index_default as default
};
