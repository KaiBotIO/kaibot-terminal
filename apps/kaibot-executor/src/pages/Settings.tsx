import { useState, useEffect, useReducer, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Badge,
  DataMatrix,
  Input,
  Label,
  Button,
  Switch,
  PageHeader,
  Section,
  SettingRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@kaibot/shared";
import { toast } from "sonner";
import { Bell, Key, Save, TestTube, Link2, Plug, Gauge, Shield, AlertTriangle, XCircle, Radio, Lock } from "@/lib/icons";
import { useAtom, useAtomValue } from "jotai";
import type { ApiConfig } from "../types/api";
import { apiFetch } from "../lib/api";
import {
  opsApi,
  companionApi,
  type AccountSizesRow,
  type MarginGuardsResponse,
  type MarginGuardConfigDto,
  type GuardrailsConfigDto,
  type HaltState,
  type FloorMode,
  type CompanionStatus,
} from "../lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";
import { syntheticUsdApi } from "../lib/synthetic-usd-api";
import {
  obfuscateSensitiveDataAtom,
  brandVariantAtom,
  displayTimeZoneAtom,
  isClassicMemberAtom,
  type BrandVariant,
} from "../lib/atoms";
import { obfuscateApiKey } from "../lib/obfuscate";
import { KAIBOT_API_URL } from "../lib/config";
import {
  ensurePermission,
  loadPrefs,
  notify,
  savePrefs,
  type NotificationEventType,
  type NotificationPrefs,
} from "../lib/notifications";

interface UserSettings {
  apiConfig?: ApiConfig;
  general?: {
    theme?: 'light' | 'dark' | 'system';
    notifications?: boolean;
    obfuscateSensitiveData?: boolean;
  };
  alerting?: {
    webhookUrl?: string;
    enabled?: boolean;
  };
}

interface ConnState {
  isSaving: boolean;
  isTesting: boolean;
}

type ConnAction =
  | { type: 'setSaving'; value: boolean }
  | { type: 'setTesting'; value: boolean };

function connReducer(state: ConnState, action: ConnAction): ConnState {
  switch (action.type) {
    case 'setSaving':
      return { ...state, isSaving: action.value };
    case 'setTesting':
      return { ...state, isTesting: action.value };
    default:
      return state;
  }
}

async function fetchWsStatus(): Promise<{ connected: boolean; status: string }> {
  const response = await apiFetch('/api/ws/status');
  if (!response.ok) throw new Error('Failed to check WebSocket status');
  return response.json();
}

export default function Settings() {
  const [obfuscateSensitive, setObfuscateSensitive] = useAtom(obfuscateSensitiveDataAtom);
  const [settings, setSettings] = useState<UserSettings>({
    apiConfig: {
      apiUrl: KAIBOT_API_URL,
      apiKey: '',
      signalServiceUrl: '',
      autoConnect: false,
      connectionTimeout: 30000,
    },
    general: {
      theme: 'system',
      notifications: true,
      obfuscateSensitiveData: false,
    },
    alerting: {
      webhookUrl: '',
      enabled: false,
    },
  });
  const [conn, dispatchConn] = useReducer(connReducer, {
    isSaving: false,
    isTesting: false,
  });
  const { isSaving, isTesting } = conn;
  const setIsSaving = (value: boolean) => dispatchConn({ type: 'setSaving', value });
  const setIsTesting = (value: boolean) => dispatchConn({ type: 'setTesting', value });
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>(() => loadPrefs());

  // A failed status poll keeps the last-known value.
  const { data: wsData, refresh: refreshWsStatus } = usePolledResource(fetchWsStatus, {
    intervalMs: 5000,
  });
  const wsStatus = wsData ?? { connected: false, status: 'disconnected' };

  // Load settings on mount
  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync obfuscate setting with atom
  useEffect(() => {
    if (settings.general?.obfuscateSensitiveData !== undefined) {
      setObfuscateSensitive(settings.general.obfuscateSensitiveData);
    }
  }, [settings.general?.obfuscateSensitiveData, setObfuscateSensitive]);

  const loadSettings = async () => {
    try {
      const response = await apiFetch('/api/user/settings');
      if (response.ok) {
        const data = await response.json();
        if (data.settings) {
          setSettings(data.settings);
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load settings, showing defaults');
    }
  };

  // Returns whether the save succeeded, so testConnection/connectWebSocket can
  // bail out instead of hitting the backend with config it never persisted.
  const saveSettings = async (): Promise<boolean> => {
    setIsSaving(true);
    try {
      // Ensure we always save with the hardcoded API URL
      const settingsToSave = {
        ...settings,
        apiConfig: {
          ...settings.apiConfig,
          apiUrl: KAIBOT_API_URL,
        }
      };

      const response = await apiFetch('/api/user/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: settingsToSave }),
      });

      if (response.ok) {
        toast.success('Settings saved');
        return true;
      }
      throw new Error('Failed to save settings');
    } catch (error) {
      toast.error('Failed to save settings');
      console.error(error);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const testConnection = async () => {
    if (!settings.apiConfig?.apiKey) {
      toast.error('Please enter API Key');
      return;
    }

    setIsTesting(true);
    try {
      // /api/test-connection takes the key from this request, but a passing
      // test with unsaved settings still leaves Connect broken right after —
      // save first so both buttons act on the same config.
      if (!(await saveSettings())) return;

      const response = await apiFetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiUrl: KAIBOT_API_URL,
          apiKey: settings.apiConfig.apiKey,
        }),
      });

      if (response.ok) {
        toast.success('Connection successful');
      } else {
        const error = await response.json();
        toast.error(error.message || 'Connection failed');
      }
    } catch (error) {
      toast.error('Connection test failed');
      console.error(error);
    } finally {
      setIsTesting(false);
    }
  };

  const updateApiConfig = (field: keyof ApiConfig, value: any) => {
    setSettings(prev => ({
      ...prev,
      apiConfig: {
        ...prev.apiConfig,
        [field]: value,
      },
    }));
  };

  const connectWebSocket = async () => {
    if (!settings.apiConfig?.apiKey) {
      toast.error('Please enter API Key');
      return;
    }

    // /api/ws/connect reads the saved backend settings, not this form — a
    // pasted-but-unsaved key would otherwise 400 with "API configuration
    // incomplete".
    if (!(await saveSettings())) return;

    try {
      const response = await apiFetch('/api/ws/connect', {
        method: 'POST',
      });

      if (response.ok) {
        toast('Connecting to signal service...');
        setTimeout(() => void refreshWsStatus(), 1000);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to connect');
      }
    } catch (error) {
      toast.error('Failed to connect to signal service');
    }
  };

  const updateNotifPrefs = (next: NotificationPrefs) => {
    setNotifPrefs(next);
    savePrefs(next);
  };

  const toggleNotifEnabled = async (enabled: boolean) => {
    if (enabled) {
      const granted = await ensurePermission();
      if (!granted) {
        toast.error('Notification permission denied by the OS');
        return;
      }
    }
    updateNotifPrefs({ ...notifPrefs, enabled });
  };

  const toggleNotifEventType = (type: NotificationEventType, value: boolean) => {
    updateNotifPrefs({
      ...notifPrefs,
      events: { ...notifPrefs.events, [type]: value },
    });
  };

  const toggleNotifSound = (sound: boolean) => {
    updateNotifPrefs({ ...notifPrefs, sound });
  };

  const sendTestNotification = async () => {
    await notify({
      type: 'signal_received',
      title: 'KaiBot Terminal',
      body: 'Test notification. You are all set.',
      dedupeKey: `test:${Date.now()}`,
    });
    toast.success('Test notification sent');
  };

  const disconnectWebSocket = async () => {
    try {
      const response = await apiFetch('/api/ws/disconnect', {
        method: 'POST',
      });

      if (response.ok) {
        toast.success('Disconnected from signal service');
        setTimeout(() => void refreshWsStatus(), 1000);
      }
    } catch (error) {
      toast.error('Failed to disconnect');
    }
  };

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Settings"
        description="Connect the executor to your account, size each market and tune alerting and notifications."
        actions={
          <Button size="sm" className="h-7 text-[11px]" onClick={saveSettings} disabled={isSaving}>
            <Save className="size-3 mr-1" />
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        }
      />

      <Tabs defaultValue="api" className="flex flex-col">
        <div className="border-b border-border px-6">
          <TabsList variant="line">
            <TabsTrigger value="api">API Configuration</TabsTrigger>
            <TabsTrigger value="sizing">Account Sizing</TabsTrigger>
            <TabsTrigger value="margin">Margin Guard</TabsTrigger>
            <TabsTrigger value="safety">Safety</TabsTrigger>
            <TabsTrigger value="alerting">Alerting</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="general">General</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="api">
          <ApiConfigTab
            apiKeyValue={obfuscateSensitive && settings.apiConfig?.apiKey ? obfuscateApiKey(settings.apiConfig.apiKey) : (settings.apiConfig?.apiKey || '')}
            obfuscateSensitive={obfuscateSensitive}
            autoConnect={settings.apiConfig?.autoConnect || false}
            hasApiKey={!!settings.apiConfig?.apiKey}
            isTesting={isTesting}
            isSaving={isSaving}
            wsStatus={wsStatus}
            onApiKeyChange={(v) => updateApiConfig('apiKey', v)}
            onAutoConnectChange={(checked) => updateApiConfig('autoConnect', checked)}
            onTestConnection={testConnection}
            onConnectWs={connectWebSocket}
            onDisconnectWs={disconnectWebSocket}
          />
        </TabsContent>

        <TabsContent value="sizing">
          <AccountSizingTab />
        </TabsContent>

        <TabsContent value="margin">
          <MarginGuardTab />
        </TabsContent>

        <TabsContent value="safety">
          <SafetyTab />
        </TabsContent>

        <TabsContent value="alerting">
          <AlertingTab
            webhookUrl={settings.alerting?.webhookUrl || ''}
            enabled={settings.alerting?.enabled || false}
            obfuscateSensitive={obfuscateSensitive}
            onWebhookUrlChange={(v) =>
              setSettings((prev) => ({ ...prev, alerting: { ...prev.alerting, webhookUrl: v } }))
            }
            onEnabledChange={(v) =>
              setSettings((prev) => ({ ...prev, alerting: { ...prev.alerting, enabled: v } }))
            }
            onSave={saveSettings}
          />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationsTab
            notifPrefs={notifPrefs}
            onToggleEnabled={toggleNotifEnabled}
            onToggleSound={toggleNotifSound}
            onToggleEventType={toggleNotifEventType}
            onSendTest={sendTestNotification}
          />
        </TabsContent>

        <TabsContent value="general">
          <GeneralTab
            notifications={settings.general?.notifications || false}
            obfuscateSensitiveData={settings.general?.obfuscateSensitiveData || false}
            onNotificationsChange={(checked) =>
              setSettings(prev => ({
                ...prev,
                general: { ...prev.general, notifications: checked }
              }))
            }
            onObfuscateChange={(checked) =>
              setSettings(prev => ({
                ...prev,
                general: { ...prev.general, obfuscateSensitiveData: checked }
              }))
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ApiConfigTab({
  apiKeyValue,
  obfuscateSensitive,
  autoConnect,
  hasApiKey,
  isTesting,
  isSaving,
  wsStatus,
  onApiKeyChange,
  onAutoConnectChange,
  onTestConnection,
  onConnectWs,
  onDisconnectWs,
}: {
  apiKeyValue: string;
  obfuscateSensitive: boolean;
  autoConnect: boolean;
  hasApiKey: boolean;
  isTesting: boolean;
  isSaving: boolean;
  wsStatus: { connected: boolean; status: string };
  onApiKeyChange: (value: string) => void;
  onAutoConnectChange: (checked: boolean) => void;
  onTestConnection: () => void;
  onConnectWs: () => void;
  onDisconnectWs: () => void;
}) {
  return (
    <>
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Key className="size-3.5" />
            API Configuration
          </span>
        }
        flush
      >
        <p className="border-b border-border/60 px-6 py-3 text-[11px] text-muted-foreground">
          Connect KaiBot Terminal to your KaiBot account using the API key.
        </p>
        <SettingRow
          label="API URL"
          control={
            <code className="border border-border px-1.5 py-0.5 text-[10px] font-mono">
              {KAIBOT_API_URL}
            </code>
          }
        />
        <SettingRow
          label={<Label htmlFor="apiKey" className="text-[13px] font-normal">API Key</Label>}
          control={
            <Input
              id="apiKey"
              type={obfuscateSensitive ? "text" : "password"}
              placeholder="kb_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={apiKeyValue}
              onChange={(e) => onApiKeyChange(e.target.value)}
              disabled={obfuscateSensitive}
              className="h-8 w-72 text-xs"
            />
          }
        />
        <SettingRow
          label={<Label htmlFor="autoConnect" className="text-[13px] font-normal">Auto-connect on startup</Label>}
          control={
            <Switch
              id="autoConnect"
              checked={autoConnect}
              onCheckedChange={onAutoConnectChange}
            />
          }
        />
        <div className="px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onTestConnection}
            disabled={isTesting}
            className="w-full h-8 text-[11px]"
          >
            <TestTube className="size-3 mr-1" />
            {isTesting ? 'Testing…' : 'Test Connection'}
          </Button>
        </div>
      </Section>

      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Link2 className="size-3.5" />
            Connection Status
          </span>
        }
        flush
        noBorder
      >
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: wsStatus.connected ? 'var(--kb-green)' : 'var(--kb-red)' }}
              />
              Signal Service
            </span>
          }
          control={
            <div className="flex items-center gap-2">
              <Badge variant={wsStatus.connected ? 'live' : 'neutral'}>
                {wsStatus.status.charAt(0).toUpperCase() + wsStatus.status.slice(1)}
              </Badge>
              {hasApiKey && (
                !wsStatus.connected ? (
                  <Button variant="outline" size="sm" onClick={onConnectWs} disabled={isSaving} className="h-8 text-[11px]">
                    <Link2 className="size-3 mr-1" />
                    Connect
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={onDisconnectWs} className="h-8 text-[11px]">
                    Disconnect
                  </Button>
                )
              )}
            </div>
          }
        />
      </Section>
    </>
  );
}

function NotificationsTab({
  notifPrefs,
  onToggleEnabled,
  onToggleSound,
  onToggleEventType,
  onSendTest,
}: {
  notifPrefs: NotificationPrefs;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleSound: (sound: boolean) => void;
  onToggleEventType: (type: NotificationEventType, value: boolean) => void;
  onSendTest: () => void;
}) {
  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Bell className="size-3.5" />
          Notifications
        </span>
      }
      flush
      noBorder
    >
      <p className="border-b border-border/60 px-6 py-3 text-[11px] text-muted-foreground">
        Native OS notifications for signals, fills and connection changes.
      </p>
      <SettingRow
        label={<Label htmlFor="notif-enabled" className="text-[13px] font-normal">Enable notifications</Label>}
        control={
          <Switch id="notif-enabled" checked={notifPrefs.enabled} onCheckedChange={onToggleEnabled} />
        }
      />
      <SettingRow
        label={<Label htmlFor="notif-sound" className="text-[13px] font-normal">Play sound</Label>}
        control={
          <Switch
            id="notif-sound"
            checked={notifPrefs.sound}
            onCheckedChange={onToggleSound}
            disabled={!notifPrefs.enabled}
          />
        }
      />
      <div className="px-6 pt-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        Event types
      </div>
      {(
        [
          ['signal_received', 'Signal received'],
          ['order_filled', 'Order filled'],
          ['order_rejected', 'Order rejected'],
          ['connection_lost', 'Connection lost'],
          ['connection_restored', 'Connection restored'],
          ['error', 'Errors'],
        ] as Array<[NotificationEventType, string]>
      ).map(([key, label]) => (
        <SettingRow
          key={key}
          label={<Label htmlFor={`notif-${key}`} className="text-[13px] font-normal">{label}</Label>}
          control={
            <Switch
              id={`notif-${key}`}
              checked={notifPrefs.events[key]}
              onCheckedChange={(checked: boolean) => onToggleEventType(key, checked)}
              disabled={!notifPrefs.enabled}
            />
          }
        />
      ))}
      <div className="px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onSendTest}
          disabled={!notifPrefs.enabled}
          className="w-full h-8 text-[11px]"
        >
          <Bell className="size-3 mr-1" />
          Send test notification
        </Button>
      </div>
    </Section>
  );
}

// A short list beats a 400-entry dropdown: these are the zones the desk
// actually works in. The browser's own zone is always the first option.
const TIME_ZONES = [
  'UTC',
  'Atlantic/Canary',
  'Europe/Brussels',
  'Europe/London',
  'Europe/Athens',
  'America/New_York',
  'America/Chicago',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function GeneralTab({
  notifications,
  obfuscateSensitiveData,
  onNotificationsChange,
  onObfuscateChange,
}: {
  notifications: boolean;
  obfuscateSensitiveData: boolean;
  onNotificationsChange: (checked: boolean) => void;
  onObfuscateChange: (checked: boolean) => void;
}) {
  const [brandVariant, setBrandVariant] = useAtom(brandVariantAtom);
  const isClassicMember = useAtomValue(isClassicMemberAtom);
  const [timeZone, setTimeZone] = useAtom(displayTimeZoneAtom);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Section label="General Settings" flush noBorder>
      <SettingRow
        label={<Label htmlFor="notifications" className="text-[13px] font-normal">Enable notifications</Label>}
        control={
          <Switch id="notifications" checked={notifications} onCheckedChange={onNotificationsChange} />
        }
      />
      <SettingRow
        label={<Label htmlFor="obfuscate" className="text-[13px] font-normal">Obfuscate sensitive data</Label>}
        control={
          <Switch id="obfuscate" checked={obfuscateSensitiveData} onCheckedChange={onObfuscateChange} />
        }
      />
      <SettingRow
        label={<Label htmlFor="timezone" className="text-[13px] font-normal">Timestamps</Label>}
        description={`Every page renders times in ${timeZone || browserZone}.`}
        control={
          <select
            id="timezone"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="h-7 rounded border border-border bg-transparent px-2 text-xs"
          >
            <option value="">This browser ({browserZone})</option>
            {TIME_ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        }
      />
      {!isClassicMember && (
        <SettingRow
          label={<Label htmlFor="brand-variant" className="text-[13px] font-normal">Brand</Label>}
          control={
            <select
              id="brand-variant"
              value={brandVariant}
              onChange={(e) => setBrandVariant(e.target.value as BrandVariant | "auto")}
              className="h-7 rounded border border-border bg-transparent px-2 text-xs"
            >
              <option value="auto">Auto</option>
              <option value="auric">Gold</option>
              <option value="kaibot">Blue</option>
            </select>
          }
        />
      )}
    </Section>
  );
}

// Per-account contract sizing: max contracts placed per signal, per (account,
// market root). A value of 0 disables that market for the account (kill-switch).
function AccountSizingTab() {
  const [rows, setRows] = useState<AccountSizesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Accounts whose sizing runs in synthetic mode (flagged synthetic USD position).
  const [syntheticAccounts, setSyntheticAccounts] = useState<Map<string, string>>(new Map());
  const [syntheticError, setSyntheticError] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    opsApi
      .accountSizes()
      .then((r) => {
        setRows(r);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
    syntheticUsdApi
      .list()
      .then((l) => {
        // Account → badge text. An armed row sizes on its planned floor.
        setSyntheticAccounts(
          new Map(
            l.positions
              .filter((p) => (p.status === 'open' || p.status === 'armed') && p.is_factor_basis === 1)
              .map((p) => [
                `${p.exchange}:${p.account_id}`,
                p.sizingBasis
                  ? `synthetic mode · ${p.sizingBasis.kind} · $${Math.round(p.sizingBasis.usd).toLocaleString()}`
                  : 'synthetic mode',
              ]),
          ),
        );
        setSyntheticError(false);
      })
      .catch(() => setSyntheticError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setLocal = (exchange: string, account: string, root: string, v: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.exchange === exchange && r.account === account
          ? {
              ...r,
              sizes: r.sizes.map((s) =>
                s.root === root ? { ...s, maxContracts: v, isDefault: false } : s,
              ),
            }
          : r,
      ),
    );
  };

  const save = async (exchange: string, account: string, root: string, v: number) => {
    try {
      await opsApi.updateAccountSize(exchange, account, root, v);
      const key = `${exchange}:${account}:${root}`;
      setSavedKey(key);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      toast.error('Failed to save size');
    }
  };

  if (loading) {
    return (
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Gauge className="size-3.5" />
            Per-account contract sizing
          </span>
        }
        noBorder
      >
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      </Section>
    );
  }

  if (loadError) {
    return (
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Gauge className="size-3.5" />
            Per-account contract sizing
          </span>
        }
        noBorder
      >
        <p className="text-[11px] text-[var(--kb-red)]">
          Couldn't load account sizing. Your saved sizing is unchanged.
        </p>
        <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={load}>
          Retry
        </Button>
      </Section>
    );
  }

  if (rows.length === 0) {
    return (
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Gauge className="size-3.5" />
            Per-account contract sizing
          </span>
        }
        noBorder
      >
        <p className="text-[11px] text-muted-foreground">
          Connect an exchange to configure per-account sizing.
        </p>
      </Section>
    );
  }

  return (
    <>
      <p className="border-b border-border px-6 py-3 text-[11px] text-muted-foreground">
        Cap the contracts placed per signal for each market on each broker account. Set 0 to disable a market for that account.
      </p>
      {syntheticError && (
        <p className="border-b border-border px-6 py-2 text-[11px] text-[var(--kb-amber)]">
          Couldn't check which accounts run in synthetic mode. The "synthetic mode"
          badge may be missing. Reload to retry.
        </p>
      )}
      {rows.map((r, ri) => (
        <Section
          key={`${r.exchange}:${r.account}`}
          flush
          noBorder={ri === rows.length - 1}
          label={
            <span className="flex items-center gap-2">
              <Gauge className="size-3.5" />
              {r.accountName}
              <span className="font-mono text-muted-foreground normal-case tracking-normal">
                {r.exchange} · {r.account}
              </span>
              {syntheticAccounts.has(`${r.exchange}:${r.account}`) && (
                <Link to="/synthetic-usd" className="no-underline" title="Manage synthetic USD">
                  <Badge
                    variant="secondary"
                    className="text-[10px] py-0 px-1.5 normal-case tracking-normal transition-colors hover:bg-secondary/80"
                  >
                    {syntheticAccounts.get(`${r.exchange}:${r.account}`)}
                  </Badge>
                </Link>
              )}
            </span>
          }
        >
          <DataMatrix
            rows={r.sizes}
            rowKey={(s) => `${r.exchange}:${r.account}:${s.root}`}
            columns={[
              {
                key: "market",
                header: "Market",
                cell: (s) => <span className="text-[13px]">{s.label}</span>,
              },
              {
                key: "root",
                header: "Root",
                cell: (s) => <span className="font-mono text-xs text-muted-foreground">{s.root}</span>,
              },
              {
                key: "max",
                header: "Max contracts",
                align: "right",
                cell: (s) => (
                  <Input
                    type="number"
                    min={0}
                    value={s.maxContracts}
                    onChange={(e) =>
                      setLocal(r.exchange, r.account, s.root, Math.max(0, parseInt(e.target.value || '0', 10)))
                    }
                    onBlur={(e) =>
                      save(r.exchange, r.account, s.root, Math.max(0, parseInt(e.target.value || '0', 10)))
                    }
                    className="ml-auto h-7 w-20 text-right text-xs"
                  />
                ),
              },
              {
                key: "state",
                header: "State",
                align: "right",
                cell: (s) => {
                  const key = `${r.exchange}:${r.account}:${s.root}`;
                  if (s.maxContracts === 0) {
                    return (
                      <Badge variant="error" className="text-[10px] py-0 px-1.5">
                        disabled
                      </Badge>
                    );
                  }
                  if (savedKey === key) {
                    return (
                      <span className="font-mono text-[10px] text-[var(--kb-green)]">saved</span>
                    );
                  }
                  if (s.isDefault) {
                    return (
                      <span className="font-mono text-[10px] text-muted-foreground">default</span>
                    );
                  }
                  return null;
                },
              },
            ]}
          />
        </Section>
      ))}
    </>
  );
}

// Breathing-room margin guard: before each open, keep a margin buffer free so
// existing positions stay safe. Off by default; configurable per (exchange,
// account) with a global default. Mirrors the account-sizing tab.
const FLOOR_LABEL: Record<FloorMode, string> = {
  maintenance: "Maintenance",
  initial: "Initial",
  equityPct: "Equity %",
};

function GuardEditor({
  exchange,
  account,
  title,
  subtitle,
  initial,
  onSaved,
}: {
  exchange: string;
  account: string;
  title: string;
  subtitle?: string;
  initial: MarginGuardConfigDto;
  onSaved?: () => void;
}) {
  const [cfg, setCfg] = useState<MarginGuardConfigDto>(initial);
  const [saved, setSaved] = useState(false);

  const commit = async (next: MarginGuardConfigDto) => {
    setCfg(next);
    try {
      await opsApi.updateMarginGuard(exchange, account, next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // Refresh siblings so inheriting per-account rows reflect a changed default.
      onSaved?.();
    } catch {
      toast.error("Failed to save margin guard");
    }
  };

  return (
    <Section
      flush
      label={
        <span className="flex items-center gap-2">
          <Shield className="size-3.5" />
          {title}
          {subtitle && (
            <span className="font-mono text-muted-foreground normal-case tracking-normal">
              {subtitle}
            </span>
          )}
          {saved && <span className="font-mono text-[10px] text-[var(--kb-green)]">saved</span>}
        </span>
      }
    >
      <SettingRow
        label={<Label className="text-[13px] font-normal">Breathing room</Label>}
        control={<Switch checked={cfg.enabled} onCheckedChange={(v) => commit({ ...cfg, enabled: v })} />}
      />
      <SettingRow
        label={<Label className="text-[13px] font-normal">Buffer multiple</Label>}
        control={
          <Input
            type="number"
            min={0}
            step={0.1}
            value={cfg.bufferMult}
            onChange={(e) => setCfg({ ...cfg, bufferMult: Math.max(0, parseFloat(e.target.value) || 0) })}
            onBlur={() => commit(cfg)}
            className="h-7 w-20 text-right text-xs"
          />
        }
      />
      <SettingRow
        label={<Label className="text-[13px] font-normal">Floor basis</Label>}
        control={
          <select
            value={cfg.floorMode}
            onChange={(e) => commit({ ...cfg, floorMode: e.target.value as FloorMode })}
            className="h-7 rounded border border-border bg-transparent px-2 text-xs"
          >
            {(["maintenance", "initial", "equityPct"] as FloorMode[]).map((m) => (
              <option key={m} value={m}>
                {FLOOR_LABEL[m]}
              </option>
            ))}
          </select>
        }
      />
      {cfg.floorMode === "equityPct" && (
        <SettingRow
          label={<Label className="text-[13px] font-normal">Equity fraction</Label>}
          control={
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={cfg.equityPct}
              onChange={(e) =>
                setCfg({ ...cfg, equityPct: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0)) })
              }
              onBlur={() => commit(cfg)}
              className="h-7 w-20 text-right text-xs"
            />
          }
        />
      )}
    </Section>
  );
}

function MarginGuardTab() {
  const [data, setData] = useState<MarginGuardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Refetch after any save so inherited rows pick up a changed global default.
  // Doesn't flip `loading` back on, so a refetch never flashes the spinner.
  // A failed refetch keeps the last data; the error state only gates first load.
  const reload = useCallback(() => {
    opsApi
      .marginGuards()
      .then((d) => {
        setData(d);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Shield className="size-3.5" />
            Breathing-room margin guard
          </span>
        }
        noBorder
      >
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      </Section>
    );
  }

  if (loadError && data == null) {
    return (
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Shield className="size-3.5" />
            Breathing-room margin guard
          </span>
        }
        noBorder
      >
        <p className="text-[11px] text-[var(--kb-red)]">
          Couldn't load the margin guard config. The settings shown here would not be trustworthy.
        </p>
        <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={reload}>
          Retry
        </Button>
      </Section>
    );
  }

  const defaults: MarginGuardConfigDto =
    data?.defaults ?? { enabled: false, bufferMult: 1, floorMode: "maintenance", equityPct: 0.2 };
  const globalCfg = data?.global ?? defaults;
  const accounts = data?.accounts ?? [];

  return (
    <>
      <p className="border-b border-border px-6 py-3 text-[11px] text-muted-foreground">
        Before each open, keep a margin buffer free so existing positions stay safe. Off by default, turn
        it on per account. The default below applies to any account without its own setting.
      </p>
      <GuardEditor
        key={`__default__:${JSON.stringify(globalCfg)}`}
        exchange="*"
        account="*"
        title="Default (all accounts)"
        initial={globalCfg}
        onSaved={reload}
      />
      {accounts.map((a) => (
        <GuardEditor
          key={`${a.exchange}:${a.account}:${a.isDefault ? "d" : "o"}:${JSON.stringify(a.config)}`}
          exchange={a.exchange}
          account={a.account}
          title={a.accountName}
          subtitle={`${a.exchange} · ${a.account}${a.isDefault ? " · using default" : ""}`}
          initial={a.config}
          onSaved={reload}
        />
      ))}
      {accounts.length === 0 && (
        <p className="px-6 py-3 text-[11px] text-muted-foreground">
          Connect an exchange to configure per-account overrides.
        </p>
      )}
    </>
  );
}

// Safety tab — the offline-proof panic button + the local halt flag + the opt-in
// auto-guardrails. All of it is enforced LOCALLY by the executor (it holds the
// keys + talks to the exchange directly), so it works even with the cloud down.
function PanicCard({ halt, onAfter }: { halt: HaltState; onAfter: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [andHalt, setAndHalt] = useState(true);
  const [busy, setBusy] = useState(false);
  const armed = confirm === "PANIC";

  const fire = async () => {
    if (!armed) return;
    setBusy(true);
    try {
      const report = await opsApi.panic(andHalt);
      setConfirm("");
      const msg = `Panic: closed ${report.closed}${report.failed ? `, ${report.failed} failed` : ""}${
        report.halted ? ", executor halted" : ""
      }`;
      if (report.failed > 0) toast.error(msg);
      else toast.success(msg);
      onAfter();
    } catch {
      toast.error("Panic failed");
    } finally {
      setBusy(false);
    }
  };

  const reEnable = async () => {
    setBusy(true);
    try {
      await opsApi.setHalt(false);
      toast.success("Executor re-enabled");
      onAfter();
    } catch {
      toast.error("Failed to re-enable");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      flush
      label={
        <span className="flex items-center gap-2 text-[var(--kb-red,#f7768e)]">
          <AlertTriangle className="size-3.5" />
          Panic: close all positions now
        </span>
      }
    >
      <p className="border-b border-border/60 px-6 py-3 text-[11px] text-muted-foreground">
        Closes every open position across all connected exchanges at market, directly via the exchange,
        not through the cloud. It works even if the connection is down. Type{" "}
        <span className="font-mono text-foreground">PANIC</span> to confirm.
      </p>

      {halt.halted && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-[var(--kb-red,#f7768e)]/10 px-6 py-3">
          <span className="flex items-center gap-2 text-[12px]">
            <XCircle className="size-3.5 text-[var(--kb-red,#f7768e)]" />
            Executor halted{halt.reason ? ` (${halt.reason})` : ""}. New signals are ignored.
          </span>
          <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={reEnable} disabled={busy}>
            Re-enable
          </Button>
        </div>
      )}

      <div className="space-y-3 px-6 py-3">
        <SettingRow
          label={<Label className="text-[13px] font-normal">Also halt (stop acting on new signals)</Label>}
          control={<Switch checked={andHalt} onCheckedChange={setAndHalt} />}
        />
        <div className="flex items-center gap-2">
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type PANIC"
            className="h-8 w-40 text-xs"
          />
          <Button
            size="sm"
            className="h-8 text-[11px] bg-[var(--kb-red,#f7768e)] text-white hover:opacity-90 disabled:opacity-40"
            onClick={fire}
            disabled={!armed || busy}
          >
            <AlertTriangle className="size-3 mr-1" />
            {busy ? "Closing…" : andHalt ? "Panic & halt" : "Panic"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

// Per-(exchange, account) opt-in rails. Each is OFF at 0 (the default); the user
// pre-sets a limit and the executor enforces it. Mirrors GuardEditor's commit-on-
// change pattern.
function GuardrailsEditor({
  exchange,
  account,
  title,
  subtitle,
  initial,
  onSaved,
}: {
  exchange: string;
  account: string;
  title: string;
  subtitle?: string;
  initial: GuardrailsConfigDto;
  onSaved?: () => void;
}) {
  const [cfg, setCfg] = useState<GuardrailsConfigDto>(initial);
  const [saved, setSaved] = useState(false);

  const commit = async (next: GuardrailsConfigDto) => {
    setCfg(next);
    try {
      await opsApi.updateGuardrails(exchange, account, next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved?.();
    } catch {
      toast.error("Failed to save guardrails");
    }
  };

  return (
    <Section
      flush
      label={
        <span className="flex items-center gap-2">
          <Shield className="size-3.5" />
          {title}
          {subtitle && (
            <span className="font-mono text-muted-foreground normal-case tracking-normal">{subtitle}</span>
          )}
          {saved && <span className="font-mono text-[10px] text-[var(--kb-green)]">saved</span>}
        </span>
      }
    >
      <SettingRow
        label={<Label className="text-[13px] font-normal">Max daily loss (0 = off)</Label>}
        control={
          <Input
            type="number"
            min={0}
            step={50}
            value={cfg.maxDailyLoss}
            onChange={(e) => setCfg({ ...cfg, maxDailyLoss: Math.max(0, parseFloat(e.target.value) || 0) })}
            onBlur={() => commit(cfg)}
            className="h-7 w-24 text-right text-xs"
          />
        }
      />
      <SettingRow
        label={<Label className="text-[13px] font-normal">Max concurrent positions (0 = off)</Label>}
        control={
          <Input
            type="number"
            min={0}
            step={1}
            value={cfg.maxConcurrentPositions}
            onChange={(e) =>
              setCfg({ ...cfg, maxConcurrentPositions: Math.max(0, Math.floor(parseFloat(e.target.value) || 0)) })
            }
            onBlur={() => commit(cfg)}
            className="h-7 w-24 text-right text-xs"
          />
        }
      />
      <SettingRow
        label={<Label className="text-[13px] font-normal">Max total notional (0 = off)</Label>}
        control={
          <Input
            type="number"
            min={0}
            step={500}
            value={cfg.maxTotalNotional}
            onChange={(e) => setCfg({ ...cfg, maxTotalNotional: Math.max(0, parseFloat(e.target.value) || 0) })}
            onBlur={() => commit(cfg)}
            className="h-7 w-24 text-right text-xs"
          />
        }
      />
    </Section>
  );
}

// Remote management — opt-in (default OFF). When enabled, the companion mobile
// app can monitor + manage this executor (panic/halt/guardrails/bots/subs) over
// the existing outbound connection. Disabling it again unpairs every device and
// resumes refusing commands. Mirrors the PanicCard type-to-confirm pattern for
// the disable side; enabling reveals the pairing code to enter on the phone.
function RemoteManagementCard() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");

  const reload = useCallback(async () => {
    try {
      const s = await companionApi.status();
      setStatus(s);
      if (s.enabled) {
        const c = await companionApi.pairingCode();
        setCode(c.code);
      } else {
        setCode(null);
      }
    } catch {
      /* keep last-known status — the 3s poll retries */
    }
  }, []);

  useEffect(() => {
    void reload();
    // Poll while the card is open so the pairing code (the SAS) appears as soon
    // as a phone initiates pairing, and verified devices update live.
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  const enable = async () => {
    setBusy(true);
    try {
      await companionApi.enable();
      toast.success("Remote management enabled");
      await reload();
    } catch {
      toast.error("Failed to enable remote management");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (confirm !== "DISABLE") return;
    setBusy(true);
    try {
      await companionApi.disable();
      setConfirm("");
      toast.success("Remote management disabled, devices unpaired");
      await reload();
    } catch {
      toast.error("Failed to disable remote management");
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const devices = status?.devices ?? [];

  return (
    <Section
      flush
      label={
        <span className="flex items-center gap-1.5">
          <Radio className="size-3.5" />
          Remote management
        </span>
      }
    >
      <p className="border-b border-border/60 px-6 py-3 text-[11px] text-muted-foreground">
        Off by default. When on, the KaiBot mobile app can monitor and manage this executor: panic, halt,
        guardrails, account sizes, bot and subscription lifecycle. It never places trades. Enable it, then enter the
        pairing code below in the app. Turning it off unpairs every device.
      </p>

      {!enabled && (
        <div className="px-6 py-3">
          <Button size="sm" className="h-8 text-[11px]" onClick={enable} disabled={busy}>
            <Radio className="size-3 mr-1" />
            {busy ? "Enabling…" : "Enable remote management"}
          </Button>
        </div>
      )}

      {enabled && (
        <>
          <div className="border-b border-border/60 px-6 py-3">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Lock className="size-3.5" />
              Pairing code: type this into the app to verify
            </div>
            <div className="mt-2 font-mono text-[18px] tracking-widest text-foreground">
              {code ?? "Waiting for a phone to start pairing…"}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              End-to-end encrypted. This code is computed from both devices' keys. If
              it matches what your phone shows, the connection wasn't tampered with.
              The code never leaves this screen.
            </p>
          </div>

          <div className="border-b border-border/60 px-6 py-3">
            <div className="text-[11px] text-muted-foreground">
              {devices.length === 0
                ? "No devices paired yet."
                : `${devices.length} paired device${devices.length === 1 ? "" : "s"}.`}
            </div>
            {devices.map((d) => (
              <div key={d.id} className="mt-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-foreground">
                  {d.label || d.id}
                  <span className={d.verified ? "text-[10px] text-[var(--kb-green,#9ece6a)]" : "text-[10px] text-muted-foreground"}>
                    {d.verified ? "verified ✓" : "pending…"}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={async () => {
                    await companionApi.unpair(d.id);
                    await reload();
                  }}
                >
                  Unpair
                </Button>
              </div>
            ))}
          </div>

          <div className="px-6 py-3">
            <p className="mb-2 text-[11px] text-muted-foreground">
              Type <span className="font-mono text-foreground">DISABLE</span> to turn remote management off and unpair
              all devices.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Type DISABLE"
                className="h-8 w-40 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-[11px]"
                onClick={disable}
                disabled={confirm !== "DISABLE" || busy}
              >
                <XCircle className="size-3 mr-1" />
                {busy ? "Disabling…" : "Disable"}
              </Button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

function SafetyTab() {
  const [data, setData] = useState<MarginGuardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // A failed refetch keeps the last data; the error state only gates first load.
  const reload = useCallback(() => {
    opsApi
      .marginGuards()
      .then((d) => {
        setData(d);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <Section label={<span className="flex items-center gap-1.5"><Shield className="size-3.5" />Safety</span>} noBorder>
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      </Section>
    );
  }

  if (loadError && data == null) {
    return (
      <Section label={<span className="flex items-center gap-1.5"><Shield className="size-3.5" />Safety</span>} noBorder>
        <p className="text-[11px] text-[var(--kb-red)]">
          Couldn't load the safety state. Halt and guardrail values shown here would not be trustworthy.
        </p>
        <Button variant="outline" size="sm" className="mt-2 h-7 text-[11px]" onClick={reload}>
          Retry
        </Button>
      </Section>
    );
  }

  const halt: HaltState = data?.halt ?? { halted: false, reason: null, tripped_at: null };
  const globalGuardrails: GuardrailsConfigDto =
    data?.globalGuardrails ?? { maxDailyLoss: 0, maxConcurrentPositions: 0, maxTotalNotional: 0 };
  const accounts = data?.accounts ?? [];

  return (
    <>
      <PanicCard halt={halt} onAfter={reload} />
      <RemoteManagementCard />
      <p className="border-b border-border px-6 py-3 text-[11px] text-muted-foreground">
        Auto-guardrails: your own pre-set safety rails, enforced locally. Off by default (0). Max daily loss
        flattens everything and halts when realized P&amp;L since 00:00 UTC breaches the limit; the others refuse
        an open that would breach them. The default below applies to any account without its own setting.
      </p>
      <GuardrailsEditor
        key={`__default__:${JSON.stringify(globalGuardrails)}`}
        exchange="*"
        account="*"
        title="Default (all accounts)"
        initial={globalGuardrails}
        onSaved={reload}
      />
      {accounts.map((a) => (
        <GuardrailsEditor
          key={`${a.exchange}:${a.account}:${JSON.stringify(a.guardrails)}`}
          exchange={a.exchange}
          account={a.account}
          title={a.accountName}
          subtitle={`${a.exchange} · ${a.account}`}
          initial={a.guardrails}
          onSaved={reload}
        />
      ))}
      {accounts.length === 0 && (
        <p className="px-6 py-3 text-[11px] text-muted-foreground">
          Connect an exchange to configure per-account guardrails.
        </p>
      )}
    </>
  );
}

// External alerting: a webhook (Google Chat / Slack-compatible POST {text}) that
// receives order-fail, settlement-timeout, reconciler and signal-service-down
// alerts. Config is stored in user settings; saving here saves all settings.
function AlertingTab({
  webhookUrl,
  enabled,
  obfuscateSensitive,
  onWebhookUrlChange,
  onEnabledChange,
  onSave,
}: {
  webhookUrl: string;
  enabled: boolean;
  obfuscateSensitive: boolean;
  onWebhookUrlChange: (v: string) => void;
  onEnabledChange: (v: boolean) => void;
  onSave: () => void;
}) {
  const [testing, setTesting] = useState(false);

  const sendTest = async () => {
    setTesting(true);
    try {
      const result = await opsApi.alertingTest();
      if (result.ok) toast.success('Test alert sent');
      else toast.error(result.error || 'Test alert failed');
    } catch {
      toast.error('Test alert failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Plug className="size-3.5" />
          External alerting
        </span>
      }
      flush
      noBorder
    >
      <p className="border-b border-border/60 px-6 py-3 text-[11px] text-muted-foreground">
        POSTs {`{text}`} to a webhook (works with Google Chat / Slack incoming webhooks). Alerts on order failures, settlement timeouts, reconciler mismatches and signal-service downtime.
      </p>
      <SettingRow
        label={<Label htmlFor="webhookUrl" className="text-[13px] font-normal">Webhook URL</Label>}
        control={
          <Input
            id="webhookUrl"
            type={obfuscateSensitive ? 'password' : 'text'}
            placeholder="https://chat.googleapis.com/v1/spaces/…"
            value={webhookUrl}
            onChange={(e) => onWebhookUrlChange(e.target.value)}
            className="h-8 w-80 text-xs"
          />
        }
      />
      <SettingRow
        label={<Label htmlFor="alerting-enabled" className="text-[13px] font-normal">Enable external alerting</Label>}
        control={
          <Switch id="alerting-enabled" checked={enabled} onCheckedChange={onEnabledChange} />
        }
      />
      <div className="px-6 py-3 space-y-2">
        <div className="flex gap-1.5">
          <Button size="sm" className="h-8 text-[11px]" onClick={onSave}>
            <Save className="size-3 mr-1" />
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            onClick={sendTest}
            disabled={testing || !webhookUrl}
          >
            <TestTube className="size-3 mr-1" />
            {testing ? 'Sending…' : 'Send test alert'}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Save first. The test sends to the stored URL.
        </p>
      </div>
    </Section>
  );
}
