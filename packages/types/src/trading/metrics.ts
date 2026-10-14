export interface GroupMetrics {
  totalPortfolioValue: number;
  totalPnL: number;
  activeBots: number;
  openPositions: number;
  closedPositions?: number;
  memberCount: number;
  accountCount?: number;
  totalTrades24h: number;
}

export interface DashboardMetrics {
  totalValue: number;
  dayChange: number;
  dayChangePercent: number;
  totalPnL: number;
  totalPnLPercent: number;
  openPositions: number;
  activeBots: number;
  winRate?: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
}

export interface PerformanceMetrics {
  period: 'day' | 'week' | 'month' | 'year' | 'all';
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  finalBalance: number;
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio?: number;
  calmarRatio?: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldTime: number;
  turnover: number;
}