import mysql from "mysql2/promise";

const DOLT_HOST = process.env.DOLT_HOST || "127.0.0.1";
const DOLT_PORT = Number.parseInt(process.env.DOLT_PORT || "3307", 10);
const DOLT_DATABASE = process.env.DOLT_DATABASE || "punch_cards";
const DOLT_USER = process.env.DOLT_USER || "root";

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
    host: DOLT_HOST,
    port: DOLT_PORT,
    database: DOLT_DATABASE,
    user: DOLT_USER,
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
