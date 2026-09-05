import { useState } from "react";
import { api } from "../api/client";
import { Btn, SectionHeader, toast, Card } from "../components/common";
import styles from "./SettingsPage.module.css";

export function SettingsPage() {
  const [loading, setLoading] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<any>, msg: string) => {
    setLoading(key);
    try { await fn(); toast(msg, "success"); }
    catch (e: any) { toast(e.message, "error"); }
    finally { setLoading(null); }
  };

  const actions = [
    { key: "srr",    label: "Smart Re-Resolve",       desc: "Run the full SRR healing cycle now",                     fn: () => api.triggerSRR(),   msg: "SRR started" },
    { key: "ingest", label: "Trigger Discovery",       desc: "Re-scan MovieBox for new content to add to the queue",   fn: () => api.triggerIngest(),msg: "Discovery triggered" },
    { key: "meta",   label: "Refresh TMDB Metadata",  desc: "Update poster, overview, genres for up to 300 titles",   fn: () => api.triggerMeta(),  msg: "Metadata refresh started" },
    { key: "temp",   label: "Clean Temp Directory",    desc: "Remove all .part and temp download files from NVMe",     fn: () => api.cleanTemp(),    msg: "Temp cleaned" },
  ];

  return (
    <div className={styles.page}>
      <SectionHeader title="System Settings" />

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>System Actions</h2>
        <div className={styles.actionGrid}>
          {actions.map((a) => (
            <Card key={a.key} className={styles.actionCard}>
              <p className={styles.actionLabel}>{a.label}</p>
              <p className={styles.actionDesc}>{a.desc}</p>
              <Btn small variant="primary" loading={loading === a.key} onClick={() => run(a.key, a.fn, a.msg)}>
                Run
              </Btn>
            </Card>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle} style={{ color: "var(--error)" }}>Danger Zone</h2>
        <Card className={styles.dangerCard}>
          <div className={styles.dangerRow}>
            <div>
              <p className={styles.actionLabel}>Reset All Failed Media</p>
              <p className={styles.actionDesc}>Set all failed media back to pending for re-discovery</p>
            </div>
            <Btn small variant="danger" loading={loading === "reset-failed"}
              onClick={() => {
                if (!confirm("Reset ALL failed media to pending?")) return;
                run("reset-failed",
                  () => api.post("/system/reset-failed"),
                  "All failed media reset to pending");
              }}>
              Reset
            </Btn>
          </div>
          <div className={styles.dangerRow}>
            <div>
              <p className={styles.actionLabel}>Purge Access Logs</p>
              <p className={styles.actionDesc}>Delete all access log records from the database</p>
            </div>
            <Btn small variant="danger" loading={loading === "purge-logs"}
              onClick={() => {
                if (!confirm("Purge all access logs?")) return;
                run("purge-logs",
                  () => api.post("/system/purge-logs"),
                  "Access logs purged");
              }}>
              Purge
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}