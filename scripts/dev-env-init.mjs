#!/usr/bin/env node

/**
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * DEV Environment Initialization Script
 * Sets up a local SQLite database for development and testing
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ENV_PATH = path.join(__dirname, '..', '.dev-env');
const DB_PATH = path.join(DEV_ENV_PATH, 'db.sqlite3');
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

console.log('BoltLink DEV Environment Initialization\n');

// Ensure .dev-env directory exists
if (!fs.existsSync(DEV_ENV_PATH)) {
  fs.mkdirSync(DEV_ENV_PATH, { recursive: true });
  console.log(`Created .dev-env directory`);
}

// Remove existing database if present
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log(`Removed existing database`);
}

// Create new SQLite database with schema
console.log(`Initializing SQLite database at ${DB_PATH}`);

try {
  // Read the schema
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  
  // Use sqlite3 CLI to create the database and apply schema
  // First, create the database file
  fs.writeFileSync(DB_PATH, '');
  
  // Apply schema using Node's built-in SQLite if available, or fall back to CLI
  try {
    // Try using better-sqlite3 if installed via wrangler
    const sqlite3Cmd = `sqlite3 "${DB_PATH}"`;
    
    // Split schema into individual statements and execute each
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    const sqlContent = statements.map(s => s + ';').join('\n');
    
    // Create a temp SQL file
    const tempSqlPath = path.join(DEV_ENV_PATH, 'init.sql');
    fs.writeFileSync(tempSqlPath, sqlContent);
    
    // Execute using sqlite3 CLI
    execSync(`sqlite3 "${DB_PATH}" < "${tempSqlPath}"`, { stdio: 'inherit' });
    
    // Clean up temp file
    fs.unlinkSync(tempSqlPath);
    
    console.log(`Applied schema to database`);
  } catch (err) {
    console.error(`Could not apply schema: ${err.message}`);
    console.log(`Try installing sqlite3: brew install sqlite3`);
    process.exit(1);
  }
} catch (error) {
  console.error(`Error initializing database:`, error.message);
  process.exit(1);
}

// Create fixtures directory
const fixturesPath = path.join(DEV_ENV_PATH, 'fixtures');
if (!fs.existsSync(fixturesPath)) {
  fs.mkdirSync(fixturesPath, { recursive: true });
}

// Create test-results directory
const resultsPath = path.join(DEV_ENV_PATH, 'test-results');
if (!fs.existsSync(resultsPath)) {
  fs.mkdirSync(resultsPath, { recursive: true });
}

console.log(`Created fixtures directory`);
console.log(`Created test-results directory`);

// Seed initial test data
console.log(`\nSeeding test data...`);

const seedData = `
INSERT INTO links (slug, target_url, clicks_total, created_at, updated_at) VALUES
('dev-test-1', 'https://example.com', 0, datetime('now'), datetime('now')),
('dev-test-2', 'https://github.com/vitorgfaustino/boltlink', 5, datetime('now'), datetime('now')),
('dev-internal', 'https://internal.example.com/api', 0, datetime('now'), datetime('now'));
`;

try {
  const seedPath = path.join(DEV_ENV_PATH, 'seed.sql');
  fs.writeFileSync(seedPath, seedData);
  execSync(`sqlite3 "${DB_PATH}" < "${seedPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(seedPath);
  console.log(`Seeded test data (3 links)`);
} catch (error) {
  console.warn(`Could not seed data: ${error.message}`);
}

// Verify database
console.log(`\nVerifying database...`);
try {
  const countResult = execSync(`sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM links; SELECT COUNT(*) FROM link_groups;"`, { encoding: 'utf8' });
  const lines = countResult.trim().split('\n');
  console.log(`Links table: ${lines[0]} records`);
  console.log(`Link groups table: ${lines[1]} records`);
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  process.exit(1);
}

console.log(`\nDEV environment ready.\n`);
console.log(`Database location: ${DB_PATH}`);
console.log(`\nNext steps:`);
console.log(`  npm run dev          # Start local worker`);
console.log(`  npm test             # Run all tests`);
console.log(`  npm run dev-reset    # Reset database to initial state`);
console.log(``);
