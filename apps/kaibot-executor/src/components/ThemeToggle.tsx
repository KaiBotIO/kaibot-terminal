import { Button } from "@kaibot/shared";
import { Sun, Moon, Laptop } from "@/lib/icons";
import { useTheme } from "@/components/ThemeProvider";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const handleToggle = () => {
    if (theme === 'light') {
      setTheme('dark');
    } else if (theme === 'dark') {
      setTheme('system');
    } else {
      setTheme('light');
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={handleToggle}
      className="size-8 font-mono"
    >
      {theme === 'light' ? (
        <Sun className="size-4" />
      ) : theme === 'dark' ? (
        <Moon className="size-4" />
      ) : (
        <Laptop className="size-4" />
      )}
    </Button>
  );
}