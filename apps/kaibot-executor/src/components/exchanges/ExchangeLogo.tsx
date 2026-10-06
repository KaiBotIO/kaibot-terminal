import { cn } from '@kaibot/shared'
import { useState } from 'react'

interface ExchangeLogoProps {
  exchange: string
  className?: string
}

// Logo URLs from official sources
const EXCHANGE_LOGOS: Record<string, { url?: string; fallback: { bg: string; text: string; emoji?: string } }> = {
  tradestation: {
    url: 'https://cdn.brandfetch.io/idFuovG5oc/w/400/h/400/theme/dark/logo.png?c=1dxbfHSJFAPEGdCLU4o5B',
    fallback: {
      bg: 'bg-purple-600',
      text: 'text-white',
      emoji: '📊'
    }
  },
  deribit: {
    url: 'https://cdn.brandfetch.io/iduJq3AcIh/w/400/h/400/theme/dark/logo.png?c=1dxbfHSJFAPEGdCLU4o5B',
    fallback: {
      bg: 'bg-orange-500',
      text: 'text-white',
      emoji: '₿'
    }
  },
  'interactive-brokers': {
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Interactive_Brokers_Logo_%282014%29.svg/2560px-Interactive_Brokers_Logo_%282014%29.svg.png',
    fallback: {
      bg: 'bg-blue-600',
      text: 'text-white',
      emoji: '🏦'
    }
  },
  bybit: {
    url: 'https://cdn.brandfetch.io/idxA-qAvNu/w/400/h/400/theme/dark/logo.png?c=1dxbfHSJFAPEGdCLU4o5B',
    fallback: {
      bg: 'bg-yellow-500',
      text: 'text-black',
      emoji: '🚀'
    }
  },
  binance: {
    url: 'https://cdn.brandfetch.io/id-2t9ERsL/w/400/h/400/theme/dark/logo.png?c=1dxbfHSJFAPEGdCLU4o5B',
    fallback: {
      bg: 'bg-yellow-400',
      text: 'text-black',
      emoji: 'B'
    }
  }
}

export function ExchangeLogo({ exchange, className }: ExchangeLogoProps) {
  const [imageError, setImageError] = useState(false)
  const logoData = EXCHANGE_LOGOS[exchange] || EXCHANGE_LOGOS['interactive-brokers']
  
  if (logoData.url && !imageError) {
    return (
      <div className={cn('flex items-center justify-center overflow-hidden bg-white', className)}>
        <img 
          src={logoData.url}
          alt={`${exchange} logo`}
          className="w-full h-full object-contain p-2"
          onError={() => setImageError(true)}
        />
      </div>
    )
  }
  
  // Fallback to emoji/text logo
  const fallback = logoData.fallback || { bg: 'bg-gray-500', text: 'text-white' }
  
  return (
    <div className={cn(
      'flex items-center justify-center font-bold text-lg',
      fallback.bg,
      fallback.text,
      className
    )}>
      {fallback.emoji || exchange.slice(0, 2).toUpperCase()}
    </div>
  )
}