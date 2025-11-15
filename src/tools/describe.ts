/**
 * MongoDB Describe Tool
 * Analyzes collection schema by sampling documents and extracting field information
 * Returns field names, types, and patterns - NEVER returns actual data to LLM
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';
import fs from 'fs/promises';
import path from 'path';

interface FieldInfo {
  type: string[];
  required: boolean;
  frequency: number;
  patterns?: string[] | undefined;
  examples?: any[] | undefined;
}

interface SchemaAnalysis {
  collection: string;
  documentsAnalyzed: number;
  totalDocuments: number;
  schema: Record<string, FieldInfo>;
  samplingStrategy: string;
  analysisTime: string;
}

export class MongoDescribeTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const {
      connectionString,
      collection,
      limit = 1000,
      depth = 5,
      outputFile, // Optional: save sample data for debugging
      progressive = true
    } = args;

    if (!connectionString || typeof connectionString !== 'string') {
      throw new MongoMCPError(
        'ConnectionString parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    if (!collection || typeof collection !== 'string') {
      throw new MongoMCPError(
        'Collection parameter is required and must be a string',
        'INVALID_ARGS'
      );
    }

    try {
      // Get connection from pool
      const { client, database } = await this.connectionManager.getClient(connectionString);
      const db = client.db(database);
      const coll = db.collection(collection);

      console.error(`🔍 Analyzing schema for: ${collection} (limit: ${limit === 0 ? 'all' : limit})`);

      const startTime = Date.now();

      // Get total document count
      const totalDocuments = await coll.countDocuments();

      // Determine sampling strategy
      const { documents, strategy } = await this.sampleDocuments(coll, limit, totalDocuments, progressive);

      // Save sample data to file if requested (for debugging, NOT for LLM)
      if (outputFile) {
        await this.saveSampleData(documents, outputFile);
      }

      // Analyze schema without exposing data to LLM
      const schema = await this.analyzeSchema(documents, depth);

      const analysisTime = `${Date.now() - startTime}ms`;

      // Return only schema metadata - NO actual data
      const analysis: SchemaAnalysis = {
        collection,
        documentsAnalyzed: documents.length,
        totalDocuments,
        schema,
        samplingStrategy: strategy,
        analysisTime
      };

      console.error(`✅ Schema analysis complete: ${Object.keys(schema).length} fields discovered`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };

    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }

      throw new MongoMCPError(
        `Schema analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        'DESCRIBE_ERROR',
        error
      );
    } finally {
      // Release the connection back to the pool
      this.connectionManager.releaseConnection(connectionString);
    }
  }

  /**
   * Smart document sampling with progressive strategy for large collections
   */
  private async sampleDocuments(coll: any, limit: number, totalDocuments: number, progressive: boolean): Promise<{ documents: any[], strategy: string }> {
    if (limit === 0) {
      // All documents requested
      const documents = await coll.find({}).toArray();
      return { documents, strategy: 'full-collection' };
    }

    if (totalDocuments <= limit) {
      // Collection is small enough to analyze completely
      const documents = await coll.find({}).toArray();
      return { documents, strategy: 'full-collection' };
    }

    if (!progressive || totalDocuments <= limit * 2) {
      // Simple random sampling
      const documents = await coll.aggregate([
        { $sample: { size: limit } }
      ]).toArray();
      return { documents, strategy: 'random-sample' };
    }

    // Progressive sampling for large collections
    return await this.progressiveSampling(coll, limit, totalDocuments);
  }

  /**
   * Progressive sampling: start small, expand until no new fields found
   */
  private async progressiveSampling(coll: any, maxLimit: number, totalDocuments: number): Promise<{ documents: any[], strategy: string }> {
    const samples = [100, 500, 1000, 2000];
    let allDocuments: any[] = [];
    let knownFields = new Set<string>();
    let stableIterations = 0;

    for (const sampleSize of samples) {
      if (sampleSize > maxLimit) break;

      // Take additional sample
      const newSample = await coll.aggregate([
        { $sample: { size: Math.min(sampleSize, maxLimit - allDocuments.length) } }
      ]).toArray();

      allDocuments = allDocuments.concat(newSample);

      // Check for new fields
      const currentFields = this.extractAllFieldPaths(allDocuments, 2); // Quick shallow check
      const newFieldCount = currentFields.size;

      if (newFieldCount === knownFields.size) {
        stableIterations++;
        if (stableIterations >= 2) {
          // No new fields found in last 2 iterations, stop early
          break;
        }
      } else {
        stableIterations = 0;
        knownFields = currentFields;
      }

      if (allDocuments.length >= maxLimit) break;
    }

    return {
      documents: allDocuments.slice(0, maxLimit),
      strategy: `progressive-sample-${allDocuments.length}`
    };
  }

  /**
   * Analyze schema from documents - returns only metadata, no actual values
   */
  private async analyzeSchema(documents: any[], maxDepth: number): Promise<Record<string, FieldInfo>> {
    const fieldStats: Record<string, {
      types: Set<string>;
      count: number;
      examples: any[];
      patterns: Set<string>;
    }> = {};

    const totalDocs = documents.length;

    // Process each document
    for (const doc of documents) {
      const flattened = this.flattenDocument(doc, '', maxDepth);

      for (const [fieldPath, value] of Object.entries(flattened)) {
        if (!fieldStats[fieldPath]) {
          fieldStats[fieldPath] = {
            types: new Set(),
            count: 0,
            examples: [],
            patterns: new Set()
          };
        }

        const stats = fieldStats[fieldPath];
        stats.count++;

        // Type detection
        const type = this.getDetailedType(value);
        stats.types.add(type);

        // Pattern detection (for strings)
        if (typeof value === 'string' && value.length > 0) {
          const patterns = this.detectPatterns(value);
          patterns.forEach(pattern => stats.patterns.add(pattern));
        }

        // Keep limited examples (sanitized)
        if (stats.examples.length < 3) {
          stats.examples.push(this.sanitizeExample(value));
        }
      }
    }

    // Convert to final schema format
    const schema: Record<string, FieldInfo> = {};

    for (const [fieldPath, stats] of Object.entries(fieldStats)) {
      schema[fieldPath] = {
        type: Array.from(stats.types).sort(),
        required: stats.count === totalDocs,
        frequency: Math.round((stats.count / totalDocs) * 100) / 100,
        patterns: stats.patterns.size > 0 ? Array.from(stats.patterns).sort() : undefined,
        examples: stats.examples.length > 0 ? stats.examples : undefined
      };
    }

    return schema;
  }

  /**
   * Flatten document to dot notation paths
   */
  private flattenDocument(obj: any, prefix: string = '', maxDepth: number, currentDepth: number = 0): Record<string, any> {
    const flattened: Record<string, any> = {};

    if (currentDepth >= maxDepth) {
      flattened[prefix || 'root'] = '[max-depth-reached]';
      return flattened;
    }

    if (obj === null || obj === undefined) {
      flattened[prefix || 'root'] = obj;
      return flattened;
    }

    if (Array.isArray(obj)) {
      // For arrays, analyze first few elements
      flattened[prefix] = `[array-${obj.length}]`;

      const samplesToAnalyze = Math.min(3, obj.length);
      for (let i = 0; i < samplesToAnalyze; i++) {
        const itemPath = `${prefix}.${i}`;
        const itemFlattened = this.flattenDocument(obj[i], itemPath, maxDepth, currentDepth + 1);
        Object.assign(flattened, itemFlattened);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        const newPrefix = prefix ? `${prefix}.${key}` : key;
        const valueFlattened = this.flattenDocument(value, newPrefix, maxDepth, currentDepth + 1);
        Object.assign(flattened, valueFlattened);
      }
    } else {
      flattened[prefix] = obj;
    }

    return flattened;
  }

  /**
   * Extract all field paths quickly (for progressive sampling)
   */
  private extractAllFieldPaths(documents: any[], maxDepth: number): Set<string> {
    const fields = new Set<string>();

    for (const doc of documents) {
      const flattened = this.flattenDocument(doc, '', maxDepth);
      Object.keys(flattened).forEach(field => fields.add(field));
    }

    return fields;
  }

  /**
   * Get detailed type information
   */
  private getDetailedType(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';

    const baseType = typeof value;

    if (baseType === 'object') {
      // Check for special object types
      if (value.constructor && value.constructor.name !== 'Object') {
        return value.constructor.name.toLowerCase();
      }
      return 'object';
    }

    return baseType;
  }

  /**
   * Detect patterns in string values
   */
  private detectPatterns(value: string): string[] {
    const patterns: string[] = [];

    // Email pattern
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      patterns.push('email');
    }

    // URL pattern
    if (/^https?:\/\/[^\s]+$/.test(value)) {
      patterns.push('url');
    }

    // UUID pattern
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      patterns.push('uuid');
    }

    // Date patterns
    if (!isNaN(Date.parse(value))) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        patterns.push('iso-date');
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        patterns.push('date');
      } else {
        patterns.push('date-string');
      }
    }

    // Numeric strings
    if (/^\d+$/.test(value)) {
      patterns.push('numeric-string');
    }

    // MongoDB ObjectId
    if (/^[0-9a-fA-F]{24}$/.test(value)) {
      patterns.push('objectid-string');
    }

    return patterns;
  }

  /**
   * Sanitize example values to prevent data leakage
   */
  private sanitizeExample(value: any): any {
    if (typeof value === 'string') {
      // Truncate long strings and mask potentially sensitive data
      if (value.length > 50) {
        return `"${value.substring(0, 20)}...${value.substring(value.length - 10)}"`;
      }

      // Mask email domains
      if (this.detectPatterns(value).includes('email')) {
        return `"user@${value.split('@')[1]}"`;
      }

      // Mask parts of URLs
      if (this.detectPatterns(value).includes('url')) {
        try {
          const url = new URL(value);
          return `"${url.protocol}//${url.hostname}/..."`;
        } catch {
          return '"[url]"';
        }
      }

      return `"${value}"`;
    }

    if (typeof value === 'number') {
      // Show number ranges instead of exact values for potential IDs
      if (Number.isInteger(value) && value > 1000000) {
        return '[large-integer]';
      }
      return value;
    }

    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return `[array-length-${value.length}]`;
      }
      return '[object]';
    }

    return value;
  }

  /**
   * Save sample data to file for debugging (not for LLM)
   */
  private async saveSampleData(documents: any[], outputFile: string): Promise<void> {
    try {
      const resolvedPath = path.resolve(outputFile);
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      const data = {
        timestamp: new Date().toISOString(),
        sampleSize: documents.length,
        documents: documents
      };

      await fs.writeFile(resolvedPath, JSON.stringify(data, null, 2), 'utf8');
      console.error(`📁 Sample data saved to: ${resolvedPath}`);
    } catch (error) {
      console.error(`⚠️ Failed to save sample data: ${error}`);
      // Don't throw - this is optional functionality
    }
  }
}