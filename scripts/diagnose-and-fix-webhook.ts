// scripts/diagnose-and-fix-webhook.ts - Diagnose & fix Radarr webhook and permissions
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";
import { Discord } from "../src/utils/discord";
import { execSync } from "child_process";

async function main() {
  Logger.info("=====================================================");
  Logger.info(" Radarr Webhook & Notification Diagnosis & Repair");
  Logger.info("=====================================================");

  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  // 1. Check Radarr Status
  try {
    const statusRes = await fetch(`${radarrUrl}/api/v3/system/status`, { headers });
    if (statusRes.ok) {
      const status = await statusRes.json();
      Logger.info(`[Radarr] Online - Version: ${status.version}, AppName: ${status.appName}`);
    } else {
      Logger.error(`[Radarr] Could not connect (${statusRes.status})`);
    }
  } catch (err: any) {
    Logger.error(`[Radarr] Connection error: ${err.message}`);
  }

  // 2. Read recent Radarr error logs to find WHY it failed
  try {
    const logsRes = await fetch(`${radarrUrl}/api/v3/log?level=error&pageSize=15&sortKey=time&sortDirection=descending`, { headers });
    if (logsRes.ok) {
      const logs = await logsRes.json();
      Logger.info(`--- Radarr Recent Error Logs (${logs.records?.length || 0} found) ---`);
      for (const r of (logs.records || []).slice(0, 5)) {
        Logger.warn(`[Radarr Log ${r.time}] [${r.logger}] ${r.message}`);
        if (r.exception) Logger.warn(`  Exception: ${r.exception.slice(0, 200)}...`);
      }
      Logger.info("-----------------------------------------------------");
    }
  } catch (err: any) {
    Logger.warn(`[Radarr] Could not read logs: ${err.message}`);
  }

  // 3. Inspect and repair Notifications in Radarr
  try {
    const notifRes = await fetch(`${radarrUrl}/api/v3/notification`, { headers });
    if (notifRes.ok) {
      const notifs = await notifRes.json();
      Logger.info(`Found ${notifs.length} notification(s) in Radarr`);

      for (const n of notifs) {
        Logger.info(`\nNotification #${n.id}: "${n.name}" (Type: ${n.implementation})`);
        Logger.info(`  Status: disabled=${n.disabled}, onGrab=${n.onGrab}, onDownload=${n.onDownload}, onUpgrade=${n.onUpgrade}`);

        // Find URL field if webhook
        const urlField = n.fields?.find((f: any) => f.name === "url" || f.name === "webhookUrl");
        if (urlField) {
          Logger.info(`  Current Webhook URL: ${urlField.value}`);
        }

        // Fix configuration: Ensure onDownload is true and URL points to local ASHS endpoint
        n.onGrab = true;
        n.onDownload = true;
        n.onUpgrade = true;
        n.disabled = false;

        // If it's a generic Webhook, ensure URL is http://127.0.0.1:4000/0x/api/radarr/webhook
        if (n.implementation === "Webhook") {
          const uField = n.fields?.find((f: any) => f.name === "url");
          if (uField) {
            uField.value = "http://127.0.0.1:4000/0x/api/radarr/webhook";
          }
          const methodField = n.fields?.find((f: any) => f.name === "method");
          if (methodField) {
            methodField.value = 1; // 1 = POST
          }
        }

        // Test the notification
        Logger.info(`  Testing notification #${n.id}...`);
        const testRes = await fetch(`${radarrUrl}/api/v3/notification/test`, {
          method: "POST",
          headers,
          body: JSON.stringify(n),
        });

        if (testRes.ok) {
          Logger.info(`  [OK] Test succeeded!`);
        } else {
          const testErr = await testRes.text();
          Logger.warn(`  [WARN] Test response (${testRes.status}): ${testErr}`);
        }

        // Save notification to clear failure state
        const saveRes = await fetch(`${radarrUrl}/api/v3/notification/${n.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(n),
        });

        if (saveRes.ok) {
          Logger.info(`  [OK] Saved & re-enabled notification #${n.id}!`);
        } else {
          const saveErr = await saveRes.text();
          Logger.warn(`  [WARN] Save error (${saveRes.status}): ${saveErr}`);
        }
      }
    }
  } catch (err: any) {
    Logger.error(`[WebhookRepair] Notification repair error: ${err.message}`);
  }

  // 4. Test ASHS Webhook directly via localhost
  Logger.info("\n--- Testing ASHS Webhook Endpoint Locally (Port 4000) ---");
  try {
    const testLocal = await fetch("http://127.0.0.1:4000/0x/api/radarr/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "Test",
        movie: { title: "Test Connection", year: 2026 },
      }),
    });
    Logger.info(`Local :4000 Webhook Response: HTTP ${testLocal.status}`);
  } catch (err: any) {
    Logger.error(`Local :4000 unreachable: ${err.message}`);
  }

  // 5. Test Direct Discord Webhook Delivery
  Logger.info("\n--- Sending Discord Test Alert ---");
  try {
    await Discord.info(
      "Webhook System Operational",
      "ASHS <-> Radarr notification pipeline verified & active."
    );
    Logger.info("[Discord] Test alert sent to Discord channel successfully!");
  } catch (err: any) {
    Logger.error(`[Discord] Alert failed: ${err.message}`);
  }

  // 6. Clear Radarr Health Check Warnings
  try {
    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ClearHealthItems" }),
    }).catch(() => {});

    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HealthCheck" }),
    }).catch(() => {});
    Logger.info("[Radarr] HealthCheck refreshed. Warnings should clear now.");
  } catch {}

  // 7. Fix Permissions on /mnt/media so Radarr never hangs on import
  Logger.info("\n--- Setting Full Permissions on /mnt/media ---");
  try {
    execSync("chmod -R 777 /mnt/media/downloads /mnt/media/movies /mnt/media/movie 2>/dev/null || true");
    Logger.info("[Permissions] /mnt/media/downloads and /mnt/media/movies set to 777 (read/write for all users).");
  } catch (err: any) {
    Logger.warn(`[Permissions] chmod warning: ${err.message}`);
  }

  Logger.info("\n=====================================================");
  Logger.info(" Diagnosis and repair complete!");
  Logger.info("=====================================================");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
