import type { StorageThreadType, MessageType, MemoryConfig } from '@mastra/core/memory';
import {
  MastraStorage,
  TABLE_MESSAGES,
  TABLE_THREADS,
  TABLE_WORKFLOW_SNAPSHOT,
  TABLE_EVALS,
  TABLE_TRACES,
} from '@mastra/core/storage';
import type { TABLE_NAMES, StorageColumn, StorageGetMessagesArg, EvalRow } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import type { MetricResult, TestInfo } from '@mastra/core/eval';
import Cloudflare from 'cloudflare';

export interface D1Config {
  accountId: string;
  apiToken: string;
  databaseId: string;
  tablePrefix?: string;
}

export class D1Store extends MastraStorage {
  private client: Cloudflare;
  private accountId: string;
  private databaseId: string;
  private tablePrefix: string;

  constructor(config: D1Config) {
    super({ name: 'D1' });
    this.accountId = config.accountId;
    this.databaseId = config.databaseId;
    this.tablePrefix = config.tablePrefix || '';

    this.client = new Cloudflare({
      apiToken: config.apiToken,
    });
  }

  // Helper method to get the full table name with prefix
  private getTableName(tableName: TABLE_NAMES): string {
    return `${this.tablePrefix}${tableName}`;
  }

  // Execute a D1 query
  private async executeQuery(query: string, params: any[] = []): Promise<any> {
    try {
      this.logger.debug('Executing D1 query', { query, params });

      const response = await this.client.d1.database.query(this.databaseId, {
        account_id: this.accountId,
        sql: query,
        params,
      });

      // Check if we have a response
      if (!response) {
        this.logger.error('D1 query failed - no response', { query, params });
        throw new Error('D1 query failed - no response received');
      }

      // For SELECT queries, response.result will be an array of rows
      // For other queries (INSERT, UPDATE, DELETE), we'll check if result exists
      if (Array.isArray(response.result)) {
        return response.result;
      } else if (query.trim().toUpperCase().startsWith('SELECT')) {
        // If it's a SELECT query but no results, return empty array
        return [];
      } else {
        // For non-SELECT queries, return the result (which might be empty for operations like DELETE)
        return response.result || { affected: 0 };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Error executing D1 query:', { query, params, error });
      throw new Error(`D1 query execution failed: ${errorMessage}`);
    }
  }

  // Execute a D1 query and return the first result
  private async executeQueryFirst(query: string, params: any[] = []): Promise<any> {
    try {
      const result = await this.executeQuery(query, params);

      // Check if the result is an array (for SELECT queries)
      if (Array.isArray(result)) {
        return result.length > 0 ? result[0] : null;
      }

      // For non-SELECT queries, just return the result
      return result;
    } catch (error) {
      this.logger.error('Error executing D1 query first:', { query, params, error });
      throw error; // Re-throw to be handled by the caller
    }
  }

  // Helper to convert storage type to SQL type
  private getSqlType(type: string): string {
    switch (type) {
      case 'text':
        return 'TEXT';
      case 'timestamp':
        return 'TIMESTAMP';
      case 'integer':
        return 'INTEGER';
      case 'bigint':
        return 'INTEGER'; // SQLite doesn't have a separate BIGINT type
      case 'jsonb':
        return 'TEXT'; // Store JSON as TEXT in SQLite
      default:
        return 'TEXT';
    }
  }

  // Helper methods for date handling and serialization
  private ensureDate(date: Date | string | undefined): Date | undefined {
    if (!date) return undefined;
    return date instanceof Date ? date : new Date(date);
  }

  private serializeDate(date: Date | string | undefined): string | undefined {
    if (!date) return undefined;
    const dateObj = this.ensureDate(date);
    return dateObj?.toISOString();
  }

  // Helper to serialize objects to JSON strings
  private serializeValue(value: any): any {
    if (value === null || value === undefined) return null;

    if (value instanceof Date) {
      return this.serializeDate(value);
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return value;
  }

  // Helper to deserialize JSON strings to objects
  private deserializeValue(value: any, type?: string): any {
    if (value === null || value === undefined) return null;

    if (type === 'date' && typeof value === 'string') {
      return new Date(value);
    }

    if (type === 'jsonb' && typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, any>;
      } catch (e) {
        return value;
      }
    }

    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        return JSON.parse(value) as Record<string, any>;
      } catch (e) {
        return value;
      }
    }

    return value;
  }

  async createTable({
    tableName,
    schema,
  }: {
    tableName: TABLE_NAMES;
    schema: Record<string, StorageColumn>;
  }): Promise<void> {
    const fullTableName = this.getTableName(tableName);

    // Build SQL columns from schema
    const columns = Object.entries(schema)
      .map(([colName, colDef]) => {
        const type = this.getSqlType(colDef.type);
        const nullable = colDef.nullable === false ? 'NOT NULL' : '';
        const primaryKey = colDef.primaryKey ? 'PRIMARY KEY' : '';
        return `${colName} ${type} ${nullable} ${primaryKey}`.trim();
      })
      .join(', ');

    // Create table if not exists
    const sql = `CREATE TABLE IF NOT EXISTS ${fullTableName} (${columns})`;

    try {
      await this.executeQuery(sql);
      this.logger.debug(`Created table ${fullTableName}`);
    } catch (error) {
      this.logger.error(`Error creating table ${fullTableName}:`, { error });
      throw new Error(`Failed to create table ${fullTableName}: ${error}`);
    }
  }

  async clearTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    const fullTableName = this.getTableName(tableName);

    try {
      await this.executeQuery(`DELETE FROM ${fullTableName}`);
      this.logger.debug(`Cleared table ${fullTableName}`);
    } catch (error) {
      this.logger.error(`Error clearing table ${fullTableName}:`, { error });
      throw new Error(`Failed to clear table ${fullTableName}: ${error}`);
    }
  }

  async insert({ tableName, record }: { tableName: TABLE_NAMES; record: Record<string, any> }): Promise<void> {
    const fullTableName = this.getTableName(tableName);

    // Process record for SQL insertion
    const processedRecord: Record<string, any> = {};

    for (const [key, value] of Object.entries(record)) {
      processedRecord[key] = this.serializeValue(value);
    }

    const columns = Object.keys(processedRecord).join(', ');
    const placeholders = Object.keys(processedRecord)
      .map(() => '?')
      .join(', ');
    const values = Object.values(processedRecord);

    const sql = `INSERT OR REPLACE INTO ${fullTableName} (${columns}) VALUES (${placeholders})`;

    try {
      await this.executeQuery(sql, values);
    } catch (error) {
      this.logger.error(`Error inserting into ${fullTableName}:`, { error });
      throw new Error(`Failed to insert into ${fullTableName}: ${error}`);
    }
  }

  async load<R>({ tableName, keys }: { tableName: TABLE_NAMES; keys: Record<string, string> }): Promise<R | null> {
    const fullTableName = this.getTableName(tableName);

    // Build WHERE clause from keys
    const whereConditions = Object.keys(keys)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const values = Object.values(keys);

    const sql = `SELECT * FROM ${fullTableName} WHERE ${whereConditions} LIMIT 1`;

    try {
      const result = await this.executeQueryFirst(sql, values);

      if (!result) return null;

      // Process result to handle JSON fields
      const processedResult: Record<string, any> = {};

      for (const [key, value] of Object.entries(result)) {
        processedResult[key] = this.deserializeValue(value);
      }

      return processedResult as unknown as R;
    } catch (error) {
      this.logger.error(`Error loading from ${fullTableName}:`, { error });
      return null;
    }
  }

  async getThreadById({ threadId }: { threadId: string }): Promise<StorageThreadType | null> {
    const thread = await this.load<StorageThreadType>({
      tableName: TABLE_THREADS,
      keys: { id: threadId },
    });

    if (!thread) return null;

    try {
      return {
        ...thread,
        createdAt: this.ensureDate(thread.createdAt)!,
        updatedAt: this.ensureDate(thread.updatedAt)!,
        metadata:
          typeof thread.metadata === 'string'
            ? (JSON.parse(thread.metadata || '{}') as Record<string, any>)
            : thread.metadata || {},
      };
    } catch (error) {
      this.logger.error(`Error processing thread ${threadId}:`, { error });
      return null;
    }
  }

  async getThreadsByResourceId({ resourceId }: { resourceId: string }): Promise<StorageThreadType[]> {
    const fullTableName = this.getTableName(TABLE_THREADS);

    try {
      const sql = `SELECT * FROM ${fullTableName} WHERE resourceId = ?`;
      const results = await this.executeQuery(sql, [resourceId]);

      return results.map((thread: any) => ({
        ...thread,
        createdAt: this.ensureDate(thread.createdAt)!,
        updatedAt: this.ensureDate(thread.updatedAt)!,
        metadata:
          typeof thread.metadata === 'string'
            ? (JSON.parse(thread.metadata || '{}') as Record<string, any>)
            : thread.metadata || {},
      }));
    } catch (error) {
      this.logger.error(`Error getting threads by resourceId ${resourceId}:`, { error });
      return [];
    }
  }

  async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    const now = new Date();
    const threadToSave = {
      ...thread,
      createdAt: thread.createdAt || now,
      updatedAt: now,
      metadata: thread.metadata || ({} as Record<string, any>),
    };

    await this.insert({
      tableName: TABLE_THREADS,
      record: threadToSave as Record<string, any>,
    });
    return threadToSave;
  }
  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const thread = await this.getThreadById({ threadId: id });
    if (!thread) {
      throw new Error(`Thread ${id} not found`);
    }
    const updatedThread = {
      ...thread,
      title,
      metadata: {
        ...(thread.metadata as Record<string, any>),
        ...(metadata as Record<string, any>),
      },
      updatedAt: new Date(),
    };
    await this.insert({
      tableName: TABLE_THREADS,
      record: updatedThread,
    });
    return updatedThread;
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const fullTableName = this.getTableName(TABLE_THREADS);

    try {
      await this.executeQuery(`DELETE FROM ${fullTableName} WHERE id = ?`, [threadId]);

      // Also delete associated messages
      const messagesTableName = this.getTableName(TABLE_MESSAGES);
      await this.executeQuery(`DELETE FROM ${messagesTableName} WHERE thread_id = ?`, [threadId]);
    } catch (error) {
      this.logger.error(`Error deleting thread ${threadId}:`, { error });
      throw new Error(`Failed to delete thread ${threadId}: ${error}`);
    }
  }

  // Thread and message management methods

  async saveMessages({ messages }: { messages: MessageType[] }): Promise<MessageType[]> {
    if (messages.length === 0) return [];

    try {
      // Save each message individually
      for (const message of messages) {
        await this.insert({
          tableName: TABLE_MESSAGES,
          record: {
            ...message,
            thread_id: message.threadId,
          } as Record<string, any>,
        });
      }

      return messages;
    } catch (error) {
      this.logger.error('Error saving messages:', { error });
      throw error;
    }
  }

  // SQL-based implementation of getMessages

  async getMessages<T = MessageType>({ threadId, selectBy, threadConfig }: StorageGetMessagesArg): Promise<T[]> {
    const limit = typeof selectBy?.last === 'number' ? selectBy.last : 40;
    const fullTableName = this.getTableName(TABLE_MESSAGES);

    if (limit === 0 && !selectBy?.include) {
      return [];
    }

    try {
      let sql = `SELECT * FROM ${fullTableName} WHERE thread_id = ?`;
      const params: any[] = [threadId];

      // Handle specifically included messages
      if (selectBy?.include?.length) {
        const messageIds = selectBy.include.map(item => item.id);
        sql += ` AND id IN (${messageIds.map(() => '?').join(',')})`;
        params.push(...messageIds);
      }

      // Order by creation time and limit
      sql += ` ORDER BY createdAt ASC`;

      if (limit > 0) {
        sql += ` LIMIT ?`;
        params.push(limit);
      }

      const results = await this.executeQuery(sql, params);

      // Process messages
      const messages = results.map((msg: any) => {
        const processedMsg: Record<string, any> = {};

        for (const [key, value] of Object.entries(msg)) {
          processedMsg[key] = this.deserializeValue(value);
        }

        return processedMsg as unknown as T;
      });

      return messages;
    } catch (error) {
      this.logger.error(`Error retrieving messages for thread ${threadId}:`, { error });
      return [];
    }
  }

  async persistWorkflowSnapshot(params: {
    namespace: string;
    workflowName: string;
    runId: string;
    snapshot: WorkflowRunState;
  }): Promise<void> {
    const { namespace, workflowName, runId, snapshot } = params;

    const data = {
      namespace,
      workflow_name: workflowName,
      run_id: runId,
      snapshot: snapshot as unknown as Record<string, any>,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.logger.debug('Persisting workflow snapshot', { workflowName, runId });

    await this.insert({
      tableName: TABLE_WORKFLOW_SNAPSHOT,
      record: data,
    });
  }

  async loadWorkflowSnapshot(params: {
    namespace: string;
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    const { namespace, workflowName, runId } = params;

    this.logger.debug('Loading workflow snapshot', { workflowName, runId });

    const d = await this.load<{ snapshot: unknown }>({
      tableName: TABLE_WORKFLOW_SNAPSHOT,
      keys: {
        namespace,
        workflow_name: workflowName,
        run_id: runId,
      },
    });

    return d ? (d.snapshot as WorkflowRunState) : null;
  }

  async batchInsert({ tableName, records }: { tableName: TABLE_NAMES; records: Record<string, any>[] }): Promise<void> {
    if (records.length === 0) return;

    // Process each record individually for now
    // In a future optimization, this could use a transaction or bulk insert
    try {
      for (const record of records) {
        await this.insert({ tableName, record });
      }
    } catch (error) {
      this.logger.error(`Error batch inserting into ${tableName}:`, { error });
      throw new Error(`Failed to batch insert into ${tableName}: ${error}`);
    }
  }

  async getTraces({
    name,
    scope,
    page,
    perPage,
    attributes,
  }: {
    name?: string;
    scope?: string;
    page: number;
    perPage: number;
    attributes?: Record<string, string>;
  }): Promise<any[]> {
    const fullTableName = this.getTableName(TABLE_TRACES);

    try {
      let sql = `SELECT * FROM ${fullTableName} WHERE 1=1`;
      const params: any[] = [];

      if (name) {
        sql += ` AND name = ?`;
        params.push(name);
      }

      if (scope) {
        sql += ` AND scope = ?`;
        params.push(scope);
      }

      if (attributes && Object.keys(attributes).length > 0) {
        // This is a simplified approach - in a real implementation,
        // you'd need a more sophisticated way to query JSON attributes
        sql += ` AND attributes LIKE ?`;
        params.push(`%${JSON.stringify(attributes).slice(1, -1)}%`);
      }

      sql += ` ORDER BY startTime DESC LIMIT ? OFFSET ?`;
      params.push(perPage, (page - 1) * perPage);

      const results = await this.executeQuery(sql, params);

      return results.map((trace: any) => ({
        ...trace,
        attributes: this.deserializeValue(trace.attributes, 'jsonb') as Record<string, any>,
        status: this.deserializeValue(trace.status, 'jsonb') as Record<string, any>,
        events: this.deserializeValue(trace.events, 'jsonb') as Record<string, any>[],
        links: this.deserializeValue(trace.links, 'jsonb') as Record<string, any>[],
      }));
    } catch (error) {
      this.logger.error('Error getting traces:', { error });
      return [];
    }
  }

  async getEvalsByAgentName(agentName: string, type?: 'test' | 'live'): Promise<EvalRow[]> {
    const fullTableName = this.getTableName(TABLE_EVALS);

    try {
      let sql = `SELECT * FROM ${fullTableName} WHERE agent_name = ?`;
      const params: any[] = [agentName];

      if (type) {
        sql += ` AND type = ?`;
        params.push(type);
      }

      sql += ` ORDER BY created_at DESC`;

      const results = await this.executeQuery(sql, params);

      return results.map((row: any) => {
        // Convert snake_case to camelCase for the response
        const result = this.deserializeValue(row.result) as unknown as MetricResult;
        const testInfo = row.test_info ? (this.deserializeValue(row.test_info) as unknown as TestInfo) : undefined;

        return {
          input: row.input,
          output: row.output,
          result,
          agentName: row.agent_name,
          metricName: row.metric_name,
          instructions: row.instructions,
          runId: row.run_id,
          globalRunId: row.global_run_id,
          createdAt: row.created_at,
          testInfo,
        };
      });
    } catch (error) {
      this.logger.error(`Error getting evals for agent ${agentName}:`, { error });
      return [];
    }
  }

  async close(): Promise<void> {
    // No explicit cleanup needed for D1
  }

  async query<T>({
    tableName,
    filter,
    limit = 100,
    offset = 0,
  }: {
    tableName: TABLE_NAMES;
    filter?: Record<string, any>;
    limit?: number;
    offset?: number;
  }): Promise<T[]> {
    const fullTableName = this.getTableName(tableName);

    try {
      let sql = `SELECT * FROM ${fullTableName}`;
      const params: any[] = [];

      // Add WHERE clauses for each filter condition
      if (filter && Object.keys(filter).length > 0) {
        const conditions = [];

        for (const [key, value] of Object.entries(filter)) {
          conditions.push(`${key} = ?`);
          params.push(this.serializeValue(value));
        }

        if (conditions.length > 0) {
          sql += ` WHERE ${conditions.join(' AND ')}`;
        }
      }

      // Add pagination
      sql += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      this.logger.debug(`Executing query on ${fullTableName}`, { sql, params });
      const results = await this.executeQuery(sql, params);

      // Process results to deserialize values
      return results.map((row: any) => {
        const processedRow: Record<string, any> = {};

        for (const [key, value] of Object.entries(row)) {
          processedRow[key] = this.deserializeValue(value);
        }

        return processedRow as unknown as T;
      });
    } catch (error) {
      this.logger.error(`Error querying ${fullTableName}:`, { error });
      return [];
    }
  }
}
