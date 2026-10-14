import { z } from 'zod';

// --- Per-type config schemas ---

export const emaCrossConfigSchema = z.object({
  type: z.literal('ema_cross'),
  fastPeriod: z.number().int().min(1).max(1000).default(9),
  slowPeriod: z.number().int().min(1).max(1000).default(21),
  source: z.enum(['close', 'open', 'high', 'low']).default('close'),
}).refine((c) => c.fastPeriod < c.slowPeriod, {
  message: 'fastPeriod must be smaller than slowPeriod',
  path: ['fastPeriod'],
});

export const rsiThresholdConfigSchema = z.object({
  type: z.literal('rsi_threshold'),
  period: z.number().int().min(2).max(500).default(14),
  oversold: z.number().min(0).max(100).default(30),
  overbought: z.number().min(0).max(100).default(70),
}).refine((c) => c.oversold < c.overbought, {
  message: 'oversold must be smaller than overbought',
  path: ['oversold'],
});

export const staircaseConfigSchema = z.object({
  type: z.literal('staircase'),
  atrPeriod: z.number().int().min(1).max(500).default(14),
  atrMultiplier: z.number().min(0.1).max(20).default(2),
  trendBars: z.number().int().min(1).max(100).default(3),
});

export const snakeConfigSchema = z.object({
  type: z.literal('snake'),
  length: z.number().int().min(2).max(500).default(20),
  smoothing: z.number().int().min(1).max(50).default(3),
  signalThreshold: z.number().min(0).max(10).default(0.5),
});

export const bbLightConfigSchema = z.object({
  type: z.literal('bblight'),
  period: z.number().int().min(2).max(500).default(20),
  stdDev: z.number().min(0.1).max(10).default(2),
  breakoutConfirmation: z.number().int().min(0).max(20).default(1),
});

// User-defined strategy params. `code` is the full JS source of the strategy
// module (returns { config, onCandle }). Free-form numeric/string/boolean knobs
// stay in the same record for backwards compat with existing UI forms. Arrays
// carry the structured extras a DB-code strategy can declare: `timeframes`
// (higher-TF labels in minutes → ctx.higherTimeframes) and `managers`
// ([{ managerId, params }] → declarative exit managers). Their shape is
// validated where consumed (resolveAdditionalTimeframes / resolveStrategyManagers).
export const customParamsSchema = z.record(
  z.union([z.number(), z.string(), z.boolean(), z.array(z.unknown())]),
);

// Strategy AI-tool declaration (Deel C). A proper sibling field — NOT another
// out-of-band params cast — so a strategy that calls the AI tool is explicitly
// marked (extra per-token cost) and gated on save + activation. `enabled` is a
// literal true so the field only ever exists when opted in.
export const strategyAiConfigSchema = z.object({
  enabled: z.literal(true),
  modelClass: z.enum(['standard', 'advanced']).default('standard'),
});
export type StrategyAiConfig = z.infer<typeof strategyAiConfigSchema>;

export const customConfigSchema = z.object({
  type: z.literal('custom'),
  notes: z.string().max(2000).optional(),
  params: customParamsSchema.default({}).refine(
    (p) => p.code === undefined || typeof p.code === 'string',
    { message: 'params.code must be a string' },
  ),
  // Present only for AI strategies. Marks the strategy "AI" and picks the model
  // class (advanced requires the top AI tier).
  ai: strategyAiConfigSchema.optional(),
});

// Exit-only: manages a handed-off position with a percentage trailing stop.
// trailDistance (percent) — stop sits this far behind the extreme once active.
// activationDistance (percent, optional) — price must move this far in favor
//   from the entry before the trail arms. Default 0 (arm immediately).
export const trailingStopManagerConfigSchema = z.object({
  type: z.literal('trailing_stop_manager'),
  trailDistance: z.number().positive().max(100).default(1.5),
  activationDistance: z.number().min(0).max(100).default(0),
});

// Single source of truth: reuse the per-type schemas that already carry
// .default() (and .refine()) so a strategy created with empty {} config still
// validates (the per-field defaults fill in). Previously this union duplicated
// the fields WITHOUT defaults, so parse({type}) threw invalid_type for every
// legacy kind — bug #16 in the launch audit.
//
// z.union (not z.discriminatedUnion): emaCross/rsiThreshold are .refine()-wrapped
// (ZodEffects), and this zod rejects ZodEffects members inside discriminatedUnion
// (`type.shape` is undefined). Plain union still applies each member's defaults
// and validates; the only cost is a non-discriminated error path, acceptable for
// config validation. The `type` literal on each member keeps selection exact.
export const strategyConfigSchema = z.union([
  emaCrossConfigSchema,
  rsiThresholdConfigSchema,
  staircaseConfigSchema,
  snakeConfigSchema,
  bbLightConfigSchema,
  customConfigSchema,
  trailingStopManagerConfigSchema,
]);

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;
export type StrategyType = StrategyConfig['type'];

export const STRATEGY_TYPES = [
  'ema_cross',
  'rsi_threshold',
  'staircase',
  'snake',
  'bblight',
  'custom',
  'trailing_stop_manager',
] as const;

// --- SDK plugin strategy kind ---
//
// SDK plugins (packages/strategy-sdk) are addressed by id with an `sdk:` prefix
// (e.g. `sdk:breakout-continuation`), the same encoding the backtester uses.
// strategy-runner cannot import strategy-sdk (circular), so plugin params are
// stored as an opaque record here and validated by the plugin's own
// paramsSchema at the call site (live runner / backtester). The strategy `type`
// column carries the full `sdk:<id>` string; `config` is just the params.
export const SDK_STRATEGY_TYPE_PREFIX = 'sdk:';

export function isSdkStrategyType(type: string): boolean {
  return type.startsWith(SDK_STRATEGY_TYPE_PREFIX);
}

export function sdkPluginIdFromType(type: string): string {
  return type.slice(SDK_STRATEGY_TYPE_PREFIX.length);
}

// Free-form params for an SDK plugin strategy. No `type` discriminator — the
// plugin id lives in the strategy `type` field. Values stay JSON-serializable.
// Number arrays are allowed for list params like the multi-TF `ladderMinutes`.
export const sdkStrategyConfigSchema = z.record(
  z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.number())]),
);
export type SdkStrategyConfig = z.infer<typeof sdkStrategyConfigSchema>;

// Exit-only types can only manage handed-off positions, never open new ones.
export const EXIT_ONLY_STRATEGY_TYPES = ['trailing_stop_manager'] as const;
export type ExitOnlyStrategyType = (typeof EXIT_ONLY_STRATEGY_TYPES)[number];
export function isExitOnlyStrategyType(type: string): type is ExitOnlyStrategyType {
  return (EXIT_ONLY_STRATEGY_TYPES as readonly string[]).includes(type);
}

export const STRATEGY_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export const strategyStatusSchema = z.enum(STRATEGY_STATUSES);
export type StrategyStatus = z.infer<typeof strategyStatusSchema>;

// --- Strategy record (server-side shape) ---

export const strategyRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(STRATEGY_TYPES),
  config: strategyConfigSchema,
  symbol: z.string().nullable().optional(),
  timeframe: z.string().nullable().optional(),
  status: strategyStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type StrategyRecord = z.infer<typeof strategyRecordSchema>;

// --- Create / update inputs ---

// Common fields shared by built-in and SDK strategy create inputs.
const baseCreateStrategyFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  symbol: z.string().optional(),
  timeframe: z.string().optional(),
  status: strategyStatusSchema.default('draft').optional(),
};

// Built-in strategy (discriminated-union config keyed by type).
const createBuiltinStrategyInputSchema = z.object({
  ...baseCreateStrategyFields,
  type: z.enum(STRATEGY_TYPES),
  config: strategyConfigSchema,
});

// SDK plugin strategy: `type` is `sdk:<pluginId>`, `config` is opaque params.
const createSdkStrategyInputSchema = z.object({
  ...baseCreateStrategyFields,
  type: z.string().refine(isSdkStrategyType, {
    message: `SDK strategy type must start with "${SDK_STRATEGY_TYPE_PREFIX}"`,
  }),
  config: sdkStrategyConfigSchema.default({}),
});

export const createStrategyInputSchema = z.union([
  createBuiltinStrategyInputSchema,
  createSdkStrategyInputSchema,
]);

// Version governance on save (mirrors the system-strategy editor): with bots
// running the strategy, a config/type edit must pick a mode — 'newVersion'
// snapshots the outgoing config so running bots keep the version they run;
// 'patch' applies in place on their next tick. Without running bots (or for
// name/status-only edits) the mode is ignored, except an explicit 'newVersion'
// which always mints one.
const strategyVersionModeFields = {
  mode: z.enum(['newVersion', 'patch']).optional(),
  changelog: z.string().max(2000).optional(),
};

const updateBuiltinStrategyInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(STRATEGY_TYPES).optional(),
  config: strategyConfigSchema.optional(),
  symbol: z.string().nullable().optional(),
  timeframe: z.string().nullable().optional(),
  status: strategyStatusSchema.optional(),
  ...strategyVersionModeFields,
});

const updateSdkStrategyInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  type: z.string().refine(isSdkStrategyType, {
    message: `SDK strategy type must start with "${SDK_STRATEGY_TYPE_PREFIX}"`,
  }),
  config: sdkStrategyConfigSchema.optional(),
  symbol: z.string().nullable().optional(),
  timeframe: z.string().nullable().optional(),
  status: strategyStatusSchema.optional(),
  ...strategyVersionModeFields,
});

export const updateStrategyInputSchema = z.union([
  updateBuiltinStrategyInputSchema,
  updateSdkStrategyInputSchema,
]);

export type CreateStrategyInput = z.infer<typeof createStrategyInputSchema>;
export type UpdateStrategyInput = z.infer<typeof updateStrategyInputSchema>;

// --- Default configs per type (used by builder UI) ---

// Derived from the schemas so the defaults can never drift from validation:
// each entry is the result of parsing just `{ type }` through the (now-defaulted)
// union. Used by the builder UI.
export const DEFAULT_CONFIGS: Record<StrategyType, StrategyConfig> = Object.fromEntries(
  STRATEGY_TYPES.map((t) => [t, strategyConfigSchema.parse({ type: t })]),
) as Record<StrategyType, StrategyConfig>;
