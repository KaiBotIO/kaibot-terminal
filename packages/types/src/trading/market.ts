import { InstrumentType } from '../common/enums.js';

export interface Market {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  instrumentType: InstrumentType;
  isActive: boolean;
  tickSize?: number;
  lotSize?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
}