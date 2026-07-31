import { useEffect, useReducer, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Checkbox,
  Alert,
  AlertTitle,
  AlertDescription,
} from "@kaibot/shared";
import {
  Bot,
  ChevronRight,
  ChevronLeft,
  Search,
  CheckCircle,
  Info,
  Loader2,
  KeyRound,
  Settings as SettingsIcon,
} from "@/lib/icons";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useApiConnection } from "@/hooks/useApiConnection";

interface MarketplaceBot {
  id: string;
  name: string;
  description?: string;
  supportedMarkets?: string[];
  publishedAt?: string | null;
  creatorName?: string;
}

interface WizardConfig {
  factor: number;
  // How the sized quantity is denominated. Defaults to native (contracts).
  sizeUnit: "native" | "usd";
  maxPositionSize?: number;
  maxConcurrentTrades?: number;
  // Execution venue: composite signals carry no venue, so the subscription
  // MUST name where orders go. Required by the backend.
  exchange?: string;
}

interface WizardState {
  step: number;
  selectedBot: MarketplaceBot | null;
  selectedMarkets: string[];
  config: WizardConfig;
  marketplaceError: string | null;
}

const initialWizardState: WizardState = {
  step: 1,
  selectedBot: null,
  selectedMarkets: [],
  config: { factor: 1.0, sizeUnit: "native" },
  marketplaceError: null,
};

type WizardAction =
  | { type: "reset" }
  | { type: "setStep"; step: number }
  | { type: "pickBot"; bot: MarketplaceBot }
  | { type: "toggleMarket"; market: string }
  | { type: "patchConfig"; patch: Partial<WizardConfig> }
  | { type: "setMarketplaceError"; error: string | null };

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "reset":
      return initialWizardState;
    case "setStep":
      return { ...state, step: action.step };
    case "pickBot":
      return {
        ...state,
        selectedBot: action.bot,
        selectedMarkets: action.bot.supportedMarkets ?? [],
      };
    case "toggleMarket":
      return {
        ...state,
        selectedMarkets: state.selectedMarkets.includes(action.market)
          ? state.selectedMarkets.filter((m) => m !== action.market)
          : [...state.selectedMarkets, action.market],
      };
    case "patchConfig":
      return { ...state, config: { ...state.config, ...action.patch } };
    case "setMarketplaceError":
      return { ...state, marketplaceError: action.error };
    default:
      return state;
  }
}

interface NewSubscriptionWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (subscription: { id: string; serverSynced: boolean }) => void;
}

export function NewSubscriptionWizard({ isOpen, onClose, onComplete }: NewSubscriptionWizardProps) {
  const navigate = useNavigate();
  const apiConnection = useApiConnection(0);
  const [wizard, dispatch] = useReducer(wizardReducer, initialWizardState);
  const { step, selectedBot, selectedMarkets, config, marketplaceError } = wizard;
  const [bots, setBots] = useState<MarketplaceBot[]>([]);
  const [loadingBots, setLoadingBots] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [connectedVenues, setConnectedVenues] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    apiFetch("/api/exchanges/v2/sessions", { headers: { "x-user-id": "default" } })
      .then((res) => (res.ok ? res.json() : []))
      .then((sessions: any[]) => {
        const venues = (Array.isArray(sessions) ? sessions : [])
          .filter((s) => s.status === "connected")
          .map((s) => String(s.exchangeName));
        setConnectedVenues(venues);
        if (venues.length === 1) dispatch({ type: "patchConfig", patch: { exchange: venues[0] } });
      })
      .catch(() => setConnectedVenues([]));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    dispatch({ type: "reset" });
    apiConnection.refresh().then(() => {
      // loadMarketplace is gated on connection status inside the second effect
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (apiConnection.isLoading) return;
    if (!apiConnection.isConfigured) return;
    loadMarketplace();
  }, [isOpen, apiConnection.isLoading, apiConnection.isConfigured]);

  async function loadMarketplace() {
    setLoadingBots(true);
    dispatch({ type: "setMarketplaceError", error: null });
    try {
      const res = await apiFetch("/api/subscriptions/marketplace/browse");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Marketplace unreachable (${res.status})`);
      }
      const data = await res.json();
      setBots(data.bots ?? []);
    } catch (err: any) {
      dispatch({ type: "setMarketplaceError", error: err?.message ?? "Could not load marketplace" });
      setBots([]);
    } finally {
      setLoadingBots(false);
    }
  }

  function goToSettings() {
    onClose();
    navigate("/settings");
  }

  function goToExchanges() {
    onClose();
    navigate("/exchanges");
  }

  const filteredBots = bots.filter(
    (b) =>
      b.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (b.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function pickBot(bot: MarketplaceBot) {
    dispatch({ type: "pickBot", bot });
  }

  function toggleMarket(market: string) {
    dispatch({ type: "toggleMarket", market });
  }

  async function handleConfirm() {
    if (!selectedBot) return;
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signalBotId: selectedBot.id,
          botName: selectedBot.name,
          selectedMarkets,
          factor: config.factor,
          sizeUnit: config.sizeUnit,
          maxPositionSize: config.maxPositionSize,
          maxConcurrentTrades: config.maxConcurrentTrades,
          exchange: config.exchange,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Subscribe failed");
      }
      const data = await res.json();
      toast.success(
        data.serverSynced
          ? "Subscribed, synced with server"
          : "Subscribed locally (server not reachable)",
      );
      onComplete({ id: data.id, serverSynced: data.serverSynced });
    } catch (err: any) {
      toast.error(err.message || "Subscribe failed");
    } finally {
      setSubmitting(false);
    }
  }

  const canAdvance =
    (step === 1 && !!selectedBot && apiConnection.isConfigured) ||
    (step === 2 && selectedMarkets.length > 0) ||
    (step === 3 && config.factor > 0 && !!config.exchange) ||
    step === 4;

  function handleNext() {
    if (step === 4) {
      handleConfirm();
      return;
    }
    if (!canAdvance) return;
    dispatch({ type: "setStep", step: step + 1 });
  }

  function handleBack() {
    dispatch({ type: "setStep", step: Math.max(1, step - 1) });
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Run a bot on this executor</DialogTitle>
        </DialogHeader>

        {/* Progress */}
        <div className="flex items-center justify-between mb-4">
          {["Bot", "Markets", "Factor", "Confirm"].map((label, i) => {
            const n = i + 1;
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={`w-7 h-7 flex items-center justify-center font-mono text-xs ${
                    step > n
                      ? "bg-primary text-primary-foreground"
                      : step === n
                        ? "border-2 border-primary text-primary"
                        : "border border-border text-muted-foreground"
                  }`}
                >
                  {n}
                </div>
                <span
                  className={`text-xs font-label ${
                    step >= n ? "font-medium" : "text-muted-foreground"
                  }`}
                >
                  {label}
                </span>
                {n < 4 && <ChevronRight className="size-3 text-muted-foreground" />}
              </div>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto">
          {step === 1 && !apiConnection.isConfigured && !apiConnection.isLoading && (
            <Step1NotConfigured onOpenSettings={goToSettings} />
          )}
          {step === 1 && apiConnection.isConfigured && (
            <Step1BotPicker
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              loadingBots={loadingBots}
              marketplaceError={marketplaceError}
              filteredBots={filteredBots}
              selectedBot={selectedBot}
              onPickBot={pickBot}
            />
          )}

          {step === 2 && selectedBot && (
            <Step2Markets
              selectedBot={selectedBot}
              selectedMarkets={selectedMarkets}
              onToggleMarket={toggleMarket}
            />
          )}

          {step === 3 && (
            <Step3Config
              config={config}
              connectedVenues={connectedVenues}
              onPatchConfig={(patch) => dispatch({ type: "patchConfig", patch })}
              onConnectExchange={goToExchanges}
            />
          )}

          {step === 4 && selectedBot && (
            <Step4Confirm
              selectedBot={selectedBot}
              selectedMarkets={selectedMarkets}
              config={config}
            />
          )}
        </div>

        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={step === 1 ? onClose : handleBack} disabled={submitting}>
            {step === 1 ? "Cancel" : (<><ChevronLeft className="size-4 mr-1" />Back</>)}
          </Button>
          <Button onClick={handleNext} disabled={!canAdvance || submitting}>
            {step === 4 ? (
              submitting ? (
                <><Loader2 className="size-4 mr-1 animate-spin" />Subscribing…</>
              ) : (
                "Subscribe"
              )
            ) : (
              <>Next<ChevronRight className="size-4 ml-1" /></>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function Step1NotConfigured({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
      <KeyRound className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground max-w-sm">
        Configure an API key in Settings first to use the marketplace.
      </p>
      <Button size="sm" onClick={onOpenSettings}>
        <SettingsIcon className="size-4 mr-1.5" />
        Open Settings
      </Button>
    </div>
  );
}

function Step1BotPicker({
  searchQuery,
  onSearchChange,
  loadingBots,
  marketplaceError,
  filteredBots,
  selectedBot,
  onPickBot,
}: {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  loadingBots: boolean;
  marketplaceError: string | null;
  filteredBots: MarketplaceBot[];
  selectedBot: MarketplaceBot | null;
  onPickBot: (bot: MarketplaceBot) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search bots…"
          className="pl-10"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      {loadingBots ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin mr-2" />
          Loading marketplace…
        </div>
      ) : marketplaceError ? (
        <Alert variant="destructive">
          <Info />
          <AlertTitle>Marketplace unreachable</AlertTitle>
          <AlertDescription>
            {marketplaceError}. Check that your API key is valid.
          </AlertDescription>
        </Alert>
      ) : filteredBots.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No bots found
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredBots.map((bot) => (
            <Card
              key={bot.id}
              className={`cursor-pointer transition-colors ${
                selectedBot?.id === bot.id ? "border-primary" : "hover:border-primary/50"
              }`}
              onClick={() => onPickBot(bot)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start gap-2">
                  <div className="p-2 border border-border">
                    <Bot className="size-4" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-sm">{bot.name}</CardTitle>
                    {bot.creatorName && (
                      <CardDescription className="text-[11px]">
                        by {bot.creatorName}
                      </CardDescription>
                    )}
                  </div>
                  {selectedBot?.id === bot.id && (
                    <CheckCircle className="size-4 text-primary" />
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {bot.description && (
                  <p className="text-[11px] text-muted-foreground line-clamp-2">
                    {bot.description}
                  </p>
                )}
                {bot.supportedMarkets && bot.supportedMarkets.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {bot.supportedMarkets.slice(0, 5).map((m) => (
                      <Badge key={m} variant="outline" className="text-[10px] py-0 px-1.5 font-mono text-[var(--kb-teal)]">
                        {m}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Step2Markets({
  selectedBot,
  selectedMarkets,
  onToggleMarket,
}: {
  selectedBot: MarketplaceBot;
  selectedMarkets: string[];
  onToggleMarket: (market: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-1">Select markets to follow</h3>
        <p className="text-xs text-muted-foreground">
          Signals for other markets will be ignored. Default: all.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {(selectedBot.supportedMarkets ?? []).map((market) => (
          <label
            key={market}
            className="flex items-center gap-2 p-3 border border-border hover:bg-muted/50 cursor-pointer"
          >
            <Checkbox
              checked={selectedMarkets.includes(market)}
              onCheckedChange={() => onToggleMarket(market)}
            />
            <span className="text-xs font-mono text-[var(--kb-teal)]">{market}</span>
          </label>
        ))}
      </div>
      {selectedMarkets.length === 0 && (
        <p className="text-[11px] text-[var(--kb-red)]">At least one market must be selected.</p>
      )}
    </div>
  );
}

function Step3Config({
  config,
  connectedVenues,
  onPatchConfig,
  onConnectExchange,
}: {
  config: WizardConfig;
  connectedVenues: string[];
  onPatchConfig: (patch: Partial<WizardConfig>) => void;
  onConnectExchange: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Execution exchange</Label>
        <p className="text-[11px] text-muted-foreground">
          Where this bot's orders are placed. Signals price on the composite
          index; this executor maps them to the venue you pick here.
        </p>
        {connectedVenues.length === 0 ? (
          <Alert>
            <AlertTitle>No connected exchange</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                A subscription needs an execution venue. Connect an exchange to
                continue.
              </p>
              <Button size="sm" onClick={onConnectExchange}>
                Connect an exchange
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-wrap gap-2">
            {connectedVenues.map((venue) => (
              <Button
                key={venue}
                size="sm"
                variant={config.exchange === venue ? "default" : "outline"}
                onClick={() => onPatchConfig({ exchange: venue })}
              >
                {venue}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Position Factor</Label>
        <p className="text-[11px] text-muted-foreground">
          Multiplier of your executor base size. 2 doubles every signal's contract
          size, 0.5 halves it, 1 keeps the bot's size as-is.
        </p>
        <Input
          type="number"
          step="0.1"
          min="0.1"
          value={config.factor}
          onChange={(e) => {
            const v = parseFloat(e.target.value) || 0;
            onPatchConfig({ factor: v });
          }}
          className="w-40"
        />
      </div>

      <div className="space-y-2">
        <Label>Size unit</Label>
        <p className="text-[11px] text-muted-foreground">
          How the sized quantity and max position are denominated. USD converts to
          contracts at the mark price on this executor.
        </p>
        <div className="flex w-fit overflow-hidden rounded border border-border text-xs">
          {(["native", "usd"] as const).map((u) => (
            <Button
              key={u}
              size="sm"
              variant={config.sizeUnit === u ? "default" : "outline"}
              className="rounded-none border-0"
              onClick={() => onPatchConfig({ sizeUnit: u })}
            >
              {u === "native" ? "Contracts" : "USD"}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label>Max position size (optional)</Label>
        <p className="text-[11px] text-muted-foreground">
          Total notional safety cap. If a signal would exceed it, it will be clipped.
        </p>
        <Input
          type="number"
          placeholder="unlimited"
          value={config.maxPositionSize ?? ""}
          onChange={(e) => {
            const v = e.target.value ? parseFloat(e.target.value) : undefined;
            onPatchConfig({ maxPositionSize: v });
          }}
          className="w-40"
        />
      </div>

      <div className="space-y-2">
        <Label>Max concurrent trades (optional)</Label>
        <Input
          type="number"
          placeholder="unlimited"
          value={config.maxConcurrentTrades ?? ""}
          onChange={(e) => {
            const v = e.target.value ? parseInt(e.target.value, 10) : undefined;
            onPatchConfig({ maxConcurrentTrades: v });
          }}
          className="w-40"
        />
      </div>
    </div>
  );
}

function Step4Confirm({
  selectedBot,
  selectedMarkets,
  config,
}: {
  selectedBot: MarketplaceBot;
  selectedMarkets: string[];
  config: WizardConfig;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Review & confirm</h3>
      <div className="p-4 border border-border space-y-2 text-xs">
        <Row label="Bot" value={selectedBot.name} />
        <Row label="Markets" value={selectedMarkets.join(", ") || "—"} />
        <Row label="Execution exchange" value={config.exchange ?? "—"} />
        <Row label="Factor" value={`${config.factor}×`} />
        <Row label="Size unit" value={config.sizeUnit === "usd" ? "USD" : "Contracts"} />
        <Row
          label="Max position size"
          value={config.maxPositionSize ? `${config.maxPositionSize}` : "unlimited"}
        />
        <Row
          label="Max concurrent trades"
          value={config.maxConcurrentTrades ? `${config.maxConcurrentTrades}` : "unlimited"}
        />
      </div>
      <div className="flex items-start gap-2 p-3 border border-border text-[11px]">
        <Info className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
        <p>
          This subscription will be stored locally in the executor and on the server.
          Signals for this bot will be scaled by <b>{config.factor}×</b> and clipped to
          the limits above before execution.
        </p>
      </div>
    </div>
  );
}
