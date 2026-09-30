import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Label,
} from '@kaibot/shared'
import { Trash2, RefreshCw, TrendingUp, TrendingDown } from '@/lib/icons'
import { cn } from '@kaibot/shared'
import { formatCurrency } from '@/lib/utils'

interface ExchangeAccount {
  exchangeName: string
  accountId: string
  name: string
  currency: string
  balance: number
  equity: number
  realizedPnL: number
  unrealizedPnL: number
  initialMargin?: number
  maintenanceMargin?: number
}

interface ExchangeAccountCardProps {
  account: ExchangeAccount
  status: 'connected' | 'disconnected' | 'error'
  onDisconnect: () => void
  onRefresh: () => void
  isRefreshing?: boolean
}

export function ExchangeAccountCard({
  account,
  status,
  onDisconnect,
  onRefresh,
  isRefreshing = false,
}: ExchangeAccountCardProps) {

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return 'bg-[var(--kb-green)]'
      case 'error':
        return 'bg-[var(--kb-red)]'
      default:
        return 'bg-muted-foreground'
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-xl">{account.name}</CardTitle>
            <CardDescription className="flex items-center gap-2 mt-1">
              <Badge variant="outline">{account.exchangeName}</Badge>
              <span className="text-xs text-muted-foreground">
                {account.accountId}
              </span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full', getStatusColor())} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh account"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Disconnect account"
              onClick={onDisconnect}
              className="text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Balance</Label>
            <div className="text-lg font-mono font-semibold">
              {formatCurrency(account.balance, account.currency)}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Equity</Label>
            <div className="text-lg font-mono font-semibold">
              {formatCurrency(account.equity, account.currency)}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Realized P&L
            </Label>
            <div
              className={cn(
                'text-lg font-mono font-semibold flex items-center gap-1',
                account.realizedPnL >= 0 ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
              )}
            >
              {account.realizedPnL >= 0 ? (
                <TrendingUp className="size-4" />
              ) : (
                <TrendingDown className="size-4" />
              )}
              {formatCurrency(Math.abs(account.realizedPnL), account.currency)}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Unrealized P&L
            </Label>
            <div
              className={cn(
                'text-lg font-mono font-semibold flex items-center gap-1',
                account.unrealizedPnL >= 0 ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'
              )}
            >
              {account.unrealizedPnL >= 0 ? (
                <TrendingUp className="size-4" />
              ) : (
                <TrendingDown className="size-4" />
              )}
              {formatCurrency(
                Math.abs(account.unrealizedPnL),
                account.currency
              )}
            </div>
          </div>
          {account.initialMargin !== undefined && (
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Initial Margin
              </Label>
              <div className="text-lg font-mono font-semibold">
                {formatCurrency(account.initialMargin, account.currency)}
              </div>
            </div>
          )}
          {account.maintenanceMargin !== undefined && (
            <div className="space-y-1">
              <Label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Maintenance Margin
              </Label>
              <div className="text-lg font-mono font-semibold">
                {formatCurrency(account.maintenanceMargin, account.currency)}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}