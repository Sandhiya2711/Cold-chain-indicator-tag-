import { resolve } from 'path';
import { defineConfig } from 'vite';
import fs from 'fs';
import { exec } from 'child_process';

const DB_FILE = resolve(__dirname, 'telemetry_database.json');
const BLYNK_TOKEN = "r62_bOTJPlY1gnaI79geaTMmAN8TXYvN";

function telemetryDatabasePlugin() {
  return {
    name: 'telemetry-database-api',
    configureServer(server) {
      let lastSavedSignature = "";

      // Background Server Polling from Hardware & Auto-Sync to Python SQLite Database
      setInterval(async () => {
        try {
          const url = `https://blynk.cloud/external/api/get?token=${BLYNK_TOKEN}&v1&v2&v3&v4&v5&v6`;
          const res = await fetch(url);
          if (!res.ok) return;
          const data = await res.json();

          const v1 = data.v1 !== undefined ? data.v1 : data.V1;
          const v2 = data.v2 !== undefined ? data.v2 : data.V2;
          const v3 = data.v3 !== undefined ? data.v3 : data.V3;
          const v4 = data.v4 !== undefined ? data.v4 : data.V4;
          const v5 = data.v5 !== undefined ? data.v5 : data.V5;
          const v6 = data.v6 !== undefined ? data.v6 : data.V6;

          const currentSig = `${v1}_${v2}_${v3}_${v4}_${v5}_${v6}`;

          if (currentSig !== lastSavedSignature) {
            lastSavedSignature = currentSig;

            let db = [];
            if (fs.existsSync(DB_FILE)) {
              try {
                db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
              } catch (e) {
                db = [];
              }
            }

            const tempNum = parseFloat(v2) || 0;
            const humNum = parseFloat(v1) || 0;
            const isAlert = (v3 !== "SAFE" || v4 !== "SAFE" || v5 !== "SAFE" || v6 !== "SAFE" || tempNum > 8.0 || tempNum < 2.0);

            const newRecord = {
              id: db.length + 1,
              timestamp: new Date().toISOString(),
              temperature: tempNum,
              humidity: humNum,
              fall_status: String(v3 || "SAFE"),
              vibration_status: String(v4 || "SAFE"),
              tamper_status: String(v5 || "SAFE"),
              water_status: String(v6 || "SAFE"),
              source: "ESP8266 Live Hardware",
              integrity: isAlert ? 55 : 98
            };

            db.push(newRecord);
            if (db.length > 500) db = db.slice(-500);

            // 1. Save to JSON store
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

            // 2. Automatically sync into Python SQLite Database (coldchain_telemetry.db)
            exec('python sync_database.py', (err) => {
              if (err) console.warn("SQLite auto-sync info:", err.message);
              else console.log(`[Python SQL Sync] Record #${newRecord.id} saved to coldchain_telemetry.db`);
            });
          }
        } catch (err) {
          // ignore transient errors
        }
      }, 3000);

      // 1. GET /api/telemetry-history -> Returns all stored historical telemetry JSON
      server.middlewares.use('/api/telemetry-history', (req, res) => {
        if (req.method === 'GET') {
          let data = [];
          if (fs.existsSync(DB_FILE)) {
            try {
              data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
            } catch (e) {
              data = [];
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(data, null, 2));
          return;
        }
      });

      // 2. POST /api/log-telemetry -> Appends new incoming telemetry packet
      server.middlewares.use('/api/log-telemetry', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const record = JSON.parse(body);
              let data = [];
              if (fs.existsSync(DB_FILE)) {
                try {
                  data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
                } catch (e) {
                  data = [];
                }
              }

              record.id = data.length + 1;
              if (!record.timestamp) {
                record.timestamp = new Date().toISOString();
              }

              data.push(record);
              if (data.length > 500) data = data.slice(-500);

              fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

              // Trigger Python SQLite sync
              exec('python sync_database.py');

              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.end(JSON.stringify({ status: 'success', totalRecords: data.length }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [telemetryDatabasePlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        receiver: resolve(__dirname, 'receiver.html')
      }
    }
  }
});
