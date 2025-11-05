#!/usr/bin/env node
/**
 * Setup script for MongoDB MCP Server
 * Helps users configure connections and test the setup
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('🚀 MongoDB MCP Server Setup\n');

  console.log('This script will help you configure your MongoDB connections.');
  console.log('You can create connections for different environments (local, dev, prod, etc.)\n');

  const setupType = await question('How would you like to set up connections?\n1. Quick setup (local MongoDB)\n2. Custom setup\n3. Copy existing connections.json\nChoose (1-3): ');

  switch (setupType.trim()) {
    case '1':
      await quickSetup();
      break;
    case '2':
      await customSetup();
      break;
    case '3':
      await copyExistingSetup();
      break;
    default:
      console.log('Invalid option. Using quick setup...');
      await quickSetup();
  }

  await testConnection();

  console.log('\n✅ Setup complete!');
  console.log('\n🚀 Next steps:');
  console.log('1. Build the project: npm run build');
  console.log('2. Test the server: npm run dev');
  console.log('3. Add this server to your Claude configuration');

  rl.close();
}

async function quickSetup() {
  console.log('\n📝 Quick Setup - Local MongoDB');

  const host = await question('MongoDB host (localhost): ') || 'localhost';
  const port = await question('MongoDB port (27017): ') || '27017';
  const database = await question('Database name (test): ') || 'test';

  const config = {
    connections: {
      local: {
        name: 'Local Development',
        host: host,
        port: parseInt(port),
        database: database,
        options: {
          retryWrites: true,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 10000
        },
        notes: 'Local MongoDB instance',
        collections: {
          users: 'User accounts',
          products: 'Product catalog',
          orders: 'Order data'
        }
      }
    },
    defaultConnection: 'local'
  };

  await saveConfig(config);
  console.log('✅ Local connection configured');
}

async function customSetup() {
  console.log('\n📝 Custom Setup');

  const config = {
    connections: {},
    defaultConnection: null
  };

  let addMore = true;
  let isFirst = true;

  while (addMore) {
    console.log(`\n--- ${isFirst ? 'First' : 'Additional'} Connection ---`);

    const name = await question('Connection name (e.g., "local", "prod"): ');
    const displayName = await question('Display name: ');
    const host = await question('Host (use ${ENV_VAR} for environment variables): ');
    const port = await question('Port: ');
    const database = await question('Database name: ');

    const needsAuth = await question('Requires authentication? (y/N): ');

    const connection = {
      name: displayName,
      host: host,
      port: parseInt(port),
      database: database,
      options: {
        retryWrites: true,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000
      }
    };

    if (needsAuth.toLowerCase() === 'y') {
      connection.username = await question('Username (use ${ENV_VAR} for environment variables): ');
      connection.password = await question('Password (use ${ENV_VAR} for environment variables): ');
      connection.authSource = await question('Auth source (admin): ') || 'admin';
      connection.authMechanism = 'SCRAM-SHA-256';
      connection.options.readPreference = 'secondaryPreferred';
    }

    const notes = await question('Notes (optional): ');
    if (notes) {
      connection.notes = notes;
    }

    config.connections[name] = connection;

    if (isFirst) {
      config.defaultConnection = name;
      isFirst = false;
    }

    const more = await question('\nAdd another connection? (y/N): ');
    addMore = more.toLowerCase() === 'y';
  }

  await saveConfig(config);
  console.log('✅ Custom connections configured');
}

async function copyExistingSetup() {
  console.log('\n📂 Copy Existing Setup');

  const sourcePath = await question('Path to existing connections.json: ');

  try {
    const content = await fs.readFile(sourcePath, 'utf-8');
    const config = JSON.parse(content);

    // Validate basic structure
    if (!config.connections || typeof config.connections !== 'object') {
      throw new Error('Invalid connections.json format');
    }

    await saveConfig(config);
    console.log('✅ Existing connections copied');
  } catch (error) {
    console.error('❌ Error copying connections:', error.message);
    console.log('Falling back to quick setup...');
    await quickSetup();
  }
}

async function saveConfig(config) {
  const configPath = path.join(__dirname, 'mongo-connections.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`💾 Configuration saved to: ${configPath}`);

  // Also create example .env file if needed
  const envVars = findEnvironmentVariables(config);
  if (envVars.length > 0) {
    const envContent = [
      '# MongoDB MCP Server Environment Variables',
      '# Copy this file to .env and fill in your actual values',
      '',
      ...envVars.map(varName => `${varName}=your_value_here`)
    ].join('\n');

    const envPath = path.join(__dirname, '.env.example');
    await fs.writeFile(envPath, envContent);
    console.log(`📝 Example environment file created: ${envPath}`);
    console.log('⚠️  Make sure to create a .env file with your actual values');
  }
}

function findEnvironmentVariables(config) {
  const envVars = new Set();
  const envVarPattern = /\$\{([^}]+)\}/g;

  function checkValue(value) {
    if (typeof value === 'string') {
      let match;
      while ((match = envVarPattern.exec(value)) !== null) {
        envVars.add(match[1]);
      }
    }
  }

  function checkObject(obj) {
    if (obj && typeof obj === 'object') {
      Object.values(obj).forEach(value => {
        if (typeof value === 'string') {
          checkValue(value);
        } else if (typeof value === 'object') {
          checkObject(value);
        }
      });
    }
  }

  checkObject(config);
  return Array.from(envVars);
}

async function testConnection() {
  const testConn = await question('\nTest connection now? (Y/n): ');
  if (testConn.toLowerCase() === 'n') {
    return;
  }

  console.log('\n🔍 Testing connection...');

  try {
    // Import and test the connection manager
    const { ConnectionManager } = await import('./dist/connections/manager.js');
    const manager = new ConnectionManager();

    await manager.initialize();
    const connections = manager.getAvailableConnections();

    if (connections.length === 0) {
      console.log('⚠️  No connections found');
      return;
    }

    console.log(`📋 Available connections: ${connections.join(', ')}`);

    const connToTest = connections[0]; // Test first connection
    console.log(`🔌 Testing connection: ${connToTest}`);

    const result = await manager.connect(connToTest);
    console.log('✅', result);

    await manager.disconnect();
    console.log('✅ Connection test successful');

  } catch (error) {
    console.log('❌ Connection test failed:', error.message);
    console.log('💡 This might be expected if MongoDB is not running or credentials are needed');
  }
}

main().catch(error => {
  console.error('❌ Setup failed:', error);
  rl.close();
  process.exit(1);
});