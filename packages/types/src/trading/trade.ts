import { BaseEntity, BaseExecutorEntity } from '../common/base.js';
import { OrderType, OrderStatus, TradeSide } from '../common/enums.js';
import type { Position } from './position.js';
import { User, ExecutorUser } from '../core/user.js';
import { Bot } from './bot.js';

export interface Trade extends BaseEntity {
  position: Position;
  timestamp: number;
  quantity: number;
  price: number;
  direction: TradeSide;
  fees?: number;
  manager?: User | Bot;
}

export interface ExecutorTrade extends BaseExecutorEntity {
  id: number;
  position_id?: number;
  exchange_id: number;
  order_id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  type: OrderType;
  status: OrderStatus;
  filled_at?: Date;
  commission?: number;
  raw_response?: any;
}

export interface UnifiedTrade {
  id: string | number;
  positionId?: string | number;
  position?: Position;
  exchangeId: string | number;
  orderId?: string;
  symbol?: string;
  side: TradeSide;
  direction?: TradeSide;
  quantity: number;
  price: number;
  type?: OrderType;
  status?: OrderStatus;
  timestamp?: number;
  filledAt?: Date;
  fees?: number;
  commission?: number;
  manager?: User | Bot | ExecutorUser;
  rawResponse?: any;
  createdAt: Date;
  updatedAt?: Date;
}

export function isTrade(obj: any): obj is Trade {
  return typeof obj.id === 'string' && 'position' in obj && 'timestamp' in obj;
}

export function isExecutorTrade(obj: any): obj is ExecutorTrade {
  return typeof obj.id === 'number' && 'order_id' in obj && 'type' in obj;
}