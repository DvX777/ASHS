import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { Layout } from "./components/Layout/Layout";
import { ToastContainer } from "./components/common";
import { LoginPage }    from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { LibraryPage }  from "./pages/LibraryPage";
import { QueuePage }    from "./pages/QueuePage";
import { HealerPage }   from "./pages/HealerPage";
import { SRRPage }      from "./pages/SRRPage";
import { RadarrPage }   from "./pages/RadarrPage";
import { UploadPage }   from "./pages/UploadPage";
import { SitesPage }    from "./pages/SitesPage";
import { LogsPage }     from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { authed, loading, checkAuth } = useAuthStore();
  useEffect(() => { checkAuth(); }, []);
  if (loading) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: "28px", color: "var(--on-dark-soft)" }}>
        ✦ ASHS
      </div>
    </div>
  );
  if (!authed) return <LoginPage />;
  return <>{children}</>;
}

export default function App() {
  return (
    <HashRouter>
      <AuthGuard>
        <Routes>
          <Route element={<Layout title="Overview" />}>
            <Route path="/"         element={<OverviewPage />} />
            <Route path="/library"  element={<LibraryPage />} />
            <Route path="/queue"    element={<QueuePage />} />
            <Route path="/healer"   element={<HealerPage />} />
            <Route path="/srr"      element={<SRRPage />} />
            <Route path="/radarr"   element={<RadarrPage />} />
            <Route path="/upload"   element={<UploadPage />} />
            <Route path="/sites"    element={<SitesPage />} />
            <Route path="/logs"     element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*"         element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGuard>
      <ToastContainer />
    </HashRouter>
  );
}
