/**
 * MongoDB Connection Types
 * Defines all connection-related interfaces and types
 */

export interface MongoConnectionOptions {
  retryWrites?: boolean;
  loadBalanced?: boolean;
  serverSelectionTimeoutMS?: number;
  connectTimeoutMS?: number;
  readPreference?: 'primary' | 'secondary' | 'secondaryPreferred' | 'primaryPreferred' | 'nearest';
  directConnection?: boolean;
  maxPoolSize?: number;
  minPoolSize?: number;
  maxIdleTimeMS?: number;
}

export interface MongoConnection {
  name: string;
  host: string;
  port: number;
  database: string;
  username?: string | null;
  password?: string | null;
  authSource?: string | null;
  authMechanism?: string | null;
  options?: MongoConnectionOptions;
  connectionString?: string;
  notes?: string;
  collections?: Record<string, string>;
}

export interface MongoConnectionsConfig {
  connections: Record<string, MongoConnection>;
  defaultConnection?: string;
}

export interface ConnectionState {
  currentConnection?: string | undefined;
  isConnected: boolean;
  lastError?: string | undefined;
  connectionStartTime?: Date | undefined;
  mongoClient?: any; // MongoDB Client instance
}

export interface EnvironmentVariables {
  [key: string]: string | undefined;
}

export class MongoMCPError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'MongoMCPError';
  }
}

export interface QueryOptions {
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
  projection?: Record<string, 0 | 1>;
  hint?: string | Record<string, 1 | -1>;
  explain?: boolean;
  timeout?: number;
}

export interface QueryResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
  documentsReturned?: number;
  explanation?: any;
}