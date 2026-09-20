import { useState, type FormEvent } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

interface EmailFormProps {
  onSubmit: (email: string) => Promise<{ success: boolean; error?: string }>;
  isLoading: boolean;
}

export function EmailForm({ onSubmit, isLoading }: EmailFormProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    try {
      const result = await onSubmit(email);
      if (!result.success && result.error) {
        setError(result.error);
      }
    } catch (err) {
      setError('An unexpected error occurred. Please try again.');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex flex-col gap-5">
        <div className="space-y-1.5">
          <label htmlFor="email" className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Email Address
          </label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isLoading}
            className="input-ds h-11 text-base"
          />
        </div>
        <Button
          type="submit"
          disabled={isLoading}
          size="lg"
          className="w-full h-11"
        >
          {isLoading ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Sending…
            </>
          ) : (
            <>
              Send magic link
              <svg className="ml-2 size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </>
          )}
        </Button>
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3 text-xs font-mono flex items-center gap-2">
            <svg className="size-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <p>{error}</p>
          </div>
        )}
      </div>
    </form>
  );
}
