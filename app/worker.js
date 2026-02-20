import pino from "pino";
import { fetchPendingJob, updateJobStatus } from "./db.js";
import { executarONR } from "./onr_sigri.js";
import { SETTINGS } from "./settings.js";

const logger = pino({ level: "info" });

logger.info("🤖 Worker ONR iniciado");

async function loop() {
  while (true) {
    try {
      const job = await fetchPendingJob();

      if (!job) {
        await new Promise(r => setTimeout(r, SETTINGS.POLL_INTERVAL_MS));
        continue;
      }

      try {
        await executarONR(job, logger);
        await updateJobStatus(job.id, "COMPLETED");
      } catch (err) {
        logger.error({ err, job_id: job.id }, "Erro no job ONR");
        await updateJobStatus(job.id, "FAILED", err.message);
      }

    } catch (err) {
      logger.fatal({ err }, "Falha crítica no worker");
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

loop();
