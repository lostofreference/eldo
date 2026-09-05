const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "session_data.json");

(async () => {
  try {
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const contexts = browser.contexts();

    if (contexts.length === 0) {
      throw new Error("Нет открытых контекстов в Chrome!");
    }

    const context = contexts[0];
    const pages = context.pages();

    // Находим страницу с eldorado.gg
    let page = pages.find((p) => p.url().includes("eldorado.gg"));
    if (!page) {
      page = pages[0];
    }

    console.log(`Подключено к странице: ${page.url()}`);

    // Извлекаем Cookies
    const cookies = await context.cookies();

    // Извлекаем LocalStorage и SessionStorage напрямую из JS контекста страницы
    const storageData = await page.evaluate(() => {
      const local = {};
      const session = {};

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        local[key] = localStorage.getItem(key);
      }

      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        session[key] = sessionStorage.getItem(key);
      }

      return { local, session };
    });

    const fullSession = {
      cookies,
      localStorage: storageData.local,
      sessionStorage: storageData.session,
    };

    fs.writeFileSync(SESSION_FILE, JSON.stringify(fullSession, null, 2));

    console.log("--------------------------------------------------");
    console.log(`✅ Расширенная сессия сохранена в: ${SESSION_FILE}`);
    console.log(`- Сохранено cookies: ${cookies.length}`);
    console.log(
      `- Сохранено ключей LocalStorage: ${Object.keys(storageData.local).length}`,
    );
    console.log("--------------------------------------------------");

    process.exit(0);
  } catch (error) {
    console.error("❌ Ошибка:", error.message);
    process.exit(1);
  }
})();
