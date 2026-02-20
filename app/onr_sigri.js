import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { SETTINGS } from "./settings.js";
import { insertResult, createDocument } from "./db.js";

const PLAYWRIGHT_TIMEOUT_MS = 60_000;

/* =========================================================
   Helpers
========================================================= */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function asBackendPath(workerPath) {
  const abs = path.resolve(workerPath);
  const dataDir = path.resolve(SETTINGS.DATA_DIR);
  if (abs.startsWith(dataDir + path.sep)) {
    return abs.replace(dataDir, SETTINGS.BACKEND_UPLOADS_BASE);
  }
  return abs;
}

function validateJobPayload(job) {
  const payload = job?.payload_json;
  const search = payload?.search;

  const type = (search?.type || "").toString().trim().toUpperCase();
  const value = (search?.value || "").toString().trim();

  if (!payload) throw new Error("Payload inválido: payload_json ausente");
  if (!search) throw new Error("Payload inválido: search ausente");
  if (!["CAR", "ENDERECO"].includes(type)) {
    throw new Error("Payload inválido: search.type deve ser CAR ou ENDERECO");
  }
  if (!value) throw new Error("Payload inválido: search.value vazio");

  const projectId = job?.project_id;
  if (!projectId) throw new Error("ONR_SIGRI_CONSULTA exige project_id");

  return { type, value, projectId: Number(projectId) };
}

/* =========================================================
   Execução ONR / SIG-RI
========================================================= */
export async function executarONR(job, logger) {
  const { type, value, projectId } = validateJobPayload(job);

  logger.info(
    { job_id: job.id, project_id: projectId, search_type: type },
    "Iniciando ONR/SIG-RI"
  );

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: true
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);

    /* =========================
       LOGIN
    ========================= */
    await page.goto("https://mapa.onr.org.br/sigri/login-usuario", {
      waitUntil: "domcontentloaded"
    });

    const btnCert = page.getByText("Entrar com Certificado Digital");
    if (await btnCert.count() > 0) {
      await btnCert.first().click({ timeout: 15_000 });
      logger.info({ job_id: job.id }, "Clique em 'Entrar com Certificado Digital' executado");
    } else {
      logger.info({ job_id: job.id }, "Botão de certificado não encontrado (auto-login provável)");
    }

    await page.waitForTimeout(3_000);
    await page.goto("https://mapa.onr.org.br", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);

    /* =========================
       CAMADA DE BUSCA
    ========================= */
    try {
      await page.getByText("Camada de Busca").first().click({ timeout: 20_000 });
    } catch {
      await page.getByText("Camada").first().click({ timeout: 20_000 });
    }

    await page.waitForTimeout(800);

    if (type === "CAR") {
      await page.getByText("Cadastro Ambiental Rural").click({ timeout: 20_000 });
    } else {
      await page.getByText("Endereço").click({ timeout: 20_000 });
    }

    /* =========================
       BUSCA
    ========================= */
    const input = page.locator("input:visible").first();
    if ((await input.count()) === 0) {
      throw new Error("Campo de busca não encontrado no ONR");
    }

    await input.fill(value);
    await page.waitForTimeout(1500);

    try {
      const opt = page.locator("[role='listbox'] [role='option']").first();
      if (await opt.count()) {
        await opt.click({ timeout: 10_000 });
      } else {
        await input.press("Enter");
      }
    } catch {
      await input.press("Enter");
    }

    await page.waitForTimeout(6_000);

    /* =========================
       🔴 PASSO CRÍTICO — CLICAR NO POLÍGONO
       (sem isso o botão "Baixar polígono" NÃO aparece)
    ========================= */
    logger.info({ job_id: job.id }, "Clicando no polígono no mapa");
    await page.mouse.click(800, 450);
    await page.waitForTimeout(3_000);

    /* =========================
       DOWNLOAD KMZ
    ========================= */
    let download;
    try {
      [download] = await Promise.all([
        page.waitForEvent("download", { timeout: PLAYWRIGHT_TIMEOUT_MS }),
        page.getByText("Baixar polígono").click({ timeout: 20_000 })
      ]);
    } catch {
      [download] = await Promise.all([
        page.waitForEvent("download", { timeout: PLAYWRIGHT_TIMEOUT_MS }),
        page
          .locator("[title*='Baixar'][title*='polígono'], [aria-label*='Baixar'][aria-label*='polígono']")
          .first()
          .click({ timeout: 20_000 })
      ]);
    }

    const outDir = path.join(SETTINGS.DATA_DIR, "onr-sigri");
    ensureDir(outDir);

    const fileName = `onr_${projectId}_${Date.now()}.kmz`;
    const workerPath = path.join(outDir, fileName);

    await download.saveAs(workerPath);

    const backendPath = asBackendPath(workerPath);

    /* =========================
       REGISTROS NO BANCO
    ========================= */
    const documentId = await createDocument({
      project_id: projectId,
      doc_type: "ONR_SIGRI_POLIGONO",
      stored_filename: fileName,
      original_filename: fileName,
      content_type: "application/vnd.google-earth.kmz",
      description: `Polígono ONR/SIG-RI (${type}: ${value})`,
      file_path: backendPath
    });

    await insertResult(job.id, {
      protocolo: null,
      matricula: null,
      cnm: null,
      cartorio: null,
      data_pedido: null,
      file_path: backendPath,
      metadata_json: {
        fonte: "ONR_SIGRI",
        document_id: documentId,
        search: { type, value },
        saved_worker_path: workerPath,
        saved_backend_path: backendPath,
        saved_at_utc: new Date().toISOString()
      }
    });

    logger.info(
      { job_id: job.id, project_id: projectId, document_id: documentId },
      "ONR/SIG-RI concluído"
    );
  } finally {
    await browser.close();
  }
}