/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        kaibot: { DEFAULT: "#EDC92D", light: "#FBF320", dark: "#CFAD00" },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          container: "hsl(var(--primary))",
        },
        surface: {
          DEFAULT: "hsl(var(--surface))",
          "container-lowest": "hsl(var(--surface-container-lowest))",
          "container-low": "hsl(var(--surface-container-low))",
          container: "hsl(var(--surface-container))",
          "container-high": "hsl(var(--surface-container-high))",
          "container-highest": "hsl(var(--surface-container-highest))",
        },
        "on-surface": {
          DEFAULT: "hsl(var(--on-surface))",
          variant: "hsl(var(--on-surface-variant))",
        },
        "on-primary": "hsl(var(--on-primary-buttons))",
        outline: {
          DEFAULT: "hsl(var(--outline))",
          variant: "hsl(var(--outline-variant))",
        },
        error: "hsl(var(--error))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      fontFamily: {
        headline: ["Geist Variable", "Geist", "system-ui", "sans-serif"],
        body: ["Geist Variable", "Geist", "system-ui", "sans-serif"],
        sans: ["Geist Variable", "Geist", "system-ui", "sans-serif"],
        heading: ["Geist Variable", "Geist", "system-ui", "sans-serif"],
        label: ["Geist Mono Variable", "Geist Mono", "ui-monospace", "monospace"],
        mono: ["Geist Mono Variable", "Geist Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0px",
        lg: "0px",
        md: "0px",
        sm: "0px",
        xl: "0px",
        full: "9999px",
      },
      keyframes: {
        ticker: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        ticker: "ticker 30s linear infinite",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
