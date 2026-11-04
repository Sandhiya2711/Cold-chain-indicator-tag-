/**
 * =============================================================================
 * SMART COLD-CHAIN MONITORING SYSTEM - PRODUCTION BACKEND SERVER
 * Technology: Node.js + Express.js + MySQL + Blynk IoT Cloud REST API
 * =============================================================================
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

// Load environment configuration
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Blynk Configuration from .env
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN || 'r62_bOTJPlY1gnaI79geaTMmAN8TXYvN';
const BLYNK_BASE_URL = 'https://blynk.cloud/external/api';
const POLLING_INTERVAL_MS = (parseInt(process.env.POLLING_INTERVAL_SECONDS || '10', 10)) * 1000;

const DEFAULT_BOX_ID = process.env.DEFAULT_BOX_ID || 'BOX-001';
const DEFAULT_BATTERY_LEVEL = parseFloat(process.env.DEFAULT_BATTERY_LEVEL || '85.0');
const DEFAULT_LATITUDE = parseFloat(process.env.DEFAULT_LATITUDE || '11.3410');
const DEFAULT_LONGITUDE = parseFloat(process.env.DEFAULT_LONGITUDE || '77.7172');

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files directly from the workspace
app.use(express.static(__dirname));

// Internal State Tracker
const systemState = {
  dbConnected: false,
  dbError: null,
  blynkConfigured: Boolean(BLYNK_AUTH_TOKEN && BLYNK_AUTH_TOKEN.trim()),
  blynkHardwareOnline: false,
  lastPollTimestamp: null,
  lastPollSuccess: false,
  lastPollError: null,
  lastFetchedData: null,
  totalSavedRecords: 0,
  pollingIntervalSeconds: POLLING_INTERVAL_MS / 1000,
  serverStartedAt: new Date().toISOString()
};

/**
 * =============================================================================
 * BLYNK DATA INGESTION & MYSQL STORAGE ENGINE
 * =============================================================================
 */

/**
 * Check if the ESP8266 hardware is actively connected to Blynk Cloud
 */
async function checkBlynkHardwareConnected() {
  if (!systemState.blynkConfigured) return false;
  try {
    const url = `${BLYNK_BASE_URL}/isHardwareConnected?token=${encodeURIComponent(BLYNK_AUTH_TOKEN)}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const text = await res.text();
    return text.trim().toLowerCase() === 'true';
  } catch (err) {
    return false;
  }
}

/**
 * Fetch latest sensor pin values from Blynk Cloud
 * Pins:
 *  - V1: Humidity (%)
 *  - V2: Temperature (°C)
 *  - V3: Fall / Tilt Detection (MPU6050)
 *  - V4: Vibration Detection (D3)
 *  - V5: Tamper Switch (D5)
 *  - V6: Water Detection (D6)
 */
async function fetchBlynkSensorData() {
  if (!systemState.blynkConfigured) {
    throw new Error('BLYNK_AUTH_TOKEN is not configured in .env file.');
  }

  const url = `${BLYNK_BASE_URL}/get?token=${encodeURIComponent(BLYNK_AUTH_TOKEN)}&v1&v2&v3&v4&v5&v6`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Blynk API returned HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();

  const v1 = data.v1 !== undefined ? data.v1 : data.V1;
  const v2 = data.v2 !== undefined ? data.v2 : data.V2;
  const v3 = data.v3 !== undefined ? data.v3 : data.V3;
  const v4 = data.v4 !== undefined ? data.v4 : data.V4;
  const v5 = data.v5 !== undefined ? data.v5 : data.V5;
  const v6 = data.v6 !== undefined ? data.v6 : data.V6;

  // Never accept empty or null pin sets as valid readings
  if (v1 === undefined && v2 === undefined) {
    throw new Error('Blynk API returned empty or invalid virtual pin data.');
  }

  const temperature = parseFloat(v2);
  const humidity = parseFloat(v1);

  if (isNaN(temperature) || isNaN(humidity)) {
    throw new Error(`Invalid numeric readings received from Blynk (temp: ${v2}, humidity: ${v1})`);
  }

  // Shock & Angle / Tilt logic from hardware:
  // V3: MPU6050 Angle Tilt / Fall Detection (e.g. 'BOX FALL DETECTION' or 'SAFE')
  // V4: SW-420 Vibration Sensor
  const fallStr = String(v3 || 'SAFE').trim();
  const vibStr = String(v4 || 'SAFE').trim();
  const angleStatus = fallStr;
  let shockStatus = 'SAFE';
  if (vibStr !== 'SAFE') {
    shockStatus = vibStr;
  } else if (fallStr !== 'SAFE') {
    shockStatus = fallStr;
  }

  // Tamper logic (V5)
  const tamperStatus = String(v5 || 'SAFE').trim();

  // Water logic (V6)
  const waterStatus = String(v6 || 'SAFE').trim();

  return {
    temperature: Number(temperature.toFixed(2)),
    humidity: Number(humidity.toFixed(2)),
    shockStatus,
    angleStatus,
    tamperStatus,
    waterStatus,
    fallStatus: fallStr,
    vibrationStatus: vibStr,
    raw: data
  };
}

/**
 * Insert a timestamped sensor reading into MySQL
 */
async function insertSensorDataToMySQL(reading) {
  const sql = `
    INSERT INTO sensor_data 
      (box_id, temperature, humidity, shock_status, tamper_status, battery_level, latitude, longitude, recorded_at)
    VALUES 
      (?, ?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  const params = [
    DEFAULT_BOX_ID,
    reading.temperature,
    reading.humidity,
    reading.shockStatus,
    reading.tamperStatus,
    DEFAULT_BATTERY_LEVEL,
    DEFAULT_LATITUDE,
    DEFAULT_LONGITUDE
  ];

  const result = await db.query(sql, params);
  return result.insertId;
}

/**
 * Background polling cycle: Fetch from Blynk -> Store to MySQL
 */
let isPollingActive = false;

async function executePollingCycle() {
  if (isPollingActive) return; // Prevent overlapping runs
  isPollingActive = true;

  try {
    systemState.lastPollTimestamp = new Date().toISOString();

    // 1. Check hardware connectivity
    systemState.blynkHardwareOnline = await checkBlynkHardwareConnected();

    // 2. Fetch real data from Blynk IoT Cloud
    const sensorData = await fetchBlynkSensorData();
    systemState.lastFetchedData = sensorData;
    systemState.lastPollSuccess = true;
    systemState.lastPollError = null;

    // 3. Insert into MySQL (only if MySQL is available)
    try {
      const insertId = await insertSensorDataToMySQL(sensorData);
      systemState.dbConnected = true;
      systemState.dbError = null;
      systemState.totalSavedRecords += 1;

      console.log(`[Blynk -> MySQL] ✅ Record #${insertId} inserted: Temp=${sensorData.temperature}°C, Hum=${sensorData.humidity}%, Shock=${sensorData.shockStatus}, Angle=${sensorData.angleStatus}, Tamper=${sensorData.tamperStatus}`);
    } catch (dbErr) {
      systemState.dbConnected = false;
      systemState.dbError = dbErr.message;
      console.warn(`[Blynk -> MySQL] ⚠️ Database insertion error: ${dbErr.message}`);
    }

  } catch (blynkErr) {
    systemState.lastPollSuccess = false;
    systemState.lastPollError = blynkErr.message;
    console.warn(`[Blynk -> MySQL] ⚠️ Blynk fetch skipped: ${blynkErr.message}`);
  } finally {
    isPollingActive = false;
  }
}

/**
 * =============================================================================
 * REST API ENDPOINTS
 * =============================================================================
 */

/**
 * GET /api/sensors/latest
 * Returns the most recent record from MySQL or latest live telemetry
 */
app.get('/api/sensors/latest', async (req, res) => {
  try {
    let latestRecord = null;

    // Query latest record from MySQL database
    if (systemState.dbConnected) {
      try {
        const rows = await db.query(
          `SELECT * FROM sensor_data ORDER BY recorded_at DESC, id DESC LIMIT 1`
        );
        if (rows && rows.length > 0) {
          latestRecord = rows[0];
        }
      } catch (err) {
        systemState.dbConnected = false;
        systemState.dbError = err.message;
      }
    }

    // Fallback to latest memory fetched data if DB has no records yet or is connecting
    if (!latestRecord && systemState.lastFetchedData) {
      latestRecord = {
        id: 0,
        box_id: DEFAULT_BOX_ID,
        temperature: systemState.lastFetchedData.temperature,
        humidity: systemState.lastFetchedData.humidity,
        shock_status: systemState.lastFetchedData.shockStatus,
        angle_status: systemState.lastFetchedData.angleStatus || 'SAFE',
        tamper_status: systemState.lastFetchedData.tamperStatus,
        battery_level: DEFAULT_BATTERY_LEVEL,
        latitude: DEFAULT_LATITUDE,
        longitude: DEFAULT_LONGITUDE,
        recorded_at: systemState.lastPollTimestamp || new Date().toISOString(),
        source: 'Blynk Memory Cache'
      };
    }

    return res.json({
      success: true,
      data: latestRecord,
      hardwareOnline: systemState.blynkHardwareOnline,
      lastUpdated: latestRecord ? latestRecord.recorded_at : systemState.lastPollTimestamp,
      databaseConnected: systemState.dbConnected
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/sensors/history
 * Returns historical records from MySQL with optional date filters and limit
 * Query parameters:
 *  - limit: default 50, max 500
 *  - startDate: YYYY-MM-DD or ISO string
 *  - endDate: YYYY-MM-DD or ISO string
 *  - boxId: filter by specific box_id
 */
app.get('/api/sensors/history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 500);
    const boxId = req.query.boxId || null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    let sql = `SELECT * FROM sensor_data WHERE 1=1`;
    const params = [];

    if (boxId) {
      sql += ` AND box_id = ?`;
      params.push(boxId);
    }

    if (startDate) {
      sql += ` AND recorded_at >= ?`;
      params.push(startDate.includes('T') ? startDate : `${startDate} 00:00:00`);
    }

    if (endDate) {
      sql += ` AND recorded_at <= ?`;
      params.push(endDate.includes('T') ? endDate : `${endDate} 23:59:59`);
    }

    sql += ` ORDER BY recorded_at DESC, id DESC LIMIT ?`;
    params.push(limit);

    let rows = [];
    if (systemState.dbConnected) {
      try {
        rows = await db.query(sql, params);
      } catch (err) {
        systemState.dbConnected = false;
        systemState.dbError = err.message;
      }
    }

    return res.json({
      success: true,
      count: rows.length,
      limit,
      databaseConnected: systemState.dbConnected,
      data: rows
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/sensors/status
 * Returns system health, MySQL connection status, and Blynk IoT connection status
 */
app.get('/api/sensors/status', async (req, res) => {
  // Re-verify database connectivity
  const dbStatus = await db.testConnection();
  systemState.dbConnected = dbStatus.connected;
  if (!dbStatus.connected) {
    systemState.dbError = dbStatus.message;
  }

  let totalCount = 0;
  if (systemState.dbConnected) {
    try {
      const countRes = await db.query(`SELECT COUNT(*) as total FROM sensor_data`);
      totalCount = countRes[0]?.total || 0;
      systemState.totalSavedRecords = totalCount;
    } catch (e) {
      // ignore
    }
  }

  return res.json({
    success: true,
    status: {
      server: {
        status: 'online',
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: systemState.serverStartedAt
      },
      database: {
        connected: systemState.dbConnected,
        host: db.dbConfig.host,
        port: db.dbConfig.port,
        database: db.dbConfig.database,
        user: db.dbConfig.user,
        totalRecords: totalCount,
        error: systemState.dbError
      },
      blynk: {
        configured: systemState.blynkConfigured,
        hardwareConnected: systemState.blynkHardwareOnline,
        lastPollTimestamp: systemState.lastPollTimestamp,
        lastPollSuccess: systemState.lastPollSuccess,
        lastPollError: systemState.lastPollError
      },
      polling: {
        intervalSeconds: systemState.pollingIntervalSeconds,
        active: true
      }
    }
  });
});

/**
 * Backward compatibility endpoints for existing UI features
 */
app.get('/api/telemetry-history', async (req, res) => {
  try {
    let rows = [];
    if (systemState.dbConnected) {
      try {
        rows = await db.query(`SELECT * FROM sensor_data ORDER BY recorded_at DESC, id DESC LIMIT 100`);
      } catch (e) {
        // ignore
      }
    }

    // Format to match existing telemetry format
    const formatted = rows.map(r => ({
      id: r.id,
      timestamp: r.recorded_at,
      temperature: parseFloat(r.temperature),
      humidity: parseFloat(r.humidity),
      fall_status: r.shock_status.includes('FALL') ? 'BOX FALL DETECTION' : 'SAFE',
      vibration_status: r.shock_status.includes('VIBRATION') ? 'VIBRATION DETECTION' : 'SAFE',
      tamper_status: r.tamper_status,
      water_status: 'SAFE',
      battery_level: parseFloat(r.battery_level),
      source: 'ESP8266 Live Hardware (MySQL)',
      integrity: (r.shock_status === 'SAFE' && r.tamper_status === 'SAFE' && r.temperature >= 2 && r.temperature <= 8) ? 98 : 65
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/log-telemetry', async (req, res) => {
  try {
    const b = req.body || {};
    const temp = parseFloat(b.temperature) || 0;
    const hum = parseFloat(b.humidity) || 0;
    const shock = b.fall ? 'BOX FALL DETECTION' : (b.vibration ? 'VIBRATION DETECTION' : 'SAFE');
    const tamper = b.tamper ? 'BOX TAMPER IS LOSE' : 'SAFE';

    let insertId = 0;
    if (systemState.dbConnected) {
      try {
        const sql = `
          INSERT INTO sensor_data 
            (box_id, temperature, humidity, shock_status, tamper_status, battery_level, latitude, longitude, recorded_at)
          VALUES 
            (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        const r = await db.query(sql, [
          b.boxId || DEFAULT_BOX_ID,
          temp,
          hum,
          shock,
          tamper,
          b.battery || DEFAULT_BATTERY_LEVEL,
          b.latitude || DEFAULT_LATITUDE,
          b.longitude || DEFAULT_LONGITUDE
        ]);
        insertId = r.insertId;
      } catch (e) {
        // ignore
      }
    }

    res.json({ success: true, insertId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Root route - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Receiver route - serve receiver.html
app.get('/receiver', (req, res) => {
  res.sendFile(path.join(__dirname, 'receiver.html'));
});

/**
 * =============================================================================
 * SERVER INITIALIZATION & BACKGROUND DAEMON STARTUP
 * =============================================================================
 */
async function startServer() {
  console.log('-------------------------------------------------------------');
  console.log('🚀 Starting Smart Cold-Chain Backend Server...');
  console.log(`🌐 Server Port: ${PORT}`);
  console.log(`⏱️ Blynk Polling Interval: ${systemState.pollingIntervalSeconds}s`);
  console.log(`📦 Box ID: ${DEFAULT_BOX_ID}`);
  console.log('-------------------------------------------------------------');

  // 1. Test & initialize MySQL connection
  const dbStatus = await db.testConnection();
  systemState.dbConnected = dbStatus.connected;
  if (dbStatus.connected) {
    console.log(`[MySQL] ✅ Connected to MySQL Server at ${db.dbConfig.host}:${db.dbConfig.port} (Database: ${db.dbConfig.database})`);
    await db.initDatabase();
  } else {
    systemState.dbError = dbStatus.message;
    console.warn(`[MySQL] ⚠️ Note: ${dbStatus.message}`);
    console.warn(`[MySQL] 👉 You can start MySQL Server and run database.sql in MySQL Workbench anytime.`);
  }

  // 2. Start Express HTTP Server
  app.listen(PORT, () => {
    console.log(`[HTTP] ✅ Server running live at: http://localhost:${PORT}`);
    console.log(`[HTTP] 📊 Latest API:  http://localhost:${PORT}/api/sensors/latest`);
    console.log(`[HTTP] 📜 History API: http://localhost:${PORT}/api/sensors/history`);
    console.log(`[HTTP] 🩺 Status API:  http://localhost:${PORT}/api/sensors/status`);
    console.log('-------------------------------------------------------------');
  });

  // 3. Run first Blynk polling cycle immediately
  await executePollingCycle();

  // 4. Start background polling timer
  setInterval(executePollingCycle, POLLING_INTERVAL_MS);
  console.log(`[Background Service] 🔄 Polling Blynk every ${systemState.pollingIntervalSeconds}s and storing in MySQL.`);
}

startServer().catch(err => {
  console.error('Fatal Server Startup Error:', err);
});
