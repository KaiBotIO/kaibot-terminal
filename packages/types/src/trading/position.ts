import { BaseEntity, BaseExecutorEntity } from '../common/base.js';
import { PositionSide, PositionStatus } from '../common/enums.js';
import type { Trade } from './trade.js';
import { User, ExecutorUser } from '../core/user.js';
import { Bot } from './bot.js';

export interface PositionGroup {
  id: string;
  name: string;
  color?: string;
}

export interface PositionManageHistory {
  managerId: string;
  managerType: 'user' | 'bot';
  startTime: number;
  endTime?: number;
  actions?: string[];
}

export interface Position extends BaseEntity {
  positionGroup?: PositionGroup;
  market: string;
  trades: Trade[];
  currentManager: User | Bot;
  entryPrices: Record<number, number>;
  closePrice: number;
  currentPrice?: number;
  stoplossPrice: number;
  isBacktesting: boolean;
  isPaper: boolean;
  avgOpenPrice: number;
  openTime: number;
  closeTime?: number;
  tag?: string;
  manageHistory?: PositionManageHistory;
  comment?: string;
}

export interface ExecutorPosition extends BaseExecutorEntity {
  id: number;
  exchange_id: number;
  exchange_name?: string;
  symbol: string;
  side: PositionSide;
  quantity: number;
  entry_price: number;
  current_price?: number;
  exit_price?: number;
  status: PositionStatus;
  opened_at: Date;
  closed_at?: Date;
  pnl?: number;
  pnl_percentage?: number;
  strategy_id?: string;
  signal_id?: string;
}

export interface SimplePosition {
  symbol: string;
  quantity: number;
  pnl: number;
}

export interface UnifiedPosition {
  id: string | number;
  exchangeId: string | number;
  exchangeName?: string;
  symbol: string;
  market?: string;
  side?: PositionSide;
  quantity: number;
  entryPrice: number;
  avgOpenPrice?: number;
  currentPrice?: number;
  exitPrice?: number;
  closePrice?: number;
  stoplossPrice?: number;
  status: PositionStatus;
  trades?: Trade[];
  currentManager?: User | Bot | ExecutorUser;
  isBacktesting?: boolean;
  isPaper?: boolean;
  pnl?: number;
  pnlPercentage?: number;
  strategyId?: string;
  signalId?: string;
  tag?: string;
  comment?: string;
  openedAt: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export function isPosition(obj: any): obj is Position {
  return typeof obj.id === 'string' && 'market' in obj && 'trades' in obj;
}

export function isExecutorPosition(obj: any): obj is ExecutorPosition {
  return typeof obj.id === 'number' && 'symbol' in obj && 'side' in obj;
}