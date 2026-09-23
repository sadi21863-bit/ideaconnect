"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState, useEffect } from "react";
import {
  Home, FlaskConical, Archive, Bot,
  ChevronLeft, ChevronRight, LogOut, Menu, X,
} from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import NotificationCenter from "@/components/NotificationCenter";
import { ThemeToggle } from "@/components/ThemeToggle";

const NAV_ITEMS = [
  { href: "/",               label: "Home",          icon: Home,         isLab: false },
  { href: "/ai-lab",         label: "AI Lab",        icon: FlaskConical, isLab: true  },
  { href: "/ai-lab/archive", label: "Archives",      icon: Archive,      isLab: false },
  { href: "/agents",          label: "Agents",        icon: Bot,          isLab: false },
] as const;

const NO_SIDEBAR_PREFIXES = ["/sign-in", "/sign-up"];

export default function Sidebar({
  currentUserId,
  currentHandle,
}: {
  currentUserId: string;
  currentHandle: string;
}) {
  const pathname    = usePathname();
  const [collapsed,  setCollapsed]  = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const reduce = useReducedMotion();

  const isLanding  = pathname === "/";
  const isAuthPage = NO_SIDEBAR_PREFIXES.some((p) => pathname.startsWith(p));
  if (isLanding || isAuthPage) return null;

  function isActive(href: string) {
    if (href === "/")               return pathname === "/";
    if (href === "/ai-lab")         return pathname === "/ai-lab";
    if (href === "/ai-lab/archive") return pathname.startsWith("/ai-lab/archive");
    return pathname.startsWith(href);
  }

  const navItemCls = (href: string) =>
    `flex items-center gap-3 px-3 min-h-9 rounded-lg transition ${
      isActive(href)
        ? "bg-ic-accent/10 text-ic-ink font-semibold"
        : "text-ic-muted hover:bg-ic-paper hover:text-ic-ink"
    }`;

  const collapsedNavItemCls = (href: string) =>
    `w-10 h-10 rounded-lg flex items-center justify-center transition ${
      isActive(href)
        ? "bg-ic-accent/10 text-ic-ink"
        : "text-ic-muted hover:text-ic-ink hover:bg-ic-paper"
    }`;

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onNavigate}
          className={navItemCls(item.href)}
        >
          <item.icon size={16} className={`shrink-0 ${isActive(item.href) ? "text-ic-ink" : "text-ic-muted"}`} />
          <span className="flex-1 text-[13px]">{item.label}</span>
          {item.isLab && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-ic-accent-bright animate-pulse" />
              <span className="font-mono text-[9px] text-ic-accent uppercase font-semibold tracking-wide">Live</span>
            </span>
          )}
        </Link>
      ))}
    </>
  );

  return (
    <>
      {/* ── Mobile hamburger ─────────────────────────────────────────── */}
      {!mobileOpen && (
        <button
          className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-ic-card text-ic-ink shadow-card"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}

      {/* ── Mobile drawer ────────────────────────────────────────────── */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="md:hidden fixed inset-0 ic-drawer-overlay z-40"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="md:hidden fixed top-0 left-0 h-full w-64 bg-ic-card border-r border-ic-rule/50 z-50 flex flex-col"
              initial={{ x: reduce ? 0 : -256 }} animate={{ x: 0 }} exit={{ x: reduce ? 0 : -256 }}
              transition={{ duration: reduce ? 0 : 0.25, ease: "easeOut" }}
            >
              <div className="flex items-center justify-between px-[18px] py-4 border-b border-ic-rule/30">
                <Link href="/" onClick={() => setMobileOpen(false)}>
                  <span className="font-display text-[17px] font-medium text-ic-ink tracking-tight leading-none">
                    ideaconnect<span className="text-ic-accent-bright">.</span>
                  </span>
                </Link>
                <button aria-label="Close navigation" className="text-ic-muted hover:text-ic-ink transition" onClick={() => setMobileOpen(false)}>
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex items-center gap-2 px-[18px] py-3 border-b border-ic-rule/30">
                <div className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs font-bold font-mono text-white uppercase bg-ic-accent">
                  {currentHandle ? currentHandle.charAt(0) : "?"}
                </div>
                <div className="font-mono text-[12px] font-semibold text-ic-ink truncate">@{currentHandle}</div>
              </div>

              <div className="px-[14px] flex-1 overflow-y-auto pt-3">
                <nav className="flex flex-col gap-0.5">
                  <NavLinks onNavigate={() => setMobileOpen(false)} />
                </nav>
                {currentUserId && <div className="mt-2"><NotificationCenter userId={currentUserId} /></div>}
              </div>

              <div className="border-t border-ic-rule/30 px-[14px] py-3 flex flex-col gap-3">
                <ThemeToggle collapsed={false} />
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="flex items-center gap-2 text-sm font-mono text-ic-muted hover:text-ic-ink transition"
                >
                  <LogOut size={16} /> Sign out
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Desktop sidebar ──────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex fixed left-0 top-0 h-screen bg-ic-paper-deep border-r border-ic-rule/30
          flex-col z-50 transition-all duration-300
          ${collapsed ? "w-14 items-center py-3 gap-2" : "w-64"}`}
      >
        {collapsed ? (
          <>
            <Link href="/" title="IdeaConnect">
              <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
                <circle cx="7" cy="11" r="2.6" stroke="currentColor" strokeWidth="1.4" className="text-ic-ink" />
                <circle cx="15" cy="11" r="2.6" fill="#22C55E" stroke="currentColor" strokeWidth="1.4" className="text-ic-ink" />
                <path d="M9.6 11 H12.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="text-ic-ink" />
              </svg>
            </Link>
            <button
              onClick={() => setCollapsed(false)}
              title="Expand sidebar"
              className="w-7 h-7 rounded flex items-center justify-center text-ic-muted hover:text-ic-ink transition"
            >
              <ChevronRight size={13} />
            </button>
            <div className="w-7 h-px bg-ic-rule/30" />
            <div className="flex flex-col gap-1">
              {NAV_ITEMS.map((item) => (
                <Link key={item.href} href={item.href} title={item.label} className={`${collapsedNavItemCls(item.href)} relative`}>
                  <item.icon size={17} />
                  {item.isLab && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-ic-accent-bright animate-pulse" />}
                </Link>
              ))}
            </div>
            <div className="flex-1" />
            <div className="w-7 h-px bg-ic-rule/30" />
            <ThemeToggle collapsed={true} />
            <div className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold font-mono text-white uppercase bg-ic-accent">
              {currentHandle ? currentHandle.charAt(0) : "?"}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-[18px] pt-5 pb-4">
              <Link href="/" className="font-display text-[17px] font-medium text-ic-ink tracking-tight leading-none">
                ideaconnect<span className="text-ic-accent-bright">.</span>
              </Link>
              <button
                onClick={() => setCollapsed(true)}
                title="Collapse sidebar"
                className="rounded flex items-center justify-center text-ic-muted hover:text-ic-ink transition w-[26px] h-[26px]"
              >
                <ChevronLeft size={13} />
              </button>
            </div>

            <div className="px-[14px] flex-1 overflow-y-auto">
              <nav className="flex flex-col gap-0.5">
                <NavLinks />
              </nav>
              {currentUserId && <div className="mt-2"><NotificationCenter userId={currentUserId} /></div>}
            </div>

            <div className="border-t border-ic-rule/30 px-[14px] py-3 flex items-center gap-2">
              <div className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-xs font-bold font-mono text-white uppercase bg-ic-accent">
                {currentHandle ? currentHandle.charAt(0) : "?"}
              </div>
              <div className="font-mono text-[12px] font-semibold text-ic-ink truncate flex-1">@{currentHandle}</div>
              <ThemeToggle collapsed={true} />
              <button onClick={() => signOut({ callbackUrl: "/" })} title="Sign out" className="text-ic-muted hover:text-ic-ink transition p-1">
                <LogOut size={14} />
              </button>
            </div>
          </>
        )}
      </aside>

      <div className={`hidden md:block transition-all duration-300 ${collapsed ? "w-14" : "w-64"} shrink-0`} />
    </>
  );
}
