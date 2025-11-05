/**
 * Response Handler Utility
 * Safely handles large responses by writing to file first and checking size
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MongoMCPError } from '../connections/types.js';

// Configuration for response size thresholds
export interface ResponseSizeConfig {
  // Maximum response size in bytes (default: 10MB)
  maxSizeBytes: number;
  // Warning threshold in bytes (default: 5MB)
  warningSizeBytes: number;
  // Maximum number of documents to include in truncated response
  maxDocuments: number;
}

const DEFAULT_CONFIG: ResponseSizeConfig = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  warningSizeBytes: 5 * 1024 * 1024, // 5MB
  maxDocuments: 50,
};

export interface SafeResponseResult {
  content: string;
  metadata: {
    originalSize: number;
    finalSize: number;
    wasTruncated: boolean;
    documentsShown?: number;
    totalDocuments?: number;
    filePath?: string;
  };
}

/**
 * Safely formats and returns a response by:
 * 1. Writing to a temporary file
 * 2. Checking the file size
 * 3. Truncating if necessary
 * 4. Reading and returning the safe content
 * 5. Cleaning up the temp file
 */
export class SafeResponseHandler {
  private config: ResponseSizeConfig;
  private tempFiles: Set<string> = new Set();

  constructor(config?: Partial<ResponseSizeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Safely handles a response with automatic size checking and truncation
   */
  async handleResponse(
    data: any,
    options: {
      maxResults?: number;
      formatResponse?: (data: any, truncated: boolean) => string;
    } = {}
  ): Promise<SafeResponseResult> {
    const maxResults = options.maxResults || this.config.maxDocuments;
    let tempFilePath: string | undefined;

    try {
      // Generate temp file path
      tempFilePath = join(tmpdir(), `mongo-mcp-response-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`);
      this.tempFiles.add(tempFilePath);

      // Serialize the full response
      const fullResponse = JSON.stringify(data, null, 2);

      // Write to temp file
      await fs.writeFile(tempFilePath, fullResponse, 'utf-8');

      // Get file stats
      const stats = await fs.stat(tempFilePath);
      const fileSizeBytes = stats.size;

      console.error(`📊 Response size: ${this.formatBytes(fileSizeBytes)}`);

      // Check if response is too large
      if (fileSizeBytes > this.config.maxSizeBytes) {
        console.error(`⚠️  Response exceeds maximum size (${this.formatBytes(this.config.maxSizeBytes)})`);

        // Truncate the data
        const truncatedData = this.truncateData(data, maxResults);
        const truncatedResponse = JSON.stringify(truncatedData, null, 2);

        // Clean up temp file
        await this.cleanupTempFile(tempFilePath);

        const metadata: SafeResponseResult['metadata'] = {
          originalSize: fileSizeBytes,
          finalSize: truncatedResponse.length,
          wasTruncated: true,
        };

        if (Array.isArray(truncatedData)) {
          metadata.documentsShown = truncatedData.length;
        }

        if (Array.isArray(data)) {
          metadata.totalDocuments = data.length;
        }

        return {
          content: truncatedResponse,
          metadata,
        };
      }

      // Check if response exceeds warning threshold
      if (fileSizeBytes > this.config.warningSizeBytes) {
        console.error(`⚠️  Response size exceeds warning threshold (${this.formatBytes(this.config.warningSizeBytes)})`);
      }

      // Safe to read - response is within limits
      const content = await fs.readFile(tempFilePath, 'utf-8');

      // Clean up temp file
      await this.cleanupTempFile(tempFilePath);

      return {
        content,
        metadata: {
          originalSize: fileSizeBytes,
          finalSize: fileSizeBytes,
          wasTruncated: false,
        },
      };

    } catch (error) {
      // Clean up temp file on error
      if (tempFilePath) {
        await this.cleanupTempFile(tempFilePath);
      }

      throw new MongoMCPError(
        `Response handling failed: ${error instanceof Error ? error.message : String(error)}`,
        'RESPONSE_HANDLING_ERROR',
        error
      );
    }
  }

  /**
   * Truncates data to specified number of items
   */
  private truncateData(data: any, maxItems: number): any {
    if (Array.isArray(data)) {
      return data.slice(0, maxItems);
    }
    return data;
  }

  /**
   * Formats bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Safely cleans up a temp file
   */
  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      this.tempFiles.delete(filePath);
      console.error(`🗑️  Cleaned up temp file: ${filePath}`);
    } catch (error) {
      // Ignore errors during cleanup
      console.error(`⚠️  Failed to cleanup temp file ${filePath}:`, error);
    }
  }

  /**
   * Cleans up all remaining temp files
   */
  async cleanup(): Promise<void> {
    const cleanupPromises = Array.from(this.tempFiles).map(filePath =>
      this.cleanupTempFile(filePath)
    );
    await Promise.allSettled(cleanupPromises);
  }

  /**
   * Gets current configuration
   */
  getConfig(): ResponseSizeConfig {
    return { ...this.config };
  }

  /**
   * Updates configuration
   */
  updateConfig(config: Partial<ResponseSizeConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Singleton instance
let instance: SafeResponseHandler | null = null;

/**
 * Gets the singleton SafeResponseHandler instance
 */
export function getSafeResponseHandler(config?: Partial<ResponseSizeConfig>): SafeResponseHandler {
  if (!instance) {
    instance = new SafeResponseHandler(config);
  } else if (config) {
    instance.updateConfig(config);
  }
  return instance;
}

/**
 * Cleans up the singleton instance and all temp files
 */
export async function cleanupSafeResponseHandler(): Promise<void> {
  if (instance) {
    await instance.cleanup();
    instance = null;
  }
}
