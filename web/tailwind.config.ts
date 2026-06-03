import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#08080d",
          subtle: "#0c0c14",
        },
        panel: {
          DEFAULT: "#101018",
          2: "#16161f",
          3: "#1c1c28",
        },
        border: {
          DEFAULT: "#1e1e2e",
          hover: "#2a2a40",
          accent: "rgba(99, 102, 241, 0.3)",
        },
        text: {
          DEFAULT: "#e8eaf0",
          secondary: "#b0b4c4",
        },
        muted: "#6b7094",
        accent: {
          DEFAULT: "#818cf8",
          glow: "rgba(129, 140, 248, 0.15)",
        },
        positive: {
          DEFAULT: "#34d399",
          glow: "rgba(52, 211, 153, 0.12)",
        },
        negative: {
          DEFAULT: "#f87171",
          glow: "rgba(248, 113, 113, 0.12)",
        },
        warning: {
          DEFAULT: "#fbbf24",
          glow: "rgba(251, 191, 36, 0.12)",
        },
        info: {
          DEFAULT: "#22d3ee",
          glow: "rgba(34, 211, 238, 0.12)",
        },
        linked: {
          DEFAULT: "#34d399",
          glow: "rgba(52, 211, 153, 0.12)",
        },
        cluster: {
          DEFAULT: "#fbbf24",
          glow: "rgba(251, 191, 36, 0.12)",
        },
        isolated: {
          DEFAULT: "#f87171",
          glow: "rgba(248, 113, 113, 0.12)",
        },
        pool: "#60a5fa",
        cycle: "#a78bfa",
        token: "#f472b6",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", { letterSpacing: "0.06em", lineHeight: "1.4" }],
      },
      borderRadius: {
        "14": "14px",
        "10": "10px",
      },
      boxShadow: {
        "sm-dark": "0 1px 2px rgba(0, 0, 0, 0.3)",
        "md-dark": "0 4px 12px rgba(0, 0, 0, 0.25)",
        "lg-dark": "0 8px 32px rgba(0, 0, 0, 0.35)",
        "glow": "0 0 20px rgba(129, 140, 248, 0.08)",
        "glow-positive": "0 0 8px rgba(52, 211, 153, 0.3)",
        "glow-negative": "0 0 8px rgba(248, 113, 113, 0.3)",
        "glow-warning": "0 0 8px rgba(251, 191, 36, 0.3)",
        "glow-accent": "0 0 8px rgba(129, 140, 248, 0.15)",
      },
      animation: {
        "status-pulse": "status-pulse 2s ease-out infinite",
        "pulse-dot": "pulse-dot 1s ease-in-out infinite",
        "pulse-cycle": "pulse-cycle 2s ease-in-out infinite",
        "live-pulse": "live-pulse 0.6s ease-out",
      },
      keyframes: {
        "status-pulse": {
          "0%, 100%": { opacity: "0", transform: "scale(1)" },
          "50%": { opacity: "0.3", transform: "scale(1.5)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
        "pulse-cycle": {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 8px rgba(52, 211, 153, 0.12)" },
          "50%": { opacity: "0.5", boxShadow: "0 0 16px rgba(52, 211, 153, 0.12)" },
        },
        "live-pulse": {
          "0%": { opacity: "0.5", transform: "scale(0.98)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
