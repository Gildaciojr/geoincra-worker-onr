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
  logger.info({ job_id: jobId }, "Abrindo seletor de camadas");

  // 1) abre o dropdown/btn "Selecionar camadas"
  const opened =
    (await safeClick(page.getByText("Selecionar camadas"), { timeout: 20_000 })) ||
    (await safeClick(page.getByRole("button", { name: /Selecionar camadas/i }), { timeout: 20_000 })) ||
    (await safeClick(page.locator("text=/Selecionar\\s+camadas/i"), { timeout: 20_000 }));

  if (!opened) {
    logger.warn({ job_id: jobId }, "Não consegui abrir 'Selecionar camadas' (seguindo mesmo assim)");
    return false;
  }

  // 2) clica "Ativar todas"
  const activated =
    (await safeClick(page.getByText(/Ativar todas/i), { timeout: 20_000 })) ||
    (await safeClick(page.getByRole("button", { name: /Ativar todas/i }), { timeout: 20_000 })) ||
    (await safeClick(page.locator("text=/Ativar\\s+todas/i"), { timeout: 20_000 }));

  if (!activated) {
    logger.warn({ job_id: jobId }, "Botão 'Ativar todas' não encontrado (camadas podem já estar ativas)");
    return false;
  }

  logger.info({ job_id: jobId }, "Camadas ativadas (Ativar todas)");
  await page.waitForTimeout(6_000); // tempo pro mapa renderizar polígonos
  return true;
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
    const context = await browser.newContext({ acceptDownloads: true });
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

    // abre mapa
    await page.waitForTimeout(3_000);
    await page.goto("https://mapa.onr.org.br", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);

    /* =========================
       CAMADA DE BUSCA (topo)
    ========================= */
    // Pelo seu print, o label real é "Camada para busca"
    // Mantemos fallback para "Camada de Busca"
    const openedSearchLayer =
      (await safeClick(page.getByText("Camada para busca"), { timeout: 20_000 })) ||
      (await safeClick(page.getByText("Camada de Busca"), { timeout: 20_000 })) ||
      (await safeClick(page.getByText("Camada"), { timeout: 20_000 }));

    if (!openedSearchLayer) {
      throw new Error("Não consegui abrir o seletor 'Camada para busca'");
    }

    await page.waitForTimeout(800);

    if (type === "CAR") {
      const ok =
        (await safeClick(page.getByText("Cadastro Ambiental Rural"), { timeout: 20_000 })) ||
        (await safeClick(page.locator("text=/Cadastro Ambiental Rural/i"), { timeout: 20_000 }));
      if (!ok) throw new Error("Opção 'Cadastro Ambiental Rural' não encontrada");
    } else {
      const ok =
        (await safeClick(page.getByText("Endereço"), { timeout: 20_000 })) ||
        (await safeClick(page.locator("text=/Endere[cç]o/i"), { timeout: 20_000 }));
      if (!ok) throw new Error("Opção 'Endereço' não encontrada");
    }

    /* =========================
       BUSCA (campo principal)
    ========================= */
    const input = page.locator("input:visible").first();
    if ((await input.count()) === 0) {
      throw new Error("Campo de busca não encontrado no ONR");
    }

    await input.fill(value);
    await page.waitForTimeout(1_500);

    // autocomplete ou Enter
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
       PASSO CRÍTICO: ATIVAR CAMADAS
       (sem isso não tem polígono e não tem "Baixar polígono")
    ========================= */
    await activateAllLayers(page, logger, job.id);

    /* =========================
       CLICAR NO POLÍGONO (abre modal)
    ========================= */
    logger.info({ job_id: job.id }, "Tentando selecionar polígono no mapa");

    // clique em área central (ajuste fino pode ser necessário dependendo do zoom)
    try {
      await page.mouse.click(900, 520);
      await page.waitForTimeout(2_500);
    } catch {
      logger.warn({ job_id: job.id }, "Clique no mapa falhou (seguindo mesmo assim)");
    }

    /* =========================
       DOWNLOAD KMZ
    ========================= */
    // IMPORTANTÍSSIMO: só tenta clicar se estiver visível (evita timeout besta)
    const baixarPoligono = page.getByText(/Baixar pol[ií]gono/i).first();

    let download = null;
    if (await baixarPoligono.count()) {
      try {
        await baixarPoligono.waitFor({ state: "visible", timeout: 20_000 });

        logger.info({ job_id: job.id }, "Botão 'Baixar polígono' visível, iniciando download");
        [download] = await Promise.all([
          page.waitForEvent("download", { timeout: PLAYWRIGHT_TIMEOUT_MS }),
          baixarPoligono.click({ timeout: 20_000 })
        ]);
      } catch {
        // fallback extra (alguns casos o botão é ícone)
        const fallbackBtn = page.locator(
          "button:has-text('Baixar'), [title*='Baixar'], [aria-label*='Baixar']"
        ).first();

        if (await fallbackBtn.count()) {
          await fallbackBtn.waitFor({ state: "visible", timeout: 20_000 });
          logger.info({ job_id: job.id }, "Fallback de download encontrado, clicando");
          [download] = await Promise.all([
            page.waitForEvent("download", { timeout: PLAYWRIGHT_TIMEOUT_MS }),
            fallbackBtn.click({ timeout: 20_000 })
          ]);
        }
      }
    }

    /* =========================
       SALVAMENTO (SE EXISTIR)
    ========================= */
    let backendPath = null;
    let documentId = null;
    let workerPath = null;

    if (download) {
      const outDir = path.join(SETTINGS.DATA_DIR, "onr-sigri");
      ensureDir(outDir);

      const fileName = `onr_${projectId}_${Date.now()}.kmz`;
      workerPath = path.join(outDir, fileName);

      await download.saveAs(workerPath);
      backendPath = asBackendPath(workerPath);

      documentId = await createDocument({
        project_id: projectId,
        doc_type: "ONR_SIGRI_POLIGONO",
        stored_filename: fileName,
        original_filename: fileName,
        content_type: "application/vnd.google-earth.kmz",
        description: `Polígono ONR/SIG-RI (${type}: ${value})`,
        file_path: backendPath
      });

      logger.info({ job_id: job.id, document_id: documentId }, "KMZ salvo e document criado");
    } else {
      logger.warn(
        { job_id: job.id },
        "Não houve download (modal pode não ter aberto ou imóvel sem KMZ disponível)"
      );
    }

    /* =========================
       RESULTADO DA AUTOMAÇÃO
    ========================= */
    await insertResult(job.id, {
      protocolo: null,
      matricula: null,
      cnm: null,
      cartorio: null,
      data_pedido: null,
      file_path: backendPath, // pode ser null (OK)
      metadata_json: {
        fonte: "ONR_SIGRI",
        document_id: documentId,
        download_disponivel: Boolean(download),
        search: { type, value },
        saved_worker_path: workerPath,
        saved_backend_path: backendPath,
        processed_at_utc: new Date().toISOString()
      }
    });

    logger.info(
      { job_id: job.id, project_id: projectId, document_id: documentId },
      "ONR/SIG-RI finalizado"
    );
  } finally {
    await browser.close();
  }
}