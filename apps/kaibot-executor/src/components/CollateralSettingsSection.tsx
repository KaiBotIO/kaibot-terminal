import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Section,
  SettingRow,
  Switch,
  useConfirm,
} from "@kaibot/shared";
import { toast } from "sonner";
import { Wallet } from "@/lib/icons";
import {
  collateralApi,
  type CollateralAccountRef,
  type CollateralCoinView,
  type CollateralSettings,
  type SizingBasisMode,
  type UnflooredMode,
  type VirtualCoverage,
} from "@/lib/collateral-api";
import { accountKey, ratioOverridesFromForm, thresholdError } from "@/lib/collateral";

const STABLES = new Set(["USDT", "USDC"]);

// Settings → Account Sizing: collateral pot + account guard per Bybit UTA.
export function CollateralSettingsSection() {
  const [accounts, setAccounts] = useState<CollateralAccountRef[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    collateralApi
      .accounts()
      .then((r) => alive && setAccounts(r.accounts))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p className="border-b border-border px-6 py-2 text-[11px] text-[var(--kb-amber)]">
        Couldn't load collateral accounts.
      </p>
    );
  }
  if (!accounts || accounts.length === 0) return null;
  return (
    <>
      {accounts.map((a) => (
        <AccountCollateralSettings key={accountKey(a)} account={a} />
      ))}
    </>
  );
}

function AccountCollateralSettings({ account }: { account: CollateralAccountRef }) {
  const [saved, setSaved] = useState<CollateralSettings | null>(null);
  const [coins, setCoins] = useState<CollateralCoinView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sizingBasis, setSizingBasis] = useState<SizingBasisMode>("off");
  const [unfloored, setUnfloored] = useState<UnflooredMode>("exclude");
  const [coverage, setCoverage] = useState<VirtualCoverage>("none");
  const [blockMmr, setBlockMmr] = useState("60");
  const [warnMmr, setWarnMmr] = useState("80");
  const [autoReduce, setAutoReduce] = useState(false);
  const [autoReducePct, setAutoReducePct] = useState("25");
  const [ratios, setRatios] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  const apply = useCallback((s: CollateralSettings) => {
    setSaved(s);
    setSizingBasis(s.sizingBasis);
    setUnfloored(s.unfloored);
    setCoverage(s.virtualCoverage);
    setBlockMmr(String(s.blockMmrPct));
    setWarnMmr(String(s.warnMmrPct));
    setAutoReduce(s.autoReduce);
    setAutoReducePct(String(s.autoReducePct));
    setRatios(
      Object.fromEntries(
        Object.entries(s.ratioOverrides).map(([coin, r]) => [coin, String(Math.round(r * 10000) / 100)]),
      ),
    );
  }, []);

  const load = useCallback(() => {
    collateralApi
      .overview(account.exchange, account.accountId)
      .then((o) => {
        apply(o.settings);
        setCoins(o.coins.filter((c) => !STABLES.has(c.coin.toUpperCase())));
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Load failed"));
  }, [account.exchange, account.accountId, apply]);

  useEffect(() => {
    load();
  }, [load]);

  const label = `${account.label ?? account.exchange} · ${account.accountId}`;
  const sectionLabel = (
    <span className="flex items-center gap-2">
      <Wallet className="size-3.5" />
      Collateral
      <span className="font-mono text-muted-foreground normal-case tracking-normal">{label}</span>
    </span>
  );

  if (loadError || !saved) {
    return (
      <Section label={sectionLabel}>
        {loadError ? (
          <>
            <p className="text-[11px] text-[var(--kb-red)]">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={load}>
              Retry
            </Button>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        )}
      </Section>
    );
  }

  const blockNum = Number(blockMmr);
  const warnNum = Number(warnMmr);
  const reducePctNum = Number(autoReducePct);
  const thresholdMsg = thresholdError(blockNum, warnNum);
  const reduceMsg =
    autoReduce && !(reducePctNum > 0 && reducePctNum <= 100) ? "Reduce size must be between 0 and 100 %." : null;
  const overrides = ratioOverridesFromForm(ratios);
  const ratioMsg = overrides == null ? "Ratios must be between 0 and 100 %." : null;

  const save = async () => {
    if (thresholdMsg || reduceMsg || overrides == null) return;
    if (autoReduce && !saved.autoReduce) {
      const ok = await confirm({
        title: "Turn on auto-reduce?",
        description: `Above the warn level the executor sells down the largest alt position on ${label} with real market orders.`,
        tone: "danger-money",
        summary: [
          { label: "Warn at", value: `${warnNum} % MMR` },
          { label: "Reduce by", value: `${reducePctNum} %` },
        ],
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    if (coverage === "hedge" && saved.virtualCoverage !== "hedge") {
      const ok = await confirm({
        title: "Hedge the off-exchange coins?",
        description: `When a sell floor on ${label} fires, the executor also shorts that coin's USDT perp for the off-exchange quantity. The Collateral page shows the leverage and liquidation price first.`,
        tone: "danger-money",
        confirmLabel: "Hedge",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await collateralApi.saveSettings({
        exchange: account.exchange,
        accountId: account.accountId,
        sizingBasis,
        unfloored,
        blockMmrPct: blockNum,
        warnMmrPct: warnNum,
        autoReduce,
        autoReducePct: reducePctNum,
        ratioOverrides: overrides,
        virtualCoverage: coverage,
      });
      apply(res.settings);
      const refused = res.hedges.filter((h) => h.status === "refused");
      if (refused.length) toast.error(refused.map((h) => `${h.coin}: ${h.error}`).join("\n"));
      toast.success("Collateral settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section label={sectionLabel} flush>
      <SettingRow
        label="Sizing basis"
        description="Floor: signals size on the sum of coins × trigger × ratio, and open notional stays within 1× that pot."
        control={
          <NativeSelect
            size="sm"
            aria-label="Sizing basis"
            value={sizingBasis}
            onChange={(e) => setSizingBasis(e.target.value as SizingBasisMode)}
            className="font-mono text-xs"
          >
            <NativeSelectOption value="off">off</NativeSelectOption>
            <NativeSelectOption value="floor">floor</NativeSelectOption>
          </NativeSelect>
        }
      />
      <SettingRow
        label="Coins without a floor"
        description="Margin value = coins × mark × ratio."
        control={
          <NativeSelect
            size="sm"
            aria-label="Coins without a floor"
            value={unfloored}
            disabled={sizingBasis === "off"}
            onChange={(e) => setUnfloored(e.target.value as UnflooredMode)}
            className="font-mono text-xs"
          >
            <NativeSelectOption value="exclude">exclude</NativeSelectOption>
            <NativeSelectOption value="margin">margin value</NativeSelectOption>
          </NativeSelect>
        }
      />
      <SettingRow
        label="Off-exchange coins"
        description="None: they count in the pot, nothing protects them. Hedge: a perp short for them fires with each sell floor."
        control={
          <NativeSelect
            size="sm"
            aria-label="Off-exchange coins"
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as VirtualCoverage)}
            className="font-mono text-xs"
          >
            <NativeSelectOption value="none">none</NativeSelectOption>
            <NativeSelectOption value="hedge">hedge</NativeSelectOption>
          </NativeSelect>
        }
      />
      <SettingRow
        label="Block new entries at"
        description="Maintenance margin rate, %."
        control={
          <Input
            type="number"
            aria-label="Block new entries at"
            value={blockMmr}
            onChange={(e) => setBlockMmr(e.target.value)}
            className="h-7 w-20 text-right text-xs"
          />
        }
      />
      <SettingRow
        label="Warn at"
        control={
          <Input
            type="number"
            aria-label="Warn at"
            value={warnMmr}
            onChange={(e) => setWarnMmr(e.target.value)}
            className="h-7 w-20 text-right text-xs"
          />
        }
      />
      <SettingRow
        label="Auto-reduce"
        description="Above the warn level, cut the largest alt position. Places real orders."
        control={
          <div className="flex items-center gap-2">
            {autoReduce && (
              <Input
                type="number"
                aria-label="Reduce by %"
                value={autoReducePct}
                onChange={(e) => setAutoReducePct(e.target.value)}
                className="h-7 w-16 text-right text-xs"
              />
            )}
            <Switch checked={autoReduce} onCheckedChange={setAutoReduce} aria-label="Auto-reduce" />
          </div>
        }
      />
      {coins.length > 0 && (
        <div className="space-y-2 border-t border-border/60 px-6 py-3">
          <Label className="text-[11px]">Collateral ratio overrides (%)</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {coins.map((c) => (
              <div key={c.coin} className="space-y-1">
                <Label htmlFor={`ratio-${account.accountId}-${c.coin}`} className="font-mono text-[10px] text-muted-foreground">
                  {c.coin}
                </Label>
                <Input
                  id={`ratio-${account.accountId}-${c.coin}`}
                  type="number"
                  inputMode="decimal"
                  placeholder={String(Math.round(c.collateralRatio * 10000) / 100)}
                  value={ratios[c.coin] ?? ""}
                  onChange={(e) => setRatios((r) => ({ ...r, [c.coin]: e.target.value }))}
                  className="h-7 text-right font-mono text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-border/60 px-6 py-3">
        {(thresholdMsg || reduceMsg || ratioMsg) && (
          <p className="text-[11px] text-[var(--kb-red)]">{thresholdMsg ?? reduceMsg ?? ratioMsg}</p>
        )}
        <Button
          size="sm"
          className="ml-auto h-7 text-[11px]"
          disabled={busy || !!thresholdMsg || !!reduceMsg || !!ratioMsg}
          onClick={save}
        >
          Save
        </Button>
      </div>
      {dialog}
    </Section>
  );
}
