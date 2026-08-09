# opencode-acp-v2

**Active Context Pruning for OpenCode V2** — a Core port of the
[opencode-acp](https://github.com/ranxianglei/opencode-acp) (DCP successor)
design to the **V2 plugin API** (`Plugin.define` + `ctx.session.hook`).

The model decides *when* and *what* to compress — not a hard limit. This
package is a working **Core** subset: context management tools, system-prompt
nudges, and message-range pruning via the V2 context hook. It is a reference
implementation for bringing ACP-style context pruning to OpenCode V2.

## Why this exists

- `opencode-acp` (and its predecessor DCP) target the **V1 plugin API**
  (`experimental.chat.messages.transform`, `tool:` maps, `ctx.client`).
- OpenCode V2 uses a different plugin API (`Plugin.define({ id, setup })`,
  `ctx.session.hook("context")`, `ctx.tool.transform`). **V1 plugins will not
  load in V2** — the V2 host rejects them with `SchemaError(Expected object,
  got async (ctx) => ...)`.
- This package re-implements the core ACP behavior on the V2 API so it works
  with `opencode2` today, and serves as a reference for a future upstream port.

## Install

```jsonc
// ~/.config/opencode/opencode.json (global) or <project>/.opencode/opencode.jsonc
{
  "plugins": [
    "opencode-acp-v2@latest"
  ]
}
```

Restart OpenCode. Verify it loaded:

```bash
opencode2 api get /api/plugin    # look for "opencode-acp"
opencode2 run "Use the acp_status tool and report what it returns."
```

## What it does

| Tool | Purpose |
|------|---------|
| `compress` | Replace older message ranges with a short technical summary (`[Compressed conversation section] ... [block b1]`) |
| `decompress` | Restore a compressed block's original messages |
| `search_context` | Search inside compressed blocks by keyword |
| `acp_status` | Show context usage %, visible message refs (`m00001`...), active blocks (`b1`...) |
| `acp_context_recap` | Recap compressed + recent visible context |

Plus:
- **Message references** `m00001...` / block references `b1...` injected into
  the system prompt each dispatch, so tools can address ranges.
- **Protected tail** — the last N messages and last user message are not
  compressible unless `dangerous: true` is passed.
- **Context-usage nudges** — appends a soft/strong nudge to the system prompt
  when usage crosses `compress.minNudgeContextPercent`.
- **`/acp` command** registered via `ctx.command.transform`.

## Config

`ctx.options` (the object form of a `plugins` entry) take precedence; a
`acp.jsonc` / `dcp.jsonc` in the OpenCode config dir is used as a fallback
(JSONC-tolerant — comments and trailing commas OK).

```jsonc
{
  "plugins": [
    {
      "package": "opencode-acp-v2@latest",
      "options": {
        "compress": {
          "permission": "allow",          // "ask" | "allow" | "deny"
          "maxContextLimit": 200000,      // your model's context window
          "minNudgeContextPercent": 70,   // nudge when usage exceeds this
          "nudgeForce": "soft",           // "strong" | "soft"
          "maxSummaryLengthHard": 1600,
          "preserveRecentMessages": 20,   // tail protected from compression
          "preserveLastUserMessage": true
        }
      }
    }
  ]
}
```

## Scope / limitations (Core port)

This is **not** a full ACP port. Not implemented:
- Generational GC of compressed blocks (tier promotion, block aging)
- Quality gates, message filters, protected-tag/file-pattern handling
- Embedding-based context search
- Auto-update, session-state persistence, sub-agent policy
- Catalog model-limit lookup — `maxContextLimit` is config/default only, so
  usage % is relative to that value, not the model's actual window

The V2 plugin API is beta; entrypoints and hooks may change before the stable
release. Pin a matching `@opencode-ai/plugin@next` when publishing plugins
against a specific OpenCode release.

## License

**AGPL-3.0-or-later** — this is a derivative design of opencode-acp
(AGPL-3.0). See [LICENSE](LICENSE).
