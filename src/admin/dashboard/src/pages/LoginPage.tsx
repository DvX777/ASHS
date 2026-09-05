import { useState } from "react";
import { useAuthStore } from "../store/authStore";
import { api } from "../api/client";
import styles from "./LoginPage.module.css";

export function LoginPage() {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const setAuthed = useAuthStore((s) => s.setAuthed);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      await api.login(key);
      setAuthed(true);
    } catch {
      setError("Invalid admin key");
    } finally { setLoading(false); }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.spike}>✦</span>
          <span className={styles.name}>ASHS</span>
        </div>
        <h1 className={styles.title}>Admin Access</h1>
        <p className={styles.sub}>Enter your admin key to continue</p>

        <form onSubmit={submit} className={styles.form}>
          <input
            className={styles.input}
            type="password"
            placeholder="Admin key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
          {error && <p className={styles.error}>{error}</p>}
          <button className={styles.btn} type="submit" disabled={loading || !key}>
            {loading ? "Checking..." : "Sign in →"}
          </button>
        </form>
      </div>
    </div>
  );
}