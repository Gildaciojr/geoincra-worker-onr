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

function normalizeLatLng(value) {
  const match = value.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (!match) throw new Error("Formato inválido de Latitude/Longitude");
  return `${match[1]}, ${match[2]}`;
}

function validateJobPayload(job) {
  const payload = job?.payload_json;
  const search = payload?.search;

  if (!payload) throw new Error("Payload inválido");
  if (!search) throw new Error("search ausente");

  let type = String(search.type || "").trim().toUpperCase();
  let value = String(search.value || "").trim();

  if (!["CAR", "ENDERECO", "LAT_LNG"].includes(type)) {
    throw new Error("search.type inválido");
  }

  if (!value) throw new Error("search.value vazio");

  if (type === "LAT_LNG") value = normalizeLatLng(value);

  if (!job.project_id) throw new Error("project_id obrigatório");

  return { type, value, projectId: Number(job.project_id) };
}

async function safeClick(locator, timeout = 15_000) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

async function activateAllLayers(page, logger, jobId) {
  logger.info({ job_id: jobId }, "Ativando todas as camadas");

  const opened =
    (await safeClick(page.locator(".placeholder-selecionar-camadas"))) ||
    (await safeClick(page.getByText(/Selecionar camadas/i)));

  if (!opened) {
    logger.warn({ job_id: jobId }, "Botão Selecionar camadas não encontrado");
    return false;
  }

  await safeClick(page.locator(".btn-toggle-camadas-all"));
  await page.waitForTimeout(6_000);
  return true;
}

/* =========================================================
   Execução ONR / SIG-RI
========================================================= */
export async function executarONR(job, logger) {
  const { type, value, projectId } = validateJobPayload(job);

  logger.info({ job_id: job.id, search_type: type }, "Iniciando ONR/SIG-RI");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);

    /* LOGIN */
    await page.goto("https://mapa.onr.org.br/sigri/login-usuario");
    const btnCert = page.getByText("Entrar com Certificado Digital");
    if (await btnCert.count()) await btnCert.first().click();

    await page.goto("https://mapa.onr.org.br");
    await page.waitForTimeout(5_000);

    /* CAMADA DE BUSCA */
    await safeClick(page.getByText("Camada para busca"));
    await page.waitForTimeout(500);

    if (type === "LAT_LNG") {
      await safeClick(page.getByText(/Latitude e Longitude/i));
    } else if (type === "CAR") {
      await safeClick(page.getByText(/Cadastro Ambiental Rural/i));
    } else {
      await safeClick(page.getByText(/Endere[cç]o/i));
    }

    /* BUSCA */
    const input = page.locator("input.geocoder-control-input").first();
    await input.fill(value);
    await input.press("Enter");
    await page.waitForTimeout(5_000);

    /* ATIVAR CAMADAS */
    await activateAllLayers(page, logger, job.id);

    /* 🔴 CLIQUE NO CENTRO DO MAPA (PONTO EXATO DA BUSCA) */
    const map = page.locator("#map");
    const box = await map.boundingBox();

    await page.mouse.click(
      box.x + box.width / 2,
      box.y + box.height / 2
    );

    await page.waitForTimeout(3_000);

    /* MODAL */
    const popup = page.locator(".leaflet-popup-content").first();
    await popup.waitFor({ state: "visible", timeout: 20_000 });

    const rows = popup.locator("div");
    const data = {};

    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).innerText()).trim();
      const [label, val] = text.split(":").map(v => v?.trim());
      if (label && val) data[label] = val;
    }

    const dadosImovel = {
      camada: data["Camada"] || null,
      codigo_sigef: data["Código Sigef"] || null,
      nome_area: data["Nome da Área"] || null,
      matricula: data["Matrícula"] || null,
      municipio: data["Município"] || null,
      uf: data["UF"] || null,
      ccir_sncr: data["CCIR/SNCR"] || null,
    };

    /* DOWNLOAD OPCIONAL */
    let backendPath = null;
    let documentId = null;

    const downloadBtn = page.locator(".leaflet-download-poligono i");
    if (await downloadBtn.count()) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 15_000 }),
          downloadBtn.first().click(),
        ]);

        const outDir = path.join(SETTINGS.DATA_DIR, "onr-sigri");
        ensureDir(outDir);

        const fileName = `onr_${projectId}_${Date.now()}.kmz`;
        const workerPath = path.join(outDir, fileName);
        await download.saveAs(workerPath);
        backendPath = asBackendPath(workerPath);

        documentId = await createDocument({
          project_id: projectId,
          doc_type: "ONR_SIGRI_POLIGONO",
          stored_filename: fileName,
          original_filename: fileName,
          content_type: "application/vnd.google-earth.kmz",
          description: "Polígono ONR/SIG-RI",
          file_path: backendPath,
        });
      } catch {
        logger.warn({ job_id: job.id }, "Polígono não disponível");
      }
    }

    await insertResult(job.id, {
      file_path: backendPath,
      metadata_json: {
        fonte: "ONR_SIGRI",
        search: { type, value },
        imovel: dadosImovel,
        document_id: documentId,
        download_disponivel: Boolean(backendPath),
        processed_at_utc: new Date().toISOString(),
      },
    });

    logger.info({ job_id: job.id }, "ONR/SIG-RI finalizado com sucesso");
  } finally {
    await browser.close();
  }
}