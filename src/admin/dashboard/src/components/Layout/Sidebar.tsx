import { NavLink } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { useQueueStore } from "../../store/queueStore";
import styles from "./Sidebar.module.css";

const NAV = [
  { to: "/",        icon: "⬡", label: "Overview"  },
  { to: "/library", icon: "◫", label: "Library"   },
  { to: "/queue",   icon: "↓", label: "Queue"     },
  { to: "/healer",  icon: "✦", label: "Healer"    },
  { to: "/srr",     icon: "⟳", label: "SRR"       },
  { to: "/upload",  icon: "↑", label: "Upload"    },
  { to: "/sites",   icon: "◈", label: "Sites"     },
  { to: "/logs",    icon: "≡", label: "Logs"      },
  { to: "/settings",icon: "⚙", label: "Settings"  },
];

export function Sidebar() {
  const logout = useAuthStore((s) => s.logout);
  const { active, pending } = useQueueStore();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.spike}>✦</span>
        <span className={styles.brandName}>ASHS</span>
      </div>

      <nav className={styles.nav}>
        {NAV.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ""}`
            }
          >
            <span className={styles.icon}>{icon}</span>
            <span className={styles.label}>{label}</span>
            {label === "Queue" && (active + pending) > 0 && (
              <span className={styles.badge}>{active + pending}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className={styles.bottom}>
        <div className={styles.statusDot} title="System running" />
        <button className={styles.logoutBtn} onClick={() => logout()}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
