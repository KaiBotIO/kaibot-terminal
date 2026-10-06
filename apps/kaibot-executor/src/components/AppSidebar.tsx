import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { navigationFor, NavigationItem } from '@/lib/config/navigation';
import { useIsViewer } from '@/hooks/useRole';

function isItemActive(pathname: string, item: NavigationItem) {
  if (item.exact) {
    return pathname === item.href;
  }
  return pathname === item.href || pathname.startsWith(item.href + '/');
}

export default function AppSidebar() {
  const location = useLocation();
  const pathname = location.pathname;
  const items = navigationFor(useIsViewer());

  return (
    <aside className="w-12 shrink-0 flex flex-col items-center py-2 gap-0.5 bg-[hsl(var(--surface-container-low))] border-r border-border/60">
      {items.map((item) => {
        const isActive = isItemActive(pathname, item);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            to={item.href}
            title={item.name}
            aria-label={item.name}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative w-9 h-9 flex items-center justify-center transition-colors',
              isActive
                ? 'bg-[hsl(var(--surface-container-high))] text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--surface-container-high))]/60',
            )}
          >
            {/* Active indicator accent */}
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary"
              />
            )}
            <Icon className="size-4" />
          </Link>
        );
      })}
    </aside>
  );
}
