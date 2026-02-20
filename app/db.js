import pkg from "pg";
const { Pool } = pkg;

import { SETTINGS } from "./settings.js";

export const pool = new Pool({
  connectionString: SETTINGS.DATABASE_URL
});

export async function fetchPendingJob() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      UPDATE automation_jobs
      SET status = 'PROCESSING',
          started_at = NOW()
      WHERE id = (
        SELECT id
        FROM automation_jobs
        WHERE status = 'PENDING'
          AND type = 'ONR_SIGRI_CONSULTA'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `);
    return res.rows[0] || null;
  } finally {
    client.release();
  }
}

export async function updateJobStatus(jobId, status, errorMessage = null) {
  await pool.query(
    `
    UPDATE automation_jobs
    SET status = $1::automation_status,
        error_message = $2,
        finished_at = CASE
          WHEN $1::automation_status IN ('COMPLETED','FAILED') THEN NOW()
          ELSE finished_at
        END
    WHERE id = $3
    `,
    [status, errorMessage, jobId]
  );
}

export async function insertResult(jobId, data) {
  await pool.query(
    `
    INSERT INTO automation_results (
      job_id, protocolo, matricula, cnm, cartorio,
      data_pedido, file_path, metadata_json
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      jobId,
      data.protocolo,
      data.matricula,
      data.cnm,
      data.cartorio,
      data.data_pedido,
      data.file_path,
      data.metadata_json
    ]
  );
}

export async function createDocument(data) {
  const res = await pool.query(
    `
    INSERT INTO documents (
      project_id, matricula_id, doc_type,
      stored_filename, original_filename,
      content_type, description, file_path, uploaded_at
    )
    VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,NOW())
    RETURNING id
    `,
    [
      data.project_id,
      data.doc_type,
      data.stored_filename,
      data.original_filename,
      data.content_type,
      data.description,
      data.file_path
    ]
  );
  return res.rows[0].id;
}
