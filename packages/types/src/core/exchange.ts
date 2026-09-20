import { BaseEntity, BaseExecutorEntity } from '../common/base.js';
import { ExchangeType, InstrumentType } from '../common/enums.js';
import { Market } from '../trading/market.js';

export interface Exchange extends BaseEntity {
  name: string;
  supportedInstruments: InstrumentType[];
  markets: Market[];
}

export interface ExecutorExchange extends BaseExecutorEntity {
  id: number;
  name: string;
  type: ExchangeType;
  credentials_encrypted: string;
  is_active: boolean;
  is_paper: boolean;
  last_connected?: Date;
}

export interface UserExchangeSettings {
  exchange: Exchange;
  apiKey?: string;
  secretKey?: string;
  isPaper?: boolean;
  isActive?: boolean;
}

export interface UnifiedExchange {
  id: string | number;
  name: string;
  type?: ExchangeType;
  supportedInstruments?: InstrumentType[];
  markets?: Market[];
  credentialsEncrypted?: string;
  isActive: boolean;
  isPaper: boolean;
  lastConnected?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export function isExchange(obj: any): obj is Exchange {
  return typeof obj.id === 'string' && 'supportedInstruments' in obj;
}

export function isExecutorExchange(obj: any): obj is ExecutorExchange {
  return typeof obj.id === 'number' && 'type' in obj && 'credentials_encrypted' in obj;
}