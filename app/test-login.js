import { chromium } from "playwright";
import fs from "fs";

(async () => {
  const browser = await chromium.launch({
    headless: true, // deixa headless mesmo
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://mapa.onr.org.br/sigri/login-usuario", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // tenta clicar se existir
    const btn = page.getByText("Entrar com Certificado Digital");
    if (await btn.count()) await btn.first().click({ timeout: 15000 });

    await page.waitForTimeout(5000);
    await page.goto("https://mapa.onr.org.br", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    await page.screenshot({ path: "/tmp/onr_login_check.png", fullPage: true });
    console.log("OK: screenshot em /tmp/onr_login_check.png");
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
