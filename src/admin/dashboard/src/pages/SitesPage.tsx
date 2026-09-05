import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Btn, Badge, SectionHeader, toast, Card } from "../components/common";
import styles from "./SitesPage.module.css";

export function SitesPage() {
  const [sites, setSites] = useState<any[]>([]);
  const [form, setForm] = useState({ domain: "", name: "", rate_limit_rpm: 120 });
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const load = async () => {
    const r = await api.sites().catch(() => []);
    setSites(r);
  };

  useEffect(() => { load(); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setAdding(true);
    try {
      await api.addSite(form);
      toast("Site added", "success"); setShowAdd(false);
      setForm({ domain: "", name: "", rate_limit_rpm: 120 });
      load();
    } catch (err: any) { toast(err.message, "error"); }
    finally { setAdding(false); }
  };

  const revoke = async (id: number) => {
    if (!confirm("Revoke access for this site?")) return;
    await api.deleteSite(id); toast("Site revoked", "info"); load();
  };

  const copy = (key: string, id: number) => {
    navigator.clipboard.writeText(key);
    setCopied(id); setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Approved Sites"
        action={<Btn small variant="primary" onClick={() => setShowAdd(!showAdd)}>+ Add Site</Btn>}
      />

      {showAdd && (
        <Card>
          <form onSubmit={add} className={styles.addForm}>
            <input className={styles.inp} placeholder="domain.com" value={form.domain}
              onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} required />
            <input className={styles.inp} placeholder="Site name" value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <input className={styles.inp} type="number" placeholder="Rate limit RPM" value={form.rate_limit_rpm}
              onChange={(e) => setForm((f) => ({ ...f, rate_limit_rpm: Number(e.target.value) }))} />
            <Btn type="submit" variant="primary" loading={adding}>Add</Btn>
            <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
          </form>
        </Card>
      )}

      <Card>
        <table className={styles.table}>
          <thead>
            <tr><th>Domain</th><th>Name</th><th>API Key</th><th>Rate Limit</th><th>Status</th><th>Created</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {sites.length === 0 && <tr><td colSpan={7} className={styles.empty}>No approved sites</td></tr>}
            {sites.map((s) => (
              <tr key={s.id}>
                <td className={styles.domain}>{s.domain}</td>
                <td>{s.name ?? "—"}</td>
                <td>
                  <div className={styles.keyRow}>
                    <span className={styles.key}>{s.api_key?.slice(0,16)}...</span>
                    <Btn small variant="ghost" onClick={() => copy(s.api_key, s.id)}>
                      {copied === s.id ? "✓" : "Copy"}
                    </Btn>
                  </div>
                </td>
                <td>{s.rate_limit_rpm} RPM</td>
                <td><Badge status={s.enabled ? "ready" : "failed"} /></td>
                <td className={styles.muted}>{s.created_at?.slice(0,10)}</td>
                <td><Btn small variant="danger" onClick={() => revoke(s.id)}>Revoke</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}