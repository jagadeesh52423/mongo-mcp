/**
 * MongoDB Transfer Tool
 * Handles data import/export and cross-connection transfers
 */

import { ConnectionManager } from '../connections/manager.js';
import { MongoMCPError } from '../connections/types.js';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

interface TransferSource {
  connection?: string;
  collection?: string;
  file?: string;
  format?: 'json' | 'csv' | 'bson';
}

interface TransferTarget {
  connection?: string;
  collection?: string;
  file?: string;
  format?: 'json' | 'csv' | 'bson';
}

interface TransferOptions {
  filter?: any;
  projection?: any;
  sort?: any;
  limit?: number;
  skip?: number;
  mode?: 'insert' | 'upsert' | 'replace';
  batchSize?: number;
  createBackup?: boolean;
}

export class MongoTransferTool {
  constructor(private connectionManager: ConnectionManager) {}

  async execute(args: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { action, source, target, options = {} } = args;

    if (!action || !['export', 'import'].includes(action)) {
      throw new MongoMCPError(
        'Action must be one of: export, import',
        'INVALID_ACTION'
      );
    }

    if (!source || !target) {
      throw new MongoMCPError(
        'Both source and target must be specified',
        'MISSING_PARAMS'
      );
    }

    try {
      let result: string;
      const startTime = Date.now();

      switch (action) {
        case 'export':
          result = await this.handleExport(source, target, options);
          break;
        case 'import':
          result = await this.handleImport(source, target, options);
          break;
        default:
          throw new MongoMCPError(`Unsupported action: ${action}`, 'UNSUPPORTED_ACTION');
      }

      const executionTime = Date.now() - startTime;
      const finalResult = `${result}\n\n⏱️ **Execution Time**: ${executionTime}ms`;

      return {
        content: [
          {
            type: 'text',
            text: finalResult,
          },
        ],
      };
    } catch (error) {
      if (error instanceof MongoMCPError) {
        throw error;
      }

      throw new MongoMCPError(
        `Transfer operation failed: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSFER_ERROR',
        error
      );
    }
  }

  private async handleExport(source: TransferSource, target: TransferTarget, options: TransferOptions): Promise<string> {
    if (!source.connection || !source.collection) {
      throw new MongoMCPError('Export source must specify connection and collection', 'INVALID_SOURCE');
    }

    if (!target.file) {
      throw new MongoMCPError('Export target must specify file path', 'INVALID_TARGET');
    }

    // Connect to source database
    const sourceDb = await this.connectToDatabase(source.connection);
    const collection = sourceDb.collection(source.collection);

    // Build query
    const query = options.filter || {};
    let cursor = collection.find(query);

    if (options.projection) {
      cursor = cursor.project(options.projection);
    }
    if (options.sort) {
      cursor = cursor.sort(options.sort);
    }
    if (options.skip) {
      cursor = cursor.skip(options.skip);
    }
    if (options.limit) {
      cursor = cursor.limit(options.limit);
    }

    // Determine format
    const format = target.format || this.detectFormat(target.file);

    // Ensure directory exists
    await fs.mkdir(path.dirname(target.file), { recursive: true });

    let exportedCount = 0;

    switch (format) {
      case 'json':
        exportedCount = await this.exportToJSON(cursor, target.file);
        break;
      case 'csv':
        exportedCount = await this.exportToCSV(cursor, target.file);
        break;
      default:
        throw new MongoMCPError(`Unsupported export format: ${format}`, 'UNSUPPORTED_FORMAT');
    }

    return `✅ **Export Completed**\n\n` +
           `**Source**: ${source.connection}.${source.collection}\n` +
           `**Target**: ${target.file} (${format.toUpperCase()})\n` +
           `**Documents Exported**: ${exportedCount.toLocaleString()}\n` +
           `**Filter**: ${JSON.stringify(query, null, 2)}`;
  }

  private async handleImport(source: TransferSource, target: TransferTarget, options: TransferOptions): Promise<string> {
    if (!source.file) {
      throw new MongoMCPError('Import source must specify file path', 'INVALID_SOURCE');
    }

    if (!target.connection || !target.collection) {
      throw new MongoMCPError('Import target must specify connection and collection', 'INVALID_TARGET');
    }

    // Check if file exists
    try {
      await fs.access(source.file);
    } catch {
      throw new MongoMCPError(`File not found: ${source.file}`, 'FILE_NOT_FOUND');
    }

    // Connect to target database
    const targetDb = await this.connectToDatabase(target.connection);
    const collection = targetDb.collection(target.collection);

    // Determine format
    const format = source.format || this.detectFormat(source.file);
    const mode = options.mode || 'insert';
    const batchSize = options.batchSize || 100;

    let importedCount = 0;

    // Create backup if requested
    if (options.createBackup) {
      const backupFile = `${source.file}.backup.${Date.now()}.json`;
      await this.handleExport(
        { connection: target.connection, collection: target.collection },
        { file: backupFile, format: 'json' },
        {}
      );
    }

    switch (format) {
      case 'json':
        importedCount = await this.importFromJSON(source.file, collection, mode, batchSize);
        break;
      case 'csv':
        importedCount = await this.importFromCSV(source.file, collection, mode, batchSize);
        break;
      default:
        throw new MongoMCPError(`Unsupported import format: ${format}`, 'UNSUPPORTED_FORMAT');
    }

    return `✅ **Import Completed**\n\n` +
           `**Source**: ${source.file} (${format.toUpperCase()})\n` +
           `**Target**: ${target.connection}.${target.collection}\n` +
           `**Documents Imported**: ${importedCount.toLocaleString()}\n` +
           `**Mode**: ${mode}\n` +
           `**Batch Size**: ${batchSize}`;
  }


  private async connectToDatabase(connectionName: string): Promise<any> {
    // Connect to the specified database
    await this.connectionManager.connect(connectionName);
    const client = this.connectionManager.getClient();
    const database = this.connectionManager.getCurrentDatabase();

    return client.db(database);
  }

  private detectFormat(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.json':
        return 'json';
      case '.csv':
        return 'csv';
      case '.bson':
        return 'bson';
      default:
        return 'json'; // Default to JSON
    }
  }

  private async exportToJSON(cursor: any, filename: string): Promise<number> {
    const documents = await cursor.toArray();
    await fs.writeFile(filename, JSON.stringify(documents, null, 2));
    return documents.length;
  }

  private async exportToCSV(cursor: any, filename: string): Promise<number> {
    const documents = await cursor.toArray();

    if (documents.length === 0) {
      await fs.writeFile(filename, '');
      return 0;
    }

    // Get all unique keys from all documents
    const allKeys = new Set<string>();
    documents.forEach((doc: any) => {
      Object.keys(doc).forEach(key => allKeys.add(key));
    });

    const headers = Array.from(allKeys);

    // Create CSV content
    let csvContent = headers.join(',') + '\n';

    documents.forEach((doc: any) => {
      const row = headers.map(header => {
        const value = doc[header];
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value).replace(/"/g, '""'); // Escape quotes
      });
      csvContent += '"' + row.join('","') + '"\n';
    });

    await fs.writeFile(filename, csvContent);
    return documents.length;
  }

  private async importFromJSON(filename: string, collection: any, mode: string, batchSize: number): Promise<number> {
    const fileContent = await fs.readFile(filename, 'utf-8');
    const documents = JSON.parse(fileContent);

    if (!Array.isArray(documents)) {
      throw new MongoMCPError('JSON file must contain an array of documents', 'INVALID_FORMAT');
    }

    let importedCount = 0;

    // Process in batches
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);

      if (mode === 'upsert') {
        for (const doc of batch as any[]) {
          await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
        }
      } else {
        await collection.insertMany(batch, { ordered: false });
      }

      importedCount += batch.length;
    }

    return importedCount;
  }

  private async importFromCSV(filename: string, collection: any, mode: string, batchSize: number): Promise<number> {
    const fileContent = await fs.readFile(filename, 'utf-8');
    const lines = fileContent.trim().split('\n');

    if (lines.length === 0) {
      return 0;
    }

    const headers = lines[0]?.split(',').map(h => h.trim().replace(/^"|"$/g, '')) || [];
    const documents: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i]?.split(',').map(v => v.trim().replace(/^"|"$/g, '')) || [];
      const doc: any = {};

      headers.forEach((header, index) => {
        let value: any = values[index] || '';

        // Try to parse as JSON for objects/arrays
        if (value.startsWith('{') || value.startsWith('[')) {
          try {
            value = JSON.parse(value);
          } catch {
            // Keep as string if JSON parsing fails
          }
        }

        doc[header] = value;
      });

      documents.push(doc);
    }

    let importedCount = 0;

    // Process in batches
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);

      if (mode === 'upsert') {
        for (const doc of batch as any[]) {
          await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
        }
      } else {
        await collection.insertMany(batch, { ordered: false });
      }

      importedCount += batch.length;
    }

    return importedCount;
  }
}