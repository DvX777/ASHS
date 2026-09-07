// scripts/prowlarr-torrentbd-helper.ts - Inspect Prowlarr config, API key, and TorrentBD requirements
import fs from "fs";
import path from "path";
import { Logger } from "../src/utils/logger";

function findProwlarrConfig(): { configPath: string; apiKey: string; port: number } | null {
  const possiblePaths = [
    "/var/lib/prowlarr/config.xml",
    "/root/.config/Prowlarr/config.xml",
    "/home/prowlarr/.config/Prowlarr/config.xml",
    "/home/ashs/.config/Prowlarr/config.xml",
    "/opt/prowlarr/config.xml",
  ];

  // Also check /home/*/.config/Prowlarr/config.xml
  try {
    if (fs.existsSync("/home")) {
      const users = fs.readdirSync("/home");
      for (const u of users) {
        possiblePaths.push(path.join("/home", u, ".config", "Prowlarr", "config.xml"));
      }
    }
  } catch {}

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8");
        const apiKeyMatch = content.match(/<ApiKey>(.+?)<\/ApiKey>/);
        const portMatch = content.match(/<Port>(\d+)<\/Port>/);
        if (apiKeyMatch) {
          return {
            configPath: p,
            apiKey: apiKeyMatch[1],
            port: portMatch ? parseInt(portMatch[1], 10) : 9696,
          };
        }
      } catch {}
    }
  }
  return null;
}

async function main() {
  console.log("\n=====================================================");
  console.log("  PROWLARR & TORRENTBD INTEGRATION HELPER");
  console.log("=====================================================\n");

  const prowlarr = findProwlarrConfig();
  if (!prowlarr) {
    console.log("Could not auto-locate Prowlarr config.xml.");
    console.log("Please access Prowlarr web UI at: http://YOUR_SERVER_IP:9696\n");
    return;
  }

  console.log(`[Found Prowlarr Config] ${prowlarr.configPath}`);
  console.log(`[Prowlarr Port]        ${prowlarr.port}`);
  console.log(`[Prowlarr API Key]     ${prowlarr.apiKey}\n`);

  const prowlarrUrl = `http://127.0.0.1:${prowlarr.port}`;
  const headers = {
    "X-Api-Key": prowlarr.apiKey,
    "Content-Type": "application/json",
  };

  try {
    // 1. Fetch current indexers in Prowlarr
    const idxRes = await fetch(`${prowlarrUrl}/api/v1/indexer`, { headers });
    if (idxRes.ok) {
      const indexers = await idxRes.json();
      console.log(`Current Prowlarr Indexers (${indexers.length} configured):`);
      for (const idx of indexers) {
        console.log(`  - ${idx.name} (Definition: ${idx.definitionName || idx.name}, Protocol: ${idx.protocol})`);
      }
    }

    // 2. Query TorrentBD Schema
    console.log("\nChecking TorrentBD indexer schema in Prowlarr...");
    const schemaRes = await fetch(`${prowlarrUrl}/api/v1/indexer/schema`, { headers });
    if (schemaRes.ok) {
      const schemas = await schemaRes.json();
      const tbdSchema = schemas.find((s: any) => 
        (s.definitionName || "").toLowerCase().includes("torrentbd") ||
        (s.name || "").toLowerCase().includes("torrentbd")
      );

      if (tbdSchema) {
        console.log("\n[TorrentBD is SUPPORTED in Prowlarr!]");
        console.log("Fields required by Prowlarr for TorrentBD:");
        for (const field of tbdSchema.fields || []) {
          if (field.name && !field.hidden) {
            console.log(`  * ${field.label || field.name} (${field.name}) - Type: ${field.type}`);
          }
        }
      } else {
        console.log("\n[TorrentBD not found in built-in list. Might need Jackett or custom definition]");
      }
    }
  } catch (err: any) {
    Logger.error(`Error querying Prowlarr API: ${err.message}`);
  }

  console.log("\n=====================================================");
  console.log("  HOW TO ACCESS PROWLARR WEB UI");
  console.log("=====================================================");
  console.log(`1. Open in your browser: http://<YOUR_SERVER_IP>:${prowlarr.port}`);
  console.log("2. Navigate to: Indexers -> Add Indexer (+)");
  console.log("3. Search for: TorrentBD");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
