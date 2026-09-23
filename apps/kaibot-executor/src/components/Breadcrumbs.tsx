import { useLocation } from 'react-router-dom';
import { ChevronRight, Home } from '@/lib/icons';
import { mainNavigation } from '@/lib/config/navigation';

export function Breadcrumbs() {
  const location = useLocation();
  const pathname = location.pathname;

  // Find the current page from navigation
  const currentPage = mainNavigation.find(item => item.href === pathname);
  
  // Generate breadcrumb items
  const items = [];
  
  if (pathname === '/') {
    items.push({ name: 'Dashboard', href: '/', icon: Home });
  } else {
    items.push({ name: 'Dashboard', href: '/', icon: Home });
    if (currentPage) {
      items.push({ name: currentPage.name, href: currentPage.href, icon: currentPage.icon });
    }
  }

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-x-2 text-sm font-label">
        {items.map((item, index) => (
          <li key={item.href} className="flex items-center">
            {index > 0 && (
              <ChevronRight className="size-4 mx-2 text-muted-foreground" />
            )}
            <div className="flex items-center gap-2">
              <item.icon className="size-4 text-muted-foreground" />
              <span className={index === items.length - 1 ? "font-medium" : "text-muted-foreground"}>
                {item.name}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}