import { BaseEntity, BaseExecutorEntity } from '../common/base.js';
import { UserExchangeSettings } from './exchange.js';

export interface User extends BaseEntity {
  name: string;
  email: string;
  exchanges: UserExchangeSettings[];
}

export interface ExecutorUser extends BaseExecutorEntity {
  id: number;
  username: string;
  password_hash: string;
  last_login?: Date;
  settings?: Record<string, any>;
}

export interface UnifiedUser {
  id: string | number;
  username?: string;
  name?: string;
  email?: string;
  passwordHash?: string;
  exchanges?: UserExchangeSettings[];
  settings?: Record<string, any>;
  createdAt: Date;
  updatedAt?: Date;
  lastLogin?: Date;
}

export function isUser(obj: any): obj is User {
  return typeof obj.id === 'string' && 'email' in obj;
}

export function isExecutorUser(obj: any): obj is ExecutorUser {
  return typeof obj.id === 'number' && 'username' in obj && 'password_hash' in obj;
}