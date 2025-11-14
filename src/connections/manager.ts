/**
 * MongoDB Connection Pool Manager
 * Handles connection pooling and reuse for user-provided connection strings
 */

import { MongoClient } from 'mongodb';
import { MongoMCPError } from './types.js';

interface PooledConnection {
  client: MongoClient;
  connectionString: string;
  lastUsed: Date;
  inUse: boolean;
}

export class ConnectionManager {
  private connectionPool: Map<string, PooledConnection> = new Map();
  private readonly maxConnections = 10;
  private readonly connectionTimeoutMs = 300000; // 5 minutes
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval to remove stale connections
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleConnections();
    }, 60000); // Check every minute
  }

  /**
   * Get or create a MongoDB client for the given connection string
   */
  async getClient(connectionString: string): Promise<{ client: MongoClient; database: string }> {
    const connectionKey = this.hashConnectionString(connectionString);

    // Check if we have an existing connection
    let pooledConnection = this.connectionPool.get(connectionKey);

    if (pooledConnection && !pooledConnection.inUse) {
      // Reuse existing connection
      pooledConnection.lastUsed = new Date();
      pooledConnection.inUse = true;

      const database = this.extractDatabaseName(connectionString);
      return { client: pooledConnection.client, database };
    }

    // Need to create a new connection
    if (this.connectionPool.size >= this.maxConnections) {
      // Clean up old connections to make room
      await this.cleanupOldestConnection();
    }

    try {
      const client = new MongoClient(connectionString, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
      });

      await client.connect();

      // Test the connection
      const database = this.extractDatabaseName(connectionString);
      await client.db(database).admin().ping();

      const newConnection: PooledConnection = {
        client,
        connectionString,
        lastUsed: new Date(),
        inUse: true,
      };

      this.connectionPool.set(connectionKey, newConnection);

      console.error(`📡 Created new connection to ${this.maskConnectionString(connectionString)}`);

      return { client, database };
    } catch (error) {
      throw new MongoMCPError(
        `Failed to connect to MongoDB: ${error instanceof Error ? error.message : String(error)}`,
        'CONNECTION_FAILED',
        error
      );
    }
  }

  /**
   * Release a connection back to the pool
   */
  releaseConnection(connectionString: string): void {
    const connectionKey = this.hashConnectionString(connectionString);
    const pooledConnection = this.connectionPool.get(connectionKey);

    if (pooledConnection) {
      pooledConnection.inUse = false;
      pooledConnection.lastUsed = new Date();
    }
  }

  /**
   * Clean up stale connections that haven't been used recently
   */
  private async cleanupStaleConnections(): Promise<void> {
    const now = new Date();
    const keysToRemove: string[] = [];

    for (const [key, connection] of this.connectionPool.entries()) {
      const timeSinceLastUse = now.getTime() - connection.lastUsed.getTime();

      if (!connection.inUse && timeSinceLastUse > this.connectionTimeoutMs) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      await this.removeConnection(key);
    }

    if (keysToRemove.length > 0) {
      console.error(`🧹 Cleaned up ${keysToRemove.length} stale connection(s)`);
    }
  }

  /**
   * Remove the oldest connection to make room for new ones
   */
  private async cleanupOldestConnection(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = new Date();

    for (const [key, connection] of this.connectionPool.entries()) {
      if (!connection.inUse && connection.lastUsed < oldestTime) {
        oldestTime = connection.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      await this.removeConnection(oldestKey);
      console.error(`🧹 Removed oldest connection to make room`);
    }
  }

  /**
   * Remove a specific connection from the pool
   */
  private async removeConnection(key: string): Promise<void> {
    const connection = this.connectionPool.get(key);
    if (connection) {
      try {
        await connection.client.close();
      } catch (error) {
        console.error('Error closing connection:', error);
      }
      this.connectionPool.delete(key);
    }
  }

  /**
   * Extract database name from connection string
   */
  private extractDatabaseName(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      const pathname = url.pathname;
      const dbName = pathname.substring(1).split('?')[0];

      if (!dbName) {
        throw new MongoMCPError(
          'Database name not found in connection string',
          'INVALID_CONNECTION_STRING'
        );
      }

      return dbName;
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }

      throw new MongoMCPError(
        `Invalid connection string format: ${error instanceof Error ? error.message : String(error)}`,
        'INVALID_CONNECTION_STRING',
        error
      );
    }
  }

  /**
   * Create a hash of the connection string for use as a key
   */
  private hashConnectionString(connectionString: string): string {
    // Simple hash function - in production you might want to use crypto
    let hash = 0;
    for (let i = 0; i < connectionString.length; i++) {
      const char = connectionString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Mask sensitive information in connection string for logging
   */
  private maskConnectionString(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      if (url.password) {
        url.password = '***';
      }
      return url.toString();
    } catch {
      // If not a valid URL, just mask the middle part
      if (connectionString.length > 20) {
        return connectionString.substring(0, 10) + '***' + connectionString.substring(connectionString.length - 10);
      }
      return '***';
    }
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): { totalConnections: number; activeConnections: number; availableConnections: number } {
    const totalConnections = this.connectionPool.size;
    let activeConnections = 0;

    for (const connection of this.connectionPool.values()) {
      if (connection.inUse) {
        activeConnections++;
      }
    }

    return {
      totalConnections,
      activeConnections,
      availableConnections: totalConnections - activeConnections,
    };
  }

  /**
   * Cleanup all connections when shutting down
   */
  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const promises: Promise<void>[] = [];
    for (const key of this.connectionPool.keys()) {
      promises.push(this.removeConnection(key));
    }

    await Promise.all(promises);
    console.error('🛑 All connections closed');
  }
}