export interface AuthContextType {
  isAuthenticated: boolean;
  isPending: boolean;
  isLoading: boolean;
  login: (email: string, name?: string) => Promise<{ success: boolean; error?: string; magicLink?: string }>;
  logout: () => Promise<{ success: boolean; error?: string }>;
  user: { name: string; roles: string[] } | null;
}