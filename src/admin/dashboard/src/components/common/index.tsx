// src/components/common/index.tsx — All reusable primitives

import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import styles from "./common.module.css";

// ── Button ───────────────────────────────────────────────────────────────────
type BtnVariant = "primary" | "secondary" | "danger" | "ghost";
interface BtnProps {
  variant?: BtnVariant;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  children: ReactNode;
  type?: "button" | "submit";
}
export function Btn({ variant = "secondary", onClick, disabled, loading, small, children, type = "button" }: BtnProps) {
  return (
    <button
      type={type}
      className={`${styles.btn} ${styles[variant]} ${small ? styles.small : ""}`}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? <Spinner size={12} /> : children}
    </button>
  );
}

// ── Badge ────────────────────────────────────────────────────────────────────
const BADGE_COLORS: Record<string, string> = {
  ready: "var(--success)", downloading: "var(--accent-teal)",
  failed: "var(--error)", pending: "var(--warning)",
  queued: "var(--warning)", unavailable: "var(--muted)",
  resolving: "var(--accent-amber)", active: "var(--accent-teal)",
  done: "var(--success)", cancelled: "var(--muted)",
  movie: "var(--primary)", tv: "var(--accent-amber)",
};
export function Badge({ status }: { status: string }) {
  const color = BADGE_COLORS[status] ?? "var(--muted)";
  return (
    <span className={styles.badge} style={{ background: color + "22", color, borderColor: color + "44" }}>
      {status}
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.card} ${className ?? ""}`}>{children}</div>;
}

// ── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size, borderWidth: size < 16 ? 2 : 3 }}
    />
  );
}

// ── Progress Bar ─────────────────────────────────────────────────────────────
export function ProgressBar({ value, max = 100, color }: { value: number; max?: number; color?: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className={styles.progressTrack}>
      <div
        className={styles.progressFill}
        style={{ width: pct + "%", background: color ?? "var(--primary)" }}
      />
    </div>
  );
}

// ── Storage Gauge ────────────────────────────────────────────────────────────
export function StorageGauge({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? "var(--error)" : pct > 70 ? "var(--warning)" : "var(--success)";
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeHeader}>
        <span className={styles.gaugeLabel}>{label}</span>
        <span className={styles.gaugePct} style={{ color }}>{pct}%</span>
      </div>
      <ProgressBar value={pct} color={color} />
      <div className={styles.gaugeFooter}>
        <span>{fmtBytes(used)} used</span>
        <span>{fmtBytes(total)} total</span>
      </div>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>{title}</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────────────────────
type ToastType = "success" | "error" | "info";
interface ToastMsg { id: number; type: ToastType; message: string }
let _setToast: ((t: ToastMsg) => void) | null = null;
export function toast(message: string, type: ToastType = "info") {
  _setToast?.({ id: Date.now(), type, message });
}
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  useEffect(() => {
    _setToast = (t) => {
      setToasts((prev) => [...prev, t]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 3500);
    };
    return () => { _setToast = null; };
  }, []);
  if (!toasts.length) return null;
  const COLORS: Record<ToastType, string> = { success: "var(--success)", error: "var(--error)", info: "var(--accent-teal)" };
  return (
    <div className={styles.toastContainer}>
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast} style={{ borderLeftColor: COLORS[t.type] }}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue} style={{ color: color ?? "var(--on-dark)" }}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

// ── Section Header ───────────────────────────────────────────────────────────
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {action}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function fmtBytes(b: number): string {
  if (!b) return "0 B";
  if (b > 1e12) return (b/1e12).toFixed(2)+" TB";
  if (b > 1e9)  return (b/1e9).toFixed(2)+" GB";
  if (b > 1e6)  return (b/1e6).toFixed(0)+" MB";
  return (b/1e3).toFixed(0)+" KB";
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff/1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
