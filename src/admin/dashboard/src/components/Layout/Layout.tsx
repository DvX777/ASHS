import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useSSE } from "../../api/sse";
import { useQueueStore } from "../../store/queueStore";
import { useSRRStore } from "../../store/srrStore";
import { useDashStore } from "../../store/dashboardStore";
import { useEffect } from "react";
import styles from "./Layout.module.css";

export function Layout({ title }: { title?: string }) {
  const { setStats, setJobProgress, removeJob } = useQueueStore();
  const { setRunning, setComplete, addLine } = useSRRStore();
  const refresh = useDashStore((s) => s.refresh);

  useEffect(() => { refresh(); }, []);

  useSSE(({ type, data }) => {
    if (type === "queue:stats") setStats(data);
    if (type === "download:progress") setJobProgress(data.jobId, data);
    if (type === "download:complete") { removeJob(data.jobId); refresh(); }
    if (type === "download:failed") removeJob(data.jobId);
    if (type === "srr:started") setRunning(data.runId);
    if (type === "srr:complete") { setComplete(data); refresh(); }
    if (type === "srr:progress") addLine(`> ${data.message}`);
    if (type === "system:health") refresh();
  });

  return (
    <div className={styles.shell}>
      <Sidebar />
      <div className={styles.main}>
        <Header title={title || "ASHS Admin"} />
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}