"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

const LINKS: { href: string; label: string; icon: string }[] = [
  { href: "/", label: "Overview", icon: "▦" },
  { href: "/screening", label: "Screening", icon: "🔎" },
  { href: "/positions", label: "Positions", icon: "📂" },
  { href: "/management", label: "Management", icon: "⚙" },
  { href: "/monitor", label: "Monitor", icon: "📡" },
  { href: "/learning", label: "Learning", icon: "📈" },
  { href: "/memory", label: "Memory Graph", icon: "🧠" },
  { href: "/config", label: "Config", icon: "🔧" },
];

type Theme = "dark" | "light";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = document.documentElement.getAttribute("data-theme");
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  const toggle = () => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return [theme, toggle];
}

function usePositionCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    const fetchCount = async () => {
      try {
        const res = await fetch("/api/positions", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (active && Array.isArray(data)) {
          setCount(data.length);
        }
      } catch {
        /* ignore */
      }
    };
    fetchCount();
    const t = setInterval(fetchCount, 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return count;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const positionCount = usePositionCount();

  return (
    <>
      {/* Mobile toggle */}
      <button
        className={cn(
          "hidden fixed top-3.5 left-3.5 z-[100]",
          "bg-[var(--panel)] border border-[var(--border)] rounded-10",
          "p-[9px_11px] text-[var(--text)] text-lg cursor-pointer shadow-md-dark",
          "max-md:flex items-center justify-center"
        )}
        onClick={() => setOpen(!open)}
        aria-label="Toggle sidebar"
      >
        {open ? "✕" : "☰"}
      </button>

      {/* Mobile overlay */}
      <div
        className={cn(
          "hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-[49]",
          open && "max-md:block"
        )}
        onClick={() => setOpen(false)}
      />

      {/* Sidebar nav */}
      <nav
        className={cn(
          "w-[232px] flex-shrink-0 flex flex-col",
          "bg-[var(--glass-bg)] backdrop-blur-xl",
          "border-r border-[var(--glass-border)]",
          "p-[20px_14px] relative z-10",
          /* gradient border accent on the right */
          "after:content-[''] after:absolute after:top-0 after:right-0 after:bottom-0 after:w-px",
          "after:bg-gradient-to-b after:from-transparent after:via-[var(--border)] after:to-transparent",
          /* mobile styles */
          "max-md:fixed max-md:top-0 max-md:left-0 max-md:h-screen max-md:z-50",
          "max-md:w-[260px] max-md:transition-transform max-md:duration-300 max-md:ease-[var(--ease-out)]",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 px-2.5 pb-5">
          <span className="text-2xl text-accent drop-shadow-[0_0_8px_var(--accent-glow)]">
            ◎
          </span>
          <div>
            <div className="font-bold text-[14px] tracking-tight">Meteora DLMM</div>
            <div className="text-[11px] text-[var(--muted)] tracking-[0.02em] uppercase font-medium">
              agent dashboard
            </div>
          </div>
        </div>

        {/* Nav links */}
        <div className="flex flex-col gap-0.5">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2.5 rounded-10",
                  "text-[13.5px] font-medium text-[var(--muted)]",
                  "transition-all duration-150 ease-[var(--ease-out)]",
                  "relative",
                  "hover:bg-[var(--panel-2)] hover:text-[var(--text)]",
                  active && [
                    "bg-accent-glow text-accent font-semibold",
                    /* left accent bar */
                    "before:content-[''] before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2",
                    "before:w-[3px] before:h-5 before:rounded-r-[3px] before:bg-accent",
                    "before:shadow-[0_0_12px_var(--accent-glow)]",
                  ]
                )}
                onClick={() => setOpen(false)}
              >
                <span className="w-5 text-center text-[15px]">{l.icon}</span>
                {l.label}
                {l.href === "/positions" && positionCount > 0 && (
                  <span
                    className={cn(
                      "ml-auto bg-accent text-white text-[10px] font-bold",
                      "px-[7px] py-0.5 rounded-full min-w-5 text-center",
                      "shadow-glow-accent"
                    )}
                  >
                    {positionCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {/* Footer */}
        <div className="mt-auto text-[11px] text-[var(--muted)] p-2 flex flex-col gap-2">
          <button
            className={cn(
              "flex items-center gap-2 w-full",
              "bg-[var(--panel-2)] border border-[var(--border)] text-[var(--text-secondary)]",
              "rounded-10 px-3 py-[9px] text-[12.5px] font-medium cursor-pointer",
              "transition-all duration-150 ease-[var(--ease-out)]",
              "hover:border-[var(--border-hover)] hover:bg-[var(--panel-3)] hover:text-[var(--text)]"
            )}
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <span>{theme === "dark" ? "☀" : "☾"}</span>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <span className="pl-1 text-[10px] uppercase tracking-[0.06em] font-medium">
            read-only &middot; live
          </span>
        </div>
      </nav>
    </>
  );
}
