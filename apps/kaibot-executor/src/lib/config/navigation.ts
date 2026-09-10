import {
  LayoutDashboard,
  Layers,
  Briefcase,
  RefreshCw,
  Bot,
  Bell,
  Settings as SettingsIcon,
  BarChart2,
  Gauge,
  GitCompare,
  Coins,
  LineChart,
  LucideIcon,
} from '@/lib/icons';

export type NavigationItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

export const mainNavigation: NavigationItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard, exact: true },
  { name: 'Chart', href: '/terminal', icon: LineChart },
  { name: 'Positions', href: '/positions', icon: Layers },
  { name: 'Portfolio', href: '/portfolio', icon: Briefcase },
  { name: 'Synthetic USD', href: '/synthetic-usd', icon: Coins },
  { name: 'Exchanges', href: '/exchanges', icon: RefreshCw },
  { name: 'Markets', href: '/markets', icon: BarChart2 },
  { name: 'Analytics', href: '/analytics', icon: Gauge },
  { name: 'Subscriptions', href: '/subscriptions', icon: Bot },
  { name: 'Activity', href: '/activity', icon: Bell },
  { name: 'Reconciliation', href: '/reconciliation', icon: GitCompare },
  { name: 'Settings', href: '/settings', icon: SettingsIcon },
];
