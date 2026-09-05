import { useEffect, useState } from "react";
import { useDashStore } from "../store/dashboardStore";
import { useQueueStore } from "../store/queueStore";
import { useSRRStore } from "../store/srrStore";
import { api } from "../api/client";
import { Btn, StatCard, StorageGauge, SectionHeader, Badge, fmtBytes, toast, Card } from "../components/common";
import styles from "./OverviewPage.module.css";

export function OverviewPage() {
  const { stats, refresh } = useDashStore();
  const { active, pending, failed, done } = useQueueStore();
  const { status: srrStatus, lastResult } = useSRRStore();
  const [healer, setHealer] = useState<any>(null);
  const [healLoading, setHealLoading] = useState<string | null>(null);

  useEffect(() => {
    refresh();
    api.healerScan().then(setHealer).catch(() => {});
  }, []);

  const fix = async (type: string) => {
    setHealLoading(type);
    try {
      const r = await api.healerFix(type);
      toast(`Fixed: ${r.fixed} item(s)`, "success");
      refresh();
      const h = await api.healerScan();
      setHealer(h);
    } catch (e: any) {
      toast(e.message, "error");
    } finally { setHealLoading(null); }
  };

  const lib = stats?.library;

  return (
    <div className={styles.page}>
      {/* Stat cards */}
      <div className={styles.statGrid}>
        <StatCard label="Movies" value={lib?.movies ?? "—"} color="var(--primary)" />
        <StatCard label="TV Shows" value={lib?.tv_shows ?? "—"} color="var(--accent-amber)" />
        <StatCard label="Total Files" value={lib?.total_files?.toLocaleString() ?? "—"} color="var(--accent-teal)" />
        <StatCard label="Library Size" value={lib?.total_bytes ? fmtBytes(lib.total_bytes) : "—"} />
      </div>

      <div className={styles.twoCol}>
        {/* Queue + Storage */}
        <div className={styles.leftCol}>
          <Card>
            <SectionHeader title="Download Queue" />
            <div className={styles.queueGrid}>
              <div className={styles.qStat}><span style={{ color: "var(--accent-teal)" }}>{active}</span><small>Active</small></div>
              <div className={styles.qStat}><span style={{ color: "var(--warning)" }}>{pending}</span><small>Pending</small></div>
              <div className={styles.qStat}><span style={{ color: "var(--error)" }}>{failed}</span><small>Failed</small></div>
              <div className={styles.qStat}><span style={{ color: "var(--success)" }}>{done.toLocaleString()}</span><small>Done</small></div>
            </div>
          </Card>

          <Card>
            <SectionHeader title="Storage" />
            <div className={styles.storageList}>
              {stats?.storage?.hdd && (
                <StorageGauge
                  label="HDD (Media)"
                  used={stats.storage.hdd.used_bytes}
                  total={stats.storage.hdd.total_bytes}
                />
              )}
              {stats?.storage?.nvme && (
                <StorageGauge
                  label="NVMe (Temp)"
                  used={stats.storage.nvme.used_bytes}
                  total={stats.storage.nvme.total_bytes}
                />
              )}
            </div>
          </Card>

          {/* SRR mini card */}
          <Card>
            <SectionHeader
              title="Smart Re-Resolve"
              action={
                <Btn small variant="secondary" onClick={() => api.triggerSRR().then(() => toast("SRR triggered", "info"))}>
                  Run Now
                </Btn>
              }
            />
            <div className={styles.srrMini}>
              <div>
                <span className={styles.srrStatus} style={{ color: srrStatus === "running" ? "var(--accent-teal)" : "var(--success)" }}>
                  ● {srrStatus === "running" ? "Running..." : "Idle"}
                </span>
              </div>
              {lastResult && (
                <div className={styles.srrResult}>
                  Last: {lastResult.found} found / {lastResult.fixed} fixed ({(lastResult.durationMs/1000).toFixed(1)}s)
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Health issues */}
        <div className={styles.rightCol}>
          <Card>
            <SectionHeader
              title="Health Issues"
              action={
                healer?.issues?.some((i: any) => i.count > 0) && (
                  <Btn small variant="primary" loading={healLoading === "all"} onClick={() => fix("all")}>
                    Fix All
                  </Btn>
                )
              }
            />
            <div className={styles.issueList}>
              {healer?.issues?.length === 0 && (
                <p className={styles.allGood}>✓ All systems healthy</p>
              )}
              {healer?.issues?.map((issue: any) => (
                <div key={issue.type} className={`${styles.issue} ${issue.count > 0 ? styles.issueActive : styles.issueOk}`}>
                  <div className={styles.issueMeta}>
                    <span className={styles.issueName}>{issue.label}</span>
                    <span className={styles.issueCount} style={{ color: issue.count > 0 ? "var(--warning)" : "var(--success)" }}>
                      {issue.count > 0 ? `⚠ ${issue.count}` : "✓"}
                    </span>
                  </div>
                  {issue.count > 0 && (
                    <Btn small variant="ghost" loading={healLoading === issue.type} onClick={() => fix(issue.type)}>
                      Fix
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* System info */}
          <Card>
            <SectionHeader title="System" />
            <div className={styles.sysList}>
              <div className={styles.sysRow}>
                <span>Uptime</span>
                <span>{stats ? Math.floor(stats.uptime_seconds / 3600) + "h " + Math.floor((stats.uptime_seconds % 3600) / 60) + "m" : "—"}</span>
              </div>
              <div className={styles.sysRow}>
                <span>Tunnel</span>
                <Badge status={stats?.tunnel === "connected" ? "ready" : "failed"} />
              </div>
              <div className={styles.sysRow}>
                <span>Memory</span>
                <span>{stats?.memory ? fmtBytes(stats.memory.rss) : "—"}</span>
              </div>
              <div className={styles.sysRow}>
                <span>Failed Media</span>
                <span style={{ color: (stats?.library?.failed_media ?? 0) > 0 ? "var(--warning)" : "var(--success)" }}>
                  {stats?.library?.failed_media ?? 0}
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
