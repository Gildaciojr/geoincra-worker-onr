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
  // Aceita "-11.457972, -61.233511" ou "-11.457972 -61.233511"
  const match = value.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (!match) {
    throw new Error("Formato inválido de Latitude/Longitude");
  }
  return `${match[1]}, ${match[2]}`;
}

function validateJobPayload(job) {
  const payload = job?.payload_json;
  const search = payload?.search;

  if (!payload) throw new Error("Payload inválido: payload_json ausente");
  if (!search) throw new Error("Payload inválido: search ausente");

  let type = String(search.type || "").trim().toUpperCase();
  let value = String(search.value || "").trim();

  if (!["CAR", "ENDERECO", "LAT_LNG"].includes(type)) {
    throw new Error("search.type inválido");
  }

  if (!value) throw new Error("search.value vazio");

  if (type === "LAT_LNG") {
    value = normalizeLatLng(value);
  }

  const projectId = job?.project_id;
  if (!projectId) throw new Error("ONR_SIGRI_CONSULTA exige project_id");

  return { type, value, projectId: Number(projectId) };
}

async function safeClick(locator, { timeout = 20_000 } = {}) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function activateAllLayers(page, logger, jobId) {
  logger.info({ job_id: jobId }, "Ativando todas as camadas");

  const opened =
    (await safeClick(page.getByText("Selecionar camadas"))) ||
    (await safeClick(page.locator("text=/Selecionar\\s+camadas/i")));

  if (!opened) {
    logger.warn({ job_id: jobId }, "Seletor de camadas não encontrado");
    return false;
  }

  await safeClick(page.getByText(/Ativar todas/i));
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

  let dadosImovel = null;

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

    if (type === "CAR") {
      await safeClick(page.getByText(/Cadastro Ambiental Rural/i));
    } else if (type === "LAT_LNG") {
      await safeClick(page.getByText(/Latitude e Longitude/i));
    } else {
      await safeClick(page.getByText(/Endere[cç]o/i));
    }

    /* BUSCA */
    const input = page.locator("input.geocoder-control-input").first();
    await input.fill(value);
    await input.press("Enter");
    await page.waitForTimeout(6_000);

    /* SEM RESULTADO */
    if (await page.getByText(/Não foi possível localizar/i).count()) {
      await insertResult(job.id, {
        file_path: null,
        metadata_json: {
          fonte: "ONR_SIGRI",
          search: { type, value },
          download_disponivel: false,
          motivo: "Nenhum resultado encontrado",
          processed_at_utc: new Date().toISOString(),
        },
      });
      return;
    }

    /* CAMADAS */
    await activateAllLayers(page, logger, job.id);

    /* CLIQUE NO MAPA */
    const canvas = page.locator("#map canvas.leaflet-zoom-animated").first();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(3_000);

    /* MODAL */
    const popup = page.locator(".leaflet-popup-content").first();
    await popup.waitFor({ state: "visible", timeout: 20_000 });
    const text = await popup.innerText();

    function extract(label) {
      const r = new RegExp(`${label}\\s*:?\\s*([^\\n]+)`, "i");
      const m = text.match(r);
      return m ? m[1].trim() : null;
    }

    dadosImovel = {
      camada: extract("Camada"),
      codigo_sigef: extract("Sigef"),
      nome_area: extract("Nome"),
      matricula: extract("Matrícula"),
      municipio: extract("Município"),
      uf: extract("UF"),
      ccir_sncr: extract("CCIR|SNCR"),
    };

    /* DOWNLOAD */
    let download = null;
    const baixar = page.getByText(/Baixar pol[ií]gono/i);
    if (await baixar.count()) {
      [download] = await Promise.all([
        page.waitForEvent("download"),
        baixar.first().click(),
      ]);
    }

    let backendPath = null;
    let documentId = null;

    if (download) {
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