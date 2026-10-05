import { BaseEntity } from '../common/base.js';

// Legacy strategy types. Kept for back-compat with bot.ts and existing
// consumers. These are pure data types with NO dependency on
// @kaibot/strategy-runner, so they live in their own module and can be pulled
// into the pure-type barrel (@kaibot/types/core) without dragging the
// strategy-runner graph along. The v2 strategy-runner re-exports live in
// ./strategy.ts.

/** @deprecated Legacy parameter descriptor. v2 uses strongly-typed configs. */
export interface StrategyParameter {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'select';
  defaultValue: any;
  required?: boolean;
  min?: number;
  max?: number;
  options?: string[];
  description?: string;
}

/** @deprecated Legacy strategy descriptor. v2 uses StrategyRecord from @kaibot/strategy-runner. */
export interface Strategy extends BaseEntity {
  name: string;
  description?: string;
  version: string;
  author?: string;
  category?: string;
  parameters: StrategyParameter[];
  supportedMarkets?: string[];
  requiredIndicators?: string[];
  isActive?: boolean;
}

/** @deprecated Legacy config shape. v2 uses the discriminated StrategyConfig union. */
export interface StrategyConfig {
  strategy_id: string;
  parameters: Record<string, any>;
  is_active: boolean;
  created_at: Date;
  updated_at?: Date;
}
