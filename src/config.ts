import { defaultConfig, type Config as KernelConfig } from "acp-kernel"

export const FALLBACK_LIMIT = 200000

export interface AdapterConfig {
  modelContextLimit?: number
  protectedTools?: string[]
  preserveRecentMessages?: number
  debug?: boolean
  coreOverrides?: Partial<KernelConfig>
}

export interface ResolvedConfig {
  kernel: KernelConfig
  modelContextLimit: number
  protectedTools: string[]
  preserveRecentMessages: number
}

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function resolveConfig(
  adapter: AdapterConfig,
  liveLimit?: number,
): ResolvedConfig {
  const modelContextLimit =
    adapter.modelContextLimit ??
    envInt("BILI_MODEL_CONTEXT_LIMIT") ??
    envInt("ACP_MODEL_CONTEXT_LIMIT") ??
    (liveLimit && liveLimit > 0 ? liveLimit : undefined) ??
    FALLBACK_LIMIT

  const protectedTools = adapter.protectedTools ?? []
  const preserveRecentMessages = adapter.preserveRecentMessages ?? 8

  // Defer nudge/threshold math to the kernel's own defaultConfig (it scales
  // growthFloor/growthCap from modelContextLimit); override via coreOverrides.
  const kernel: KernelConfig = defaultConfig(modelContextLimit, {
    protectedTools,
    preserveRecentMessages,
    ...adapter.coreOverrides,
    // Conservative defaults: nudge less often than the kernel's stock values.
    // Stock (acp-kernel): growthRatio 0.05, growthFloor/growthCap 50000,
    // minGrowthFloor 20000, minGrowthRatio 0.45, emergency 0.80 → at a 200K
    // limit that nudges after ~22.5K growth with ~50K compressible. The values
    // below roughly double both gates (~40K growth, ~80K compressible) so
    // Billy stops pushing early; the emergency nudge at 85% still catches a
    // genuinely full context.
    nudge: {
      maxContextLimitPct: adapter.coreOverrides?.nudge?.maxContextLimitPct ?? 0.55,
      minContextLimitPct: adapter.coreOverrides?.nudge?.minContextLimitPct ?? 0.45,
      frequency: adapter.coreOverrides?.nudge?.frequency ?? 5,
      iterationThreshold: adapter.coreOverrides?.nudge?.iterationThreshold ?? 15,
      force: adapter.coreOverrides?.nudge?.force ?? "soft",
      growthRatio: adapter.coreOverrides?.nudge?.growthRatio ?? 0.1,
      growthFloor: adapter.coreOverrides?.nudge?.growthFloor ?? 80000,
      growthCap: adapter.coreOverrides?.nudge?.growthCap ?? 80000,
      minGrowthFloor: adapter.coreOverrides?.nudge?.minGrowthFloor ?? 40000,
      minGrowthRatio: adapter.coreOverrides?.nudge?.minGrowthRatio ?? 0.5,
      emergencyThresholdPct: adapter.coreOverrides?.nudge?.emergencyThresholdPct ?? 0.85,
    },
    // Keep tier-1 summaries around longer before distilling them into a
    // tier-2 block, so summary-distillation nudges also fire less often.
    promotionThreshold: 8,
    // The adapter registers its tools as bili_*; the kernel must recognize
    // bili_compress (acp-kernel compressToolName, fork #ec9b85d) so consumed
    // invocations are pruned as call+result pairs instead of leaking.
    compressToolName: "bili_compress",
  })

  return {
    kernel,
    modelContextLimit,
    protectedTools,
    preserveRecentMessages,
  }
}
