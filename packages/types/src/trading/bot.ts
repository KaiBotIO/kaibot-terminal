import { BaseEntity, BaseExecutorEntity } from '../common/base.js';
import { Strategy } from './strategy-legacy.js';
import { Exchange, ExecutorExchange } from '../core/exchange.js';
import { Market } from './market.js';
import { User, ExecutorUser } from '../core/user.js';

export interface BotConfig {
  max_positions?: number;
  position_size?: number;
  trading_hours?: {
    start: string;
    end: string;
    timezone: string;
  };
  allowed_symbols?: string[];
  excluded_symbols?: string[];
  [key: string]: any;
}

export interface RiskConfig {
  max_drawdown?: number;
  stop_loss?: number;
  take_profit?: number;
  position_sizing?: 'fixed' | 'percent' | 'kelly';
  max_exposure?: number;
}

export interface BotExecutionResults {
  totalTrades: number;
  winRate: number;
  totalPnL: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  avgWin?: number;
  avgLoss?: number;
}

export interface Bot extends BaseEntity {
  name: string;
  description?: string;
  isActive: boolean;
  strategy: Strategy;
  exchange: Exchange;
  market?: Market;
  outputs?: {
    signals?: boolean;
    paperTrading?: boolean;
    execution?: boolean;
  };
  following?: boolean;
  user?: User;
  startTime?: number;
  totalResults?: BotExecutionResults;
}

export interface ExecutorBot extends BaseExecutorEntity {
  id: number;
  name: string;
  strategy_id: string;
  exchange_id: number;
  is_active: boolean;
  is_paper: boolean;
  config: BotConfig;
  risk_config?: RiskConfig;
}

export interface UnifiedBot {
  id: string | number;
  name: string;
  description?: string;
  isActive: boolean;
  isPaper?: boolean;
  strategyId?: string;
  strategy?: Strategy;
  exchangeId?: string | number;
  exchange?: Exchange | ExecutorExchange;
  market?: Market;
  config?: BotConfig;
  riskConfig?: RiskConfig;
  outputs?: {
    signals?: boolean;
    paperTrading?: boolean;
    execution?: boolean;
  };
  following?: boolean;
  user?: User | ExecutorUser;
  startTime?: number;
  totalResults?: BotExecutionResults;
  createdAt: Date;
  updatedAt?: Date;
}

export function isBot(obj: any): obj is Bot {
  return typeof obj.id === 'string' && 'strategy' in obj && 'exchange' in obj;
}

export function isExecutorBot(obj: any): obj is ExecutorBot {
  return typeof obj.id === 'number' && 'strategy_id' in obj && 'config' in obj;
}