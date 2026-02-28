import mysql from "mysql2/promise";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3307;
const DEFAULT_DATABASE = "punch_cards";
const DEFAULT_USER = "root";

export interface CompiledPromptRow {
  prompt_id: string;
  module_name: string;
  signature_name: string;
  compiled_prompt: string;
  compiled_at: Date;
  dspy_version: string;
}

function createConnection() {
  return mysql.createConnection({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    database: DEFAULT_DATABASE,
    user: DEFAULT_USER,
  });
}

export async function readCompiledPrompt(promptId: string): Promise<CompiledPromptRow | null> {
  const connection = await createConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT prompt_id, module_name, signature_name, compiled_prompt, compiled_at, dspy_version
       FROM compiled_prompts
       WHERE prompt_id = ?`,
      [promptId]
    );

    const typedRows = rows as CompiledPromptRow[];
    return typedRows.length > 0 ? typedRows[0] : null;
  } finally {
    await connection.end();
  }
}

export async function listCompiledPrompts(): Promise<CompiledPromptRow[]> {
  const connection = await createConnection();
  try {
    const [rows] = await connection.execute(
      `SELECT prompt_id, module_name, signature_name, compiled_prompt, compiled_at, dspy_version
       FROM compiled_prompts
       ORDER BY compiled_at DESC`
    );

    return rows as CompiledPromptRow[];
  } finally {
    await connection.end();
  }
}

