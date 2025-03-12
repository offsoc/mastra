import type { StorageThreadType, MessageType } from '@mastra/core/memory';
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

export interface D1WorkersConfig {
  binding: any; // D1Database binding from Workers
  tablePrefix?: string;
}

export type D1StoreConfig = D1Config | D1WorkersConfig;

export class D1Store extends MastraStorage {
  private client?: Cloudflare;
  private accountId?: string;
  private databaseId?: string;
  private binding?: any; // D1Database binding
  private tablePrefix: string;
  private useWorkersBinding: boolean;

  constructor(config: D1StoreConfig) {
    super({ name: 'D1' });

    this.tablePrefix = config.tablePrefix || '';
    // Determine which API to use based on provided config
    if ('binding' in config) {
      this.binding = config.binding;
      this.useWorkersBinding = true;
    } else {
      this.accountId = config.accountId;
      this.databaseId = config.databaseId;
      this.client = new Cloudflare({
        apiToken: config.apiToken,
      });
      this.useWorkersBinding = false;
    }
  }

  // Helper method to get the full table name with prefix
  private getTableName(tableName: TABLE_NAMES): string {
    return `${this.tablePrefix}${tableName}`;
  }

  // Helper method to create SQL indexes for better query performance
  private async createIndexIfNotExists(
    tableName: TABLE_NAMES,
    columnName: string,
    indexType: string = '',
  ): Promise<void> {
    const fullTableName = this.getTableName(tableName);
    const indexName = `idx_${tableName}_${columnName}`;

    try {
      // Check if index exists
      const checkIndexQuery = `
        SELECT name FROM sqlite_master 
        WHERE type='index' AND name=? AND tbl_name=?
      `;
      const indexExists = await this.executeQueryFirst(checkIndexQuery, [indexName, fullTableName]);

      if (!indexExists) {
        // Create the index if it doesn't exist
        const createIndexQuery = `CREATE ${indexType} INDEX IF NOT EXISTS ${indexName} ON ${fullTableName}(${columnName})`;
        await this.executeQuery(createIndexQuery);
        this.logger.debug(`Created index ${indexName} on ${fullTableName}(${columnName})`);
      }
    } catch (error) {
      this.logger.error(`Error creating index on ${fullTableName}(${columnName}):`, { error });
      // Non-fatal error, continue execution
    }
  }

  // Execute a D1 query
  private async executeQuery(sql: string, params: any[] = []): Promise<any[]> {
    try {
      this.logger.debug('Executing SQL query', { sql, params });

      let results: any[];

      if (this.useWorkersBinding && this.binding) {
        // Use Workers Binding API
        const statement = this.binding.prepare(sql);

        // Bind parameters if any
        if (params.length > 0) {
          const result = await statement.bind(...params).all();
          results = result.results;
        } else {
          const result = await statement.all();
          results = result.results;
        }
      } else if (this.client && this.accountId && this.databaseId) {
        // Use REST API
        const response = await this.client.d1.database.query(this.databaseId, {
          account_id: this.accountId,
          sql: sql,
          params: params,
        });

        results = response.result;
      } else {
        throw new Error('No valid D1 configuration provided');
      }

      return results || [];
    } catch (error: any) {
      this.logger.error('Error executing SQL query', { error, sql, params });
      throw new Error(`D1 query error: ${error.message}`);
    }
  }

  // Execute a D1 query and return the first result
  private async executeQueryFirst(sql: string, params: any[] = []): Promise<any> {
    try {
      const result = await this.executeQuery(sql, params);

      // Check if the result is an array (for SELECT queries)
      if (Array.isArray(result)) {
        return result.length > 0 ? result[0] : null;
      }

      // For non-SELECT queries, just return the result
      return result;
    } catch (error) {
      this.logger.error('Error executing D1 query first:', { error, sql, params });
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
        createdAt: this.ensureDate(thread.createdAt) as Date,
        updatedAt: this.ensureDate(thread.updatedAt) as Date,
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
        createdAt: this.ensureDate(thread.createdAt) as Date,
        updatedAt: this.ensureDate(thread.updatedAt) as Date,
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
      const now = new Date();
      const fullTableName = this.getTableName(TABLE_MESSAGES);

      // Group messages by thread for better organization
      const messagesByThread = new Map<string, MessageType[]>();

      // Process and save each message
      for (const message of messages) {
        // Ensure timestamps are set
        const messageToSave = {
          ...message,
          thread_id: message.threadId,
          createdAt: message.createdAt || now,
          updatedAt: now,
        };

        // Group by thread for later processing
        if (!messagesByThread.has(message.threadId)) {
          messagesByThread.set(message.threadId, []);
        }
        messagesByThread.get(message.threadId)!.push(messageToSave);

        // Save the message to the database
        await this.insert({
          tableName: TABLE_MESSAGES,
          record: messageToSave as Record<string, any>,
        });
      }

      // Update thread metadata to reflect the latest message
      await Promise.all(
        Array.from(messagesByThread.entries()).map(async ([threadId, threadMessages]) => {
          try {
            // Get the thread to update its metadata
            const thread = await this.getThreadById({ threadId });
            if (thread) {
              // Find the latest message in this batch
              if (threadMessages.length > 0) {
                // Sort messages by creation time and get the latest one
                const sortedMessages = [...threadMessages].sort((a, b) => {
                  const timeA = new Date(a.createdAt || 0).getTime();
                  const timeB = new Date(b.createdAt || 0).getTime();
                  return timeB - timeA; // Descending order (newest first)
                });

                const latestMessage = sortedMessages[0]; // This is safer than using reduce

                // Ensure latestMessage is defined before proceeding
                if (latestMessage) {
                  // Ensure we have valid values for the thread metadata
                  const createdAt = latestMessage.createdAt || new Date().toISOString();
                  const messageId = latestMessage.id || '';

                  if (messageId) {
                    // Update thread with latest message info
                    await this.updateThread({
                      id: threadId,
                      title: thread.title || '', // Ensure title is never undefined
                      metadata: {
                        ...(thread.metadata as Record<string, unknown>),
                        lastMessageAt: createdAt,
                        lastMessageId: messageId,
                        messageCount: ((thread.metadata as any)?.messageCount || 0) + threadMessages.length,
                      },
                    });
                  }
                }
              }
            }
          } catch (error) {
            this.logger.error(`Error updating thread ${threadId} metadata:`, { error });
          }
        }),
      );

      this.logger.debug(`Saved ${messages.length} messages across ${messagesByThread.size} threads`);
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
      // We'll collect all message IDs we need to fetch
      const messageIdsToFetch = new Set<string>();

      // Handle specifically included messages and their context
      if (selectBy?.include?.length) {
        this.logger.debug('Including specific messages with context', { include: selectBy.include });

        for (const item of selectBy.include) {
          messageIdsToFetch.add(item.id);

          // If we need context (previous/next messages)
          if (item.withPreviousMessages || item.withNextMessages) {
            // First, get the current message's position (using created_at as the ordering)
            const positionQuery = `
              SELECT created_at FROM ${fullTableName} 
              WHERE thread_id = ? AND id = ? 
              LIMIT 1
            `;
            const positionResult = await this.executeQueryFirst(positionQuery, [threadId, item.id]);

            if (positionResult) {
              const messageTimestamp = positionResult.created_at;

              // Get previous messages if requested
              if (item.withPreviousMessages && item.withPreviousMessages > 0) {
                const prevQuery = `
                  SELECT id FROM ${fullTableName} 
                  WHERE thread_id = ? AND created_at < ? 
                  ORDER BY created_at DESC 
                  LIMIT ?
                `;
                const prevResults = await this.executeQuery(prevQuery, [
                  threadId,
                  messageTimestamp,
                  item.withPreviousMessages,
                ]);

                for (const row of prevResults) {
                  messageIdsToFetch.add(row.id);
                }
              }

              // Get next messages if requested
              if (item.withNextMessages && item.withNextMessages > 0) {
                const nextQuery = `
                  SELECT id FROM ${fullTableName} 
                  WHERE thread_id = ? AND created_at > ? 
                  ORDER BY created_at ASC 
                  LIMIT ?
                `;
                const nextResults = await this.executeQuery(nextQuery, [
                  threadId,
                  messageTimestamp,
                  item.withNextMessages,
                ]);

                for (const row of nextResults) {
                  messageIdsToFetch.add(row.id);
                }
              }
            }
          }
        }
      }

      // If we need the most recent messages
      if (limit > 0) {
        let limitQuery = `
          SELECT id FROM ${fullTableName} 
          WHERE thread_id = ? 
          ORDER BY created_at DESC 
          LIMIT ?
        `;
        const limitParams = [threadId, limit];

        const latestResults = await this.executeQuery(limitQuery, limitParams);
        for (const row of latestResults) {
          messageIdsToFetch.add(row.id);
        }
      }

      // Now fetch all the messages we need
      let mainQuery;
      let mainParams: any[];

      if (messageIdsToFetch.size > 0) {
        const messageIds = Array.from(messageIdsToFetch);
        const placeholders = messageIds.map(() => '?').join(',');

        mainQuery = `
          SELECT * FROM ${fullTableName} 
          WHERE thread_id = ? AND id IN (${placeholders}) 
          ORDER BY created_at ASC
        `;
        mainParams = [threadId, ...messageIds];
      } else {
        // Fallback to getting the latest messages
        mainQuery = `
          SELECT * FROM ${fullTableName} 
          WHERE thread_id = ? 
          ORDER BY created_at ASC 
          LIMIT ?
        `;
        mainParams = [threadId, limit > 0 ? limit : 40];
      }

      const results = await this.executeQuery(mainQuery, mainParams);

      // Process messages
      const messages = results.map((msg: any) => {
        const processedMsg: Record<string, any> = {};

        for (const [key, value] of Object.entries(msg)) {
          processedMsg[key] = this.deserializeValue(value);
        }

        return processedMsg as unknown as T;
      });

      // Sort by creation time to ensure proper order
      messages.sort((a: any, b: any) => {
        const timeA = new Date(a.created_at || a.createdAt).getTime();
        const timeB = new Date(b.created_at || b.createdAt).getTime();
        return timeA - timeB;
      });

      this.logger.debug(`Retrieved ${messages.length} messages for thread ${threadId}`);
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

    const fullTableName = this.getTableName(tableName);

    try {
      // Use a transaction for better performance and atomicity
      const beginTxn = `BEGIN TRANSACTION`;
      await this.executeQuery(beginTxn);

      try {
        // Process records in batches for better performance
        const batchSize = 50; // Adjust based on performance testing

        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);

          // Process each record in the current batch
          for (const record of batch) {
            const now = new Date();
            const recordToInsert = {
              ...record,
              createdAt: record.createdAt || now,
              updatedAt: record.updatedAt || now,
            };

            await this.insert({ tableName, record: recordToInsert });
          }

          this.logger.debug(
            `Processed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(records.length / batchSize)}`,
          );
        }

        // Commit the transaction if all inserts succeeded
        const commitTxn = `COMMIT`;
        await this.executeQuery(commitTxn);

        this.logger.debug(`Successfully batch inserted ${records.length} records into ${tableName}`);
      } catch (error) {
        // Rollback on error
        const rollbackTxn = `ROLLBACK`;
        await this.executeQuery(rollbackTxn);
        throw error;
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
}
