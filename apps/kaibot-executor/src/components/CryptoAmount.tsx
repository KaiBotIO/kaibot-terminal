import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { formatNumber } from '@/lib/utils'

interface CryptoAmountProps {
  amount: number
  currency: string
  prices?: Record<string, number>
  className?: string
  showCurrency?: boolean
}

export function CryptoAmount({ 
  amount, 
  currency, 
  prices, 
  className = '',
  showCurrency = true 
}: CryptoAmountProps) {
  const formattedAmount = formatNumber(amount)
  const displayText = showCurrency ? `${formattedAmount} ${currency}` : formattedAmount
  
  // Calculate USD value if prices are available and it's not already USD
  const usdValue = currency !== 'USD' && prices?.[currency] 
    ? amount * prices[currency] 
    : null
  
  if (!usdValue) {
    return <span className={className}>{displayText}</span>
  }
  
  // Format USD value to 2 decimal places
  const formattedUSD = usdValue.toFixed(2)
  
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <span className={`${className} cursor-help border-b border-dotted border-muted-foreground/30`}>
            {displayText}
          </span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="z-50 overflow-hidden bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"
            sideOffset={5}
          >
            ≈ ${formattedUSD} USD
            <TooltipPrimitive.Arrow className="fill-primary" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}