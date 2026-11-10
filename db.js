/**
 * =============================================================================
 * SMART COLD-CHAIN MONITORING SYSTEM - DATABASE CONNECTION MODULE
 * Technology: Node.js + MySQL (mysql2/promise)
 * =============================================================================
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
  database: process.env.DB_NAME || 'cold_chain_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: true // Return date and timestamp as formatted ISO strings
};

let pool = null;

/**
 * Get or create MySQL connection pool singleton
 */
export function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

/**
 * Test connectivity to the MySQL database server
 * @returns {Promise<{connected: boolean, message: string, code?: string}>}
 */
export async function testConnection() {
  try {
    const activePool = getPool();
    const conn = await activePool.getConnection();
    try {
      await conn.query('SELECT 1');
      return {
        connected: true,
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
        message: 'Successfully connected to MySQL database.'
      };
    } finally {
      conn.release();
    }
  } catch (err) {
    let helpMsg = err.message;
    if (err.code === 'ECONNREFUSED') {
      helpMsg = `Cannot connect to MySQL at ${dbConfig.host}:${dbConfig.port}. Please ensure MySQL Server is running.`;
    } else if (err.code === 'ER_BAD_DB_ERROR') {
      helpMsg = `Database '${dbConfig.database}' does not exist. Please run database.sql in MySQL Workbench to create it.`;
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      helpMsg = `Access denied for user '${dbConfig.user}'. Please check DB_USER and DB_PASSWORD in your .env file.`;
    }
    return {
      connected: false,
      code: err.code || 'DB_ERROR',
      message: helpMsg,
      error: err.message
    };
  }
}

/**
 * Execute parameterized query safely
 * @param {string} sql - SQL query statement
 * @param {Array} params - Query parameters for prepared statement
 */
export async function query(sql, params = []) {
  const activePool = getPool();
  const [rows] = await activePool.query(sql, params);
  return rows;
}

/**
 * Initialize database schema if needed (auto-creates table if missing)
 */
export async function initDatabase() {
  try {
    const activePool = getPool();
    await activePool.query(`
      CREATE TABLE IF NOT EXISTS sensor_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        box_id VARCHAR(50) NOT NULL DEFAULT 'BOX-001',
        temperature DECIMAL(5, 2) NOT NULL,
        humidity DECIMAL(5, 2) NOT NULL,
        shock_status VARCHAR(50) NOT NULL DEFAULT 'SAFE',
        angle_status VARCHAR(50) NOT NULL DEFAULT 'SAFE',
        tamper_status VARCHAR(50) NOT NULL DEFAULT 'SAFE',
        water_status VARCHAR(50) NOT NULL DEFAULT 'SAFE',
        battery_level DECIMAL(5, 2) NOT NULL DEFAULT 85.00,
        latitude DECIMAL(10, 6) DEFAULT 11.341000,
        longitude DECIMAL(10, 6) DEFAULT 77.717200,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_recorded_at (recorded_at),
        INDEX idx_box_id (box_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const [columns] = await activePool.query(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensor_data'
    `);
    const columnNames = new Set(columns.map(column => column.COLUMN_NAME));

    if (!columnNames.has('angle_status')) {
      await activePool.query(`
        ALTER TABLE sensor_data
        ADD COLUMN angle_status VARCHAR(50) NOT NULL DEFAULT 'SAFE' AFTER shock_status
      `);
    }

    if (!columnNames.has('water_status')) {
      await activePool.query(`
        ALTER TABLE sensor_data
        ADD COLUMN water_status VARCHAR(50) NOT NULL DEFAULT 'SAFE' AFTER tamper_status
      `);
    }

    console.log('[MySQL] Schema verified: table `sensor_data` is ready.');
    return true;
  } catch (err) {
    console.warn('[MySQL] Auto-initialization notice:', err.message);
    return false;
  }
}

export default {
  getPool,
  testConnection,
  query,
  initDatabase,
  dbConfig
};
