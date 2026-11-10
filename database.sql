-- =============================================================================
-- SMART COLD-CHAIN MONITORING SYSTEM - DATABASE SETUP SCRIPT
-- Database: cold_chain_db
-- Table:    sensor_data
-- Execution: Open and execute this script inside MySQL Workbench.
-- =============================================================================

-- 1. Create Database if it does not already exist
CREATE DATABASE IF NOT EXISTS cold_chain_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE cold_chain_db;

-- 2. Create the sensor_data table to continuously store telemetry from Blynk IoT & ESP8266
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

-- 3. Verify Table Creation
DESCRIBE sensor_data;

-- 4. Sample Query to test data retrieval
SELECT * FROM sensor_data ORDER BY recorded_at DESC LIMIT 10;
