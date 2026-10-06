import { useReducer, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Badge,
  Button,
  Alert,
  AlertDescription,
  Label,
  Checkbox,
  EmptyState,
} from '@kaibot/shared'
import { Search, Info, ArrowLeft, ExternalLink, Loader2, Copy, Check } from '@/lib/icons'
import { cn } from '@kaibot/shared'
import { openExternalUrl } from '@/lib/utils'
import { useTradestationAuthMode } from '@/hooks/useTradestationAuthMode'
import { ExchangeLogo } from './ExchangeLogo'

// Credentials accepted by the backend `connect`/`oauth/start` route. apiKey
// connect (Deribit/Bybit/IB) and the TradeStation OAuth app key/secret share
// one shape; the discriminant is `type`.
type ExchangeCredentials =
  | { type: 'apiKey'; apiKey: string; apiSecret: string; testnet?: boolean }
  | { type: 'apiKey'; host: string; port: number; clientId: number; paper: boolean }
  | { type: 'oauth'; apiKey: string; apiSecret: string; redirectUri?: string }

// Thrown by Exchanges.handleConnect when the backend answers an OAuth connect
// with { requiresOAuth, authUrl }. Not an Error subclass — match by shape.
function isOAuthRedirect(err: unknown): err is { message: 'OAUTH_REDIRECT_REQUIRED'; authUrl: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { message?: unknown }).message === 'OAUTH_REDIRECT_REQUIRED' &&
    typeof (err as { authUrl?: unknown }).authUrl === 'string'
  )
}

interface Exchange {
  id: string
  name: string
  displayName: string
  description: string
  logo?: string
  status: 'available' | 'coming-soon'
  features: string[]
  authType: 'oauth' | 'apiKey'
}

const EXCHANGES: Exchange[] = [
  {
    id: 'tradestation',
    name: 'tradestation',
    displayName: 'TradeStation',
    description: 'Professional futures and options trading platform',
    logo: '/logos/tradestation.svg',
    status: 'available',
    features: ['Futures', 'Options', 'Stocks', 'Real-time Data'],
    authType: 'oauth'
  },
  {
    id: 'deribit',
    name: 'deribit',
    displayName: 'Deribit',
    description: 'Leading crypto derivatives exchange',
    logo: '/logos/deribit.svg',
    status: 'available',
    features: ['BTC Options', 'ETH Options', 'Perpetuals', 'Futures'],
    authType: 'apiKey'
  },
  {
    id: 'interactive-brokers',
    name: 'interactive-brokers',
    displayName: 'Interactive Brokers',
    description: 'Global multi-asset broker, requires TWS/Gateway running locally',
    logo: '/logos/ib.svg',
    // H12: disabled at launch — IB adapter has no getOrderStatus (no settle/
    // reconcile), STK/USD-only, no tests. Flip back to 'available' once hardened.
    status: 'coming-soon',
    features: ['Stocks', 'Options', 'Futures', 'Global Markets'],
    authType: 'apiKey'
  },
  {
    id: 'bybit',
    name: 'bybit',
    displayName: 'Bybit',
    description: 'Crypto derivatives and spot trading',
    logo: '/logos/bybit.svg',
    status: 'available',
    features: ['USDT Perpetuals', 'Inverse Contracts', 'Spot Trading', 'Copy Trading'],
    authType: 'apiKey'
  },
  {
    id: 'binance',
    name: 'binance',
    displayName: 'Binance',
    description: 'USDⓈ-M Futures trading',
    logo: '/logos/binance.svg',
    status: 'available',
    features: ['USDⓈ-M Futures', 'Perpetuals', 'Reduce-only Stops', 'Testnet'],
    authType: 'apiKey'
  }
]

interface ExchangeSelectionWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // label: optional connection label for a SECOND connection on the same
  // exchange (e.g. a second Deribit account); omitted = the default connection.
  onConnect: (exchangeName: string, credentials: ExchangeCredentials, label?: string) => Promise<void>
}

// Optional label typed into an API-key form ('' → undefined).
function labelFrom(formData: FormData): string | undefined {
  const raw = ((formData.get('label') as string | null) ?? '').trim().toLowerCase()
  return raw ? raw : undefined
}

interface WizardState {
  searchQuery: string
  selectedExchange: Exchange | null
  isConnecting: boolean
  error: string | null
  useTestnet: boolean
  ibPaper: boolean
  // Set once an OAuth authorize URL has been opened: the form swaps to the
  // "waiting for authorization" interstitial until the callback returns.
  awaitingOAuthUrl: string | null
}

const initialWizardState: WizardState = {
  searchQuery: '',
  selectedExchange: null,
  isConnecting: false,
  error: null,
  useTestnet: false,
  ibPaper: true,
  awaitingOAuthUrl: null,
}

type WizardAction =
  | { type: 'reset' }
  | { type: 'setSearchQuery'; value: string }
  | { type: 'selectExchange'; exchange: Exchange }
  | { type: 'back' }
  | { type: 'setError'; value: string | null }
  | { type: 'setConnecting'; value: boolean }
  | { type: 'setUseTestnet'; value: boolean }
  | { type: 'setIbPaper'; value: boolean }
  | { type: 'awaitOAuth'; url: string }

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'reset':
      return { ...initialWizardState, ibPaper: state.ibPaper }
    case 'setSearchQuery':
      return { ...state, searchQuery: action.value }
    case 'selectExchange':
      return { ...state, selectedExchange: action.exchange, error: null }
    case 'back':
      return { ...state, selectedExchange: null, error: null, useTestnet: false, ibPaper: true, awaitingOAuthUrl: null }
    case 'setError':
      return { ...state, error: action.value }
    case 'setConnecting':
      return { ...state, isConnecting: action.value }
    case 'setUseTestnet':
      return { ...state, useTestnet: action.value }
    case 'setIbPaper':
      return { ...state, ibPaper: action.value }
    case 'awaitOAuth':
      return { ...state, awaitingOAuthUrl: action.url, isConnecting: false, error: null }
    default:
      return state
  }
}

export function ExchangeSelectionWizard({
  open,
  onOpenChange,
  onConnect,
}: ExchangeSelectionWizardProps) {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState)
  const { searchQuery, selectedExchange, isConnecting, error, useTestnet, ibPaper, awaitingOAuthUrl } = state
  const tradestationUsesOAuth = useTradestationAuthMode(open) === 'oauth'

  const filteredExchanges = EXCHANGES.filter(exchange =>
    exchange.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    exchange.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
    exchange.features.some(f => f.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const handleExchangeSelect = (exchange: Exchange) => {
    if (exchange.status === 'available') {
      dispatch({ type: 'selectExchange', exchange })
    }
  }

  const handleBack = () => {
    dispatch({ type: 'back' })
  }

  const setError = (value: string | null) => dispatch({ type: 'setError', value })
  const setIsConnecting = (value: boolean) => dispatch({ type: 'setConnecting', value })
  const setUseTestnet = (value: boolean) => dispatch({ type: 'setUseTestnet', value })
  const setIbPaper = (value: boolean) => dispatch({ type: 'setIbPaper', value })
  const setSearchQuery = (value: string) => dispatch({ type: 'setSearchQuery', value })

  const handleIBConnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsConnecting(true)

    const formData = new FormData(e.currentTarget)
    const hostValue = (formData.get('host') as string) || '127.0.0.1'
    const portRaw = formData.get('port') as string
    const clientIdRaw = formData.get('clientId') as string
    const port = portRaw ? parseInt(portRaw, 10) : (ibPaper ? 7497 : 7496)
    const clientId = clientIdRaw ? parseInt(clientIdRaw, 10) : 1

    const credentials = {
      type: 'apiKey' as const,
      host: hostValue,
      port,
      clientId,
      paper: ibPaper,
    }

    try {
      await onConnect('interactive-brokers', credentials)
      onOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to connect to Interactive Brokers')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleTradeStationConnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsConnecting(true)

    const formData = new FormData(e.currentTarget)
    const apiKey = (formData.get('apiKey') as string)?.trim()
    const apiSecret = (formData.get('apiSecret') as string)?.trim()
    const redirectUri = (formData.get('redirectUri') as string)?.trim() || undefined

    const credentials: ExchangeCredentials = { type: 'oauth', apiKey, apiSecret, redirectUri }

    try {
      // OAuth: connectExchange throws OAUTH_REDIRECT_REQUIRED, which handleConnect
      // re-throws as { message, authUrl }. A direct resolve means the session was
      // restored silently (no redirect) — close and let the list refresh.
      await onConnect('tradestation', credentials)
      onOpenChange(false)
    } catch (err: unknown) {
      if (isOAuthRedirect(err)) {
        await openExternalUrl(err.authUrl)
        dispatch({ type: 'awaitOAuth', url: err.authUrl })
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to connect to TradeStation')
      setIsConnecting(false)
    }
  }

  // Web: one-click connect. The backend reads the access_token from the legacy
  // KaiBotWeb CouchDB session, so no user-supplied credentials are needed here.
  const handleTradeStationCouchDBConnect = async () => {
    setError(null)
    setIsConnecting(true)
    try {
      await onConnect('tradestation', { type: 'apiKey', apiKey: 'couchdb-session', apiSecret: '' })
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to connect to TradeStation')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDeribitConnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsConnecting(true)

    const formData = new FormData(e.currentTarget)
    const credentials = {
      type: 'apiKey' as const,
      apiKey: formData.get('apiKey') as string,
      apiSecret: formData.get('apiSecret') as string,
      testnet: useTestnet,
    }

    try {
      await onConnect('deribit', credentials, labelFrom(formData))
      onOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to connect to exchange')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleBybitConnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsConnecting(true)

    const formData = new FormData(e.currentTarget)
    const credentials = {
      type: 'apiKey' as const,
      apiKey: formData.get('apiKey') as string,
      apiSecret: formData.get('apiSecret') as string,
      testnet: useTestnet,
    }

    try {
      await onConnect('bybit', credentials, labelFrom(formData))
      onOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to connect to exchange')
    } finally {
      setIsConnecting(false)
    }
  }

  const handleBinanceConnect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setIsConnecting(true)

    const formData = new FormData(e.currentTarget)
    const credentials = {
      type: 'apiKey' as const,
      apiKey: formData.get('apiKey') as string,
      apiSecret: formData.get('apiSecret') as string,
      testnet: useTestnet,
    }

    try {
      await onConnect('binance', credentials, labelFrom(formData))
      onOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to connect to exchange')
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={open ? 'open' : 'closed'} className="sm:max-w-[600px]">
        {!selectedExchange ? (
          <>
            <DialogHeader>
              <DialogTitle>Select an Exchange</DialogTitle>
              <DialogDescription>
                Choose an exchange to connect. Your API credentials will be encrypted and stored securely.
              </DialogDescription>
            </DialogHeader>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search exchanges…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            <div className="grid grid-cols-2 gap-4 mt-6">
              {filteredExchanges.map((exchange) => (
                <div
                  key={exchange.id}
                  role="button"
                  tabIndex={exchange.status === 'available' ? 0 : -1}
                  aria-disabled={exchange.status !== 'available'}
                  className={cn(
                    "relative border p-4 cursor-pointer transition-all",
                    exchange.status === 'available'
                      ? "hover:border-primary"
                      : "opacity-60 cursor-not-allowed",
                  )}
                  onClick={() => handleExchangeSelect(exchange)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleExchangeSelect(exchange)
                    }
                  }}
                >
                  {exchange.status === 'coming-soon' && (
                    <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
                      Coming Soon
                    </Badge>
                  )}
                  
                  <div className="flex flex-col h-full min-h-[120px] p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <ExchangeLogo exchange={exchange.id} className="size-8 shrink-0 rounded" />
                      <h3 className="font-sans font-semibold text-base">{exchange.displayName}</h3>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">{exchange.description}</p>
                    <div className="flex flex-wrap gap-1 mt-auto">
                      {exchange.features.slice(0, 3).map((feature) => (
                        <Badge key={feature} variant="outline" className="text-xs px-1.5 py-0">
                          {feature}
                        </Badge>
                      ))}
                      {exchange.features.length > 3 && (
                        <span className="text-xs text-muted-foreground">
                          +{exchange.features.length - 3}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {filteredExchanges.length === 0 && (
              <EmptyState
                icon={Search}
                title="No exchanges found"
                description={`Nothing matches "${searchQuery}".`}
              />
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to exchange list"
                  onClick={handleBack}
                  className="size-8"
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <div>
                  <DialogTitle>Connect to {selectedExchange.displayName}</DialogTitle>
                  <DialogDescription>
                    {selectedExchange.id === 'tradestation'
                      ? tradestationUsesOAuth
                        ? 'Authorize with your own TradeStation API key'
                        : 'Establish a connection to your account'
                      : 'Enter your API credentials to establish a connection'}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="mt-6">
              {selectedExchange.id === 'tradestation' && (
                tradestationUsesOAuth ? (
                  <TradeStationForm
                    error={error}
                    isConnecting={isConnecting}
                    awaitingOAuthUrl={awaitingOAuthUrl}
                    onBack={handleBack}
                    onSubmit={handleTradeStationConnect}
                  />
                ) : (
                  <TradeStationCouchDBForm
                    error={error}
                    isConnecting={isConnecting}
                    onBack={handleBack}
                    onConnect={handleTradeStationCouchDBConnect}
                  />
                )
              )}

              {selectedExchange.id === 'interactive-brokers' && (
                <InteractiveBrokersForm
                  error={error}
                  isConnecting={isConnecting}
                  ibPaper={ibPaper}
                  onIbPaperChange={setIbPaper}
                  onBack={handleBack}
                  onSubmit={handleIBConnect}
                />
              )}

              {selectedExchange.id === 'deribit' && (
                <ApiKeyExchangeForm
                  exchangeLabel="Deribit"
                  idPrefix="db"
                  testnetId="testnet"
                  testnetLabel="Use Testnet (test.deribit.com)"
                  infoText="You'll need your Deribit API credentials. Create them at Deribit's API Management page. Create a trade-only key: grant trade and read scopes only, never wallet withdrawal. For testing, enable the testnet option below."
                  error={error}
                  isConnecting={isConnecting}
                  useTestnet={useTestnet}
                  onUseTestnetChange={setUseTestnet}
                  onBack={handleBack}
                  onSubmit={handleDeribitConnect}
                />
              )}

              {selectedExchange.id === 'bybit' && (
                <ApiKeyExchangeForm
                  exchangeLabel="Bybit"
                  idPrefix="bb"
                  testnetId="bybit-testnet"
                  testnetLabel="Use Testnet (api-testnet.bybit.com)"
                  infoText="You'll need your Bybit v5 API credentials. Create them at Bybit's API Management page. Create a trade-only key: enable trading permissions only and leave withdrawals disabled. A leaked trade-only key can't drain your account. For testing, enable the testnet option below (api-testnet.bybit.com)."
                  error={error}
                  isConnecting={isConnecting}
                  useTestnet={useTestnet}
                  onUseTestnetChange={setUseTestnet}
                  onBack={handleBack}
                  onSubmit={handleBybitConnect}
                />
              )}

              {selectedExchange.id === 'binance' && (
                <ApiKeyExchangeForm
                  exchangeLabel="Binance"
                  idPrefix="bn"
                  testnetId="binance-testnet"
                  testnetLabel="Use Testnet (testnet.binancefuture.com)"
                  infoText="You'll need your Binance USDⓈ-M Futures API credentials. Create them at Binance's API Management page, with Futures enabled. Create a trade-only key: do not enable withdrawals. A leaked trade-only key can't drain your account. For testing, enable the testnet option below (testnet.binancefuture.com)."
                  error={error}
                  isConnecting={isConnecting}
                  useTestnet={useTestnet}
                  onUseTestnetChange={setUseTestnet}
                  onBack={handleBack}
                  onSubmit={handleBinanceConnect}
                />
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ErrorAlert({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

function FormActions({
  isConnecting,
  onBack,
  submitLabel,
  type = 'submit',
  onClick,
}: {
  isConnecting: boolean
  onBack: () => void
  submitLabel: string
  type?: 'submit' | 'button'
  onClick?: () => void
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onBack} disabled={isConnecting}>
        Back
      </Button>
      <Button type={type} onClick={onClick} disabled={isConnecting}>
        {isConnecting ? 'Connecting...' : submitLabel}
      </Button>
    </div>
  )
}

// The redirect URI the backend's callback route lives at. The user must
// whitelist this exact URL in their TradeStation developer app, otherwise the
// authorize redirect is rejected. Default to the current origin; an explicit
// override is allowed via the Redirect URI field.
const TS_CALLBACK_PATH = '/api/exchanges/v2/callback/tradestation'
const defaultRedirectUri = () =>
  typeof window !== 'undefined' ? `${window.location.origin}${TS_CALLBACK_PATH}` : TS_CALLBACK_PATH

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Copy redirect URL"
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check className="size-3.5 text-[var(--kb-green)]" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

// Web mode: one-click connect. kaibotweb owns the OAuth flow + token refresh;
// the backend reads the access_token from its CouchDB session, so there are no
// credentials to enter here.
function TradeStationCouchDBForm({
  error,
  isConnecting,
  onBack,
  onConnect,
}: {
  error: string | null
  isConnecting: boolean
  onBack: () => void
  onConnect: () => void
}) {
  return (
    <div className="space-y-4">
      <Alert className="mb-4">
        <Info className="size-4" />
        <AlertDescription>
          If your TradeStation account is linked through KaiBot, connect to trade on it from here.
        </AlertDescription>
      </Alert>

      <ErrorAlert error={error} />

      <FormActions
        isConnecting={isConnecting}
        onBack={onBack}
        submitLabel="Connect to TradeStation"
        type="button"
        onClick={onConnect}
      />
    </div>
  )
}

function TradeStationForm({
  error,
  isConnecting,
  awaitingOAuthUrl,
  onBack,
  onSubmit,
}: {
  error: string | null
  isConnecting: boolean
  awaitingOAuthUrl: string | null
  onBack: () => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
}) {
  const redirectUri = defaultRedirectUri()

  // Interstitial: the authorize tab is open; we wait for the callback to bounce
  // the browser back to /?exchange_connected=tradestation.
  if (awaitingOAuthUrl) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Loader2 className="size-6 animate-spin text-[var(--kb-teal)]" />
          <div>
            <p className="font-sans text-sm font-medium">Waiting for TradeStation authorization…</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Approve access in the TradeStation tab. This window updates once you return.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void openExternalUrl(awaitingOAuthUrl)}>
            <ExternalLink className="mr-1.5 size-3.5" />
            Reopen authorization page
          </Button>
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      <Alert className="mb-4">
        <Info className="size-4" />
        <AlertDescription>
          Create an API key in the TradeStation Client Center (API section), then paste its Client
          ID and secret here. Whitelist the redirect URL below on that same key. Authorizing opens
          TradeStation in your browser. After you approve, KaiBot Terminal refreshes the session on
          its own, so you only do this once.
        </AlertDescription>
      </Alert>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ts-apiKey">Client ID</Label>
          <Input
            id="ts-apiKey"
            name="apiKey"
            type="text"
            placeholder="Your TradeStation app Client ID"
            required
            disabled={isConnecting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ts-apiSecret">Client Secret</Label>
          <Input
            id="ts-apiSecret"
            name="apiSecret"
            type="password"
            placeholder="Your TradeStation app Client Secret"
            required
            disabled={isConnecting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ts-redirectUri">Redirect URI</Label>
          <Input
            id="ts-redirectUri"
            name="redirectUri"
            type="text"
            defaultValue={redirectUri}
            disabled={isConnecting}
          />
        </div>

        <div className="space-y-1.5 border border-border bg-muted/40 p-3">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Whitelist this redirect URL
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-xs text-[var(--kb-teal)]">{redirectUri}</code>
            <CopyButton value={redirectUri} />
          </div>
        </div>

        <ErrorAlert error={error} />

        <FormActions
          isConnecting={isConnecting}
          onBack={onBack}
          submitLabel="Authorize with TradeStation"
        />
      </form>
    </>
  )
}

function InteractiveBrokersForm({
  error,
  isConnecting,
  ibPaper,
  onIbPaperChange,
  onBack,
  onSubmit,
}: {
  error: string | null
  isConnecting: boolean
  ibPaper: boolean
  onIbPaperChange: (value: boolean) => void
  onBack: () => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <>
      <Alert className="mb-4">
        <Info className="size-4" />
        <AlertDescription>
          <strong>Requires TWS or IB Gateway running locally.</strong>{' '}
          Enable "ActiveX and Socket Clients" in TWS → Global Configuration → API → Settings,
          and add 127.0.0.1 to Trusted IPs. Default ports: 7497 (TWS paper), 7496 (TWS live),
          4002 (Gateway paper), 4001 (Gateway live). MVP supports US stocks via SMART routing.
        </AlertDescription>
      </Alert>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ib-host">Host</Label>
          <Input
            id="ib-host"
            name="host"
            type="text"
            placeholder="127.0.0.1"
            defaultValue="127.0.0.1"
            disabled={isConnecting}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="ib-port">Port</Label>
            <Input
              id="ib-port"
              name="port"
              type="number"
              placeholder={ibPaper ? '7497' : '7496'}
              disabled={isConnecting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ib-clientId">Client ID</Label>
            <Input
              id="ib-clientId"
              name="clientId"
              type="number"
              placeholder="1"
              defaultValue="1"
              disabled={isConnecting}
            />
          </div>
        </div>

        <div className="flex items-center gap-x-2">
          <Checkbox
            id="ib-paper"
            checked={ibPaper}
            onCheckedChange={(checked) => onIbPaperChange(checked as boolean)}
            disabled={isConnecting}
          />
          <Label htmlFor="ib-paper" className="text-sm font-normal cursor-pointer">
            Paper trading (port 7497 / 4002)
          </Label>
        </div>

        <ErrorAlert error={error} />

        <FormActions
          isConnecting={isConnecting}
          onBack={onBack}
          submitLabel="Connect to Interactive Brokers"
        />
      </form>
    </>
  )
}

function ApiKeyExchangeForm({
  exchangeLabel,
  idPrefix,
  testnetId,
  testnetLabel,
  infoText,
  error,
  isConnecting,
  useTestnet,
  onUseTestnetChange,
  onBack,
  onSubmit,
}: {
  exchangeLabel: string
  idPrefix: string
  testnetId: string
  testnetLabel: string
  infoText: string
  error: string | null
  isConnecting: boolean
  useTestnet: boolean
  onUseTestnetChange: (value: boolean) => void
  onBack: () => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <>
      <Alert className="mb-4">
        <Info className="size-4" />
        <AlertDescription>{infoText}</AlertDescription>
      </Alert>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-apiKey`}>API Key</Label>
          <Input
            id={`${idPrefix}-apiKey`}
            name="apiKey"
            type="text"
            placeholder={`Your ${exchangeLabel} API key`}
            required
            disabled={isConnecting}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-apiSecret`}>API Secret</Label>
          <Input
            id={`${idPrefix}-apiSecret`}
            name="apiSecret"
            type="password"
            placeholder={`Your ${exchangeLabel} API secret`}
            required
            disabled={isConnecting}
          />
        </div>

        <div className="flex items-center gap-x-2">
          <Checkbox
            id={testnetId}
            checked={useTestnet}
            onCheckedChange={(checked) => onUseTestnetChange(checked as boolean)}
            disabled={isConnecting}
          />
          <Label htmlFor={testnetId} className="text-sm font-normal cursor-pointer">
            {testnetLabel}
          </Label>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-label`}>Connection label</Label>
          <Input
            id={`${idPrefix}-label`}
            name="label"
            type="text"
            placeholder="acct2"
            pattern="[a-z0-9][a-z0-9-]{0,31}"
            disabled={isConnecting}
          />
          <p className="text-[11px] text-muted-foreground">
            Only for a second {exchangeLabel} account next to one already connected. Positions
            on it show as <span className="font-mono">label/account</span>.
          </p>
        </div>

        <ErrorAlert error={error} />

        <FormActions
          isConnecting={isConnecting}
          onBack={onBack}
          submitLabel={`Connect to ${exchangeLabel}`}
        />
      </form>
    </>
  )
}