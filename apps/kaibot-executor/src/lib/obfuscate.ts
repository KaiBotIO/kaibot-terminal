/**
 * Obfuscates sensitive data like API keys, passwords, etc.
 */
export function obfuscateText(text: string, showChars: number = 4): string {
  if (!text || text.length <= showChars * 2) {
    return text;
  }
  
  const start = text.substring(0, showChars);
  const end = text.substring(text.length - showChars);
  const middle = '*'.repeat(Math.min(text.length - showChars * 2, 20));
  
  return `${start}${middle}${end}`;
}

/**
 * Obfuscates an API key, showing only the prefix and last few characters
 */
export function obfuscateApiKey(apiKey: string): string {
  if (!apiKey) return apiKey;
  
  // For API keys starting with kb_, show kb_xxxx...xxxx
  if (apiKey.startsWith('kb_')) {
    return obfuscateText(apiKey, 6);
  }
  
  // For other API keys, show first 4 and last 4 characters
  return obfuscateText(apiKey, 4);
}

/**
 * Obfuscates an email address
 */
export function obfuscateEmail(email: string): string {
  if (!email || !email.includes('@')) return email;
  
  const [localPart, domain] = email.split('@');
  const obfuscatedLocal = obfuscateText(localPart, 2);
  
  return `${obfuscatedLocal}@${domain}`;
}

/**
 * Obfuscates a URL, showing only the protocol and domain
 */
export function obfuscateUrl(url: string): string {
  if (!url) return url;
  
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}/*****`;
  } catch {
    return obfuscateText(url, 8);
  }
}