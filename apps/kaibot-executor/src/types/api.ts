export interface ApiConfig {
  apiUrl?: string;
  apiKey?: string;
  signalServiceUrl?: string;
  autoConnect?: boolean;
  connectionTimeout?: number;
}

export interface ConnectionStatus {
  api: 'connected' | 'disconnected' | 'connecting' | 'error';
  signalService: 'connected' | 'disconnected' | 'connecting' | 'error';
  lastError?: string;
  lastConnected?: Date;
}

export interface TestConnectionResponse {
  success: boolean;
  message?: string;
  error?: string;
}