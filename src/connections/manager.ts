/**
 * MongoDB Connection Manager
 * Handles connection discovery, validation, and management
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { MongoClient } from 'mongodb';
import {
  MongoConnection,
  MongoConnectionsConfig,
  ConnectionState,
  MongoMCPError,
  EnvironmentVariables
} from './types.js';

export class ConnectionManager {
  private config: MongoConnectionsConfig | null = null;
  private state: ConnectionState = { isConnected: false };
  private configPath: string | null = null;

  /**
   * Initialize the connection manager by discovering and loading configuration
   */
  async initialize(): Promise<void> {
    try {
      this.configPath = await this.discoverConfigPath();
      this.config = await this.loadConfiguration(this.configPath);
      console.log(`✅ Loaded MongoDB configuration from: ${this.configPath}`);
      console.log(`📋 Available connections: ${Object.keys(this.config.connections).join(', ')}`);
    } catch (error) {
      throw new MongoMCPError(
        'Failed to initialize connection manager',
        'INIT_ERROR',
        error
      );
    }
  }

  /**
   * Discover configuration file path using priority order
   */
  private async discoverConfigPath(): Promise<string> {
    const candidates = [
      // 1. Environment variable
      process.env.MONGO_MCP_CONFIG,
      // 2. Current directory
      './mongo-connections.json',
      // 3. User home directory
      path.join(os.homedir(), '.mongo-mcp', 'connections.json'),
      // 4. Project config directory
      './config/connections.json'
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return path.resolve(candidate);
      } catch {
        // File doesn't exist, try next
        continue;
      }
    }

    throw new MongoMCPError(
      `No MongoDB configuration found. Searched:\n${candidates.map(p => `  - ${p}`).join('\n')}\n\nCreate a configuration file or set MONGO_MCP_CONFIG environment variable.`,
      'CONFIG_NOT_FOUND'
    );
  }

  /**
   * Load and parse configuration file
   */
  private async loadConfiguration(configPath: string): Promise<MongoConnectionsConfig> {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const rawConfig = JSON.parse(content);

      // Handle both new format and legacy format
      if (rawConfig.connections) {
        return rawConfig as MongoConnectionsConfig;
      } else {
        // Legacy format - assume root object contains connections
        return {
          connections: rawConfig
        } as MongoConnectionsConfig;
      }
    } catch (error) {
      throw new MongoMCPError(
        `Failed to load configuration from ${configPath}`,
        'CONFIG_LOAD_ERROR',
        error
      );
    }
  }

  /**
   * Get list of available connections
   */
  getAvailableConnections(): string[] {
    if (!this.config) {
      return [];
    }
    return Object.keys(this.config.connections);
  }

  /**
   * Get connection details by name
   */
  getConnection(name: string): MongoConnection | null {
    if (!this.config) {
      return null;
    }
    return this.config.connections[name] || null;
  }

  /**
   * Connect to a specific MongoDB instance
   */
  async connect(connectionName: string): Promise<string> {
    if (!this.config) {
      throw new MongoMCPError('Configuration not loaded', 'CONFIG_NOT_LOADED');
    }

    const connection = this.config.connections[connectionName];
    if (!connection) {
      throw new MongoMCPError(
        `Connection '${connectionName}' not found. Available: ${Object.keys(this.config.connections).join(', ')}`,
        'CONNECTION_NOT_FOUND'
      );
    }

    try {
      // Close existing connection if any
      await this.disconnect();

      // Build connection string with environment variable substitution
      const connectionString = this.buildConnectionString(connection);

      // Create MongoDB client
      // Filter out URI-only options that shouldn't be passed as client options
      const clientOptions = { ...connection.options };
      delete clientOptions?.loadBalanced; // loadBalanced must be in URI, not client options
      delete clientOptions?.retryWrites;  // retryWrites should be in URI
      delete clientOptions?.readPreference; // readPreference should be in URI

      const client = new MongoClient(connectionString, {
        serverSelectionTimeoutMS: connection.options?.serverSelectionTimeoutMS || 5000,
        connectTimeoutMS: connection.options?.connectTimeoutMS || 10000,
        maxPoolSize: connection.options?.maxPoolSize || 10,
        ...clientOptions
      });

      // Test connection
      await client.connect();
      await client.db(connection.database).admin().ping();

      // Update state
      this.state = {
        currentConnection: connectionName,
        isConnected: true,
        connectionStartTime: new Date(),
        mongoClient: client
      };

      return `✅ Connected to ${connection.name} (${connection.host}:${connection.port}/${connection.database})`;
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      throw new MongoMCPError(
        `Failed to connect to ${connectionName}: ${this.state.lastError}`,
        'CONNECTION_FAILED',
        error
      );
    }
  }

  /**
   * Disconnect from current MongoDB instance
   */
  async disconnect(): Promise<void> {
    if (this.state.mongoClient) {
      try {
        await this.state.mongoClient.close();
      } catch (error) {
        console.warn('Error closing MongoDB connection:', error);
      }
    }

    this.state = {
      isConnected: false
    };
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return { ...this.state };
  }

  /**
   * Get MongoDB client for executing operations
   */
  getClient(): MongoClient {
    if (!this.state.isConnected || !this.state.mongoClient) {
      throw new MongoMCPError('Not connected to MongoDB', 'NOT_CONNECTED');
    }
    return this.state.mongoClient;
  }

  /**
   * Get current database name
   */
  getCurrentDatabase(): string {
    if (!this.state.currentConnection || !this.config) {
      throw new MongoMCPError('No active connection', 'NO_ACTIVE_CONNECTION');
    }
    const connection = this.config.connections[this.state.currentConnection];
    if (!connection) {
      throw new MongoMCPError('Connection not found', 'CONNECTION_NOT_FOUND');
    }
    return connection.database;
  }

  /**
   * Build connection string with environment variable substitution
   */
  private buildConnectionString(connection: MongoConnection): string {
    if (connection.connectionString) {
      return this.substituteEnvironmentVariables(connection.connectionString);
    }

    // Build connection string from components
    let connectionString = 'mongodb://';

    // Add authentication if provided
    if (connection.username && connection.password) {
      const username = this.substituteEnvironmentVariables(connection.username);
      const password = this.substituteEnvironmentVariables(connection.password);
      connectionString += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    }

    // Add host and port
    const host = this.substituteEnvironmentVariables(connection.host);
    connectionString += `${host}:${connection.port}`;

    // Add database
    connectionString += `/${connection.database}`;

    // Add query parameters
    const queryParams: string[] = [];

    if (connection.authSource) {
      queryParams.push(`authSource=${connection.authSource}`);
    }

    if (connection.authMechanism) {
      queryParams.push(`authMechanism=${connection.authMechanism}`);
    }

    // Add options
    if (connection.options) {
      Object.entries(connection.options).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryParams.push(`${key}=${value}`);
        }
      });
    }

    if (queryParams.length > 0) {
      connectionString += `?${queryParams.join('&')}`;
    }

    return connectionString;
  }

  /**
   * Substitute environment variables in strings (${VAR_NAME} format)
   */
  private substituteEnvironmentVariables(str: string): string {
    return str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new MongoMCPError(
          `Environment variable ${varName} is not set`,
          'ENV_VAR_NOT_SET'
        );
      }
      return value;
    });
  }

  /**
   * Validate connection configuration
   */
  validateConnection(connection: MongoConnection): string[] {
    const errors: string[] = [];

    if (!connection.host) errors.push('Host is required');
    if (!connection.port || connection.port <= 0 || connection.port > 65535) {
      errors.push('Valid port number is required');
    }
    if (!connection.database) errors.push('Database name is required');

    // Validate environment variable references
    const envVarPattern = /\$\{([^}]+)\}/g;
    const fields = [connection.host, connection.username, connection.password];

    fields.forEach((field, index) => {
      if (typeof field === 'string') {
        let match;
        while ((match = envVarPattern.exec(field)) !== null) {
          const varName = match[1];
          if (varName && !process.env[varName]) {
            errors.push(`Environment variable ${varName} is not set`);
          }
        }
      }
    });

    return errors;
  }
}