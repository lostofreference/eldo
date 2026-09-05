const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const fs = require("fs");
const path = require("path");

chromium.use(stealth);

const SESSION_FILE = path.join(__dirname, "session_data.json");
const HISTORY_FILE = path.join(__dirname, "sent_offers_history.json");

const PRICE_PER_MILLION = 1;
const MAX_STARDUST_LIMIT = 5000000; // 10M
const CHECK_INTERVAL_MS = 10000;

function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return new Set(JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")));
    } catch (e) {
      return new Set();
    }
  }
  return new Set();
}

function saveHistory(historySet) {
  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(Array.from(historySet), null, 2),
  );
}

function parseStardustValue(text) {
  if (!text) return 0;
  const lower = text.toLowerCase().replace(/,/g, "");

  const millionMatch = lower.match(/([0-9.]+)\s*m/);
  if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1000000);

  const thousandMatch = lower.match(/([0-9.]+)\s*k/);
  if (thousandMatch) return Math.round(parseFloat(thousandMatch[1]) * 1000);

  const directMatch = lower.match(/\b([0-9]{5,8})\b/);
  if (directMatch) return parseInt(directMatch[1], 10);

  return 0;
}

// ⏱️ Определение срока выполнения по количеству Stardust
function getDeliveryTimeConfig(stardust) {
  if (stardust <= 1000000) {
    return { label: "3 hours", regex: /3\s*(hours|h|часо)/i };
  }
  if (stardust <= 2000000) {
    return { label: "5 hours", regex: /5\s*(hours|h|часо)/i };
  }
  if (stardust <= 3000000) {
    return { label: "8 hours", regex: /8\s*(hours|h|часо)/i };
  }
  if (stardust <= 4000000) {
    return { label: "12 hours", regex: /12\s*(hours|h|часо)/i };
  }
  return { label: "1 day", regex: /1\s*(day|d|день)|24\s*(hours|h|часо)/i };
}

// 💬 Отправка сообщения с переключением на TalkJS iframe
async function sendChatMessageOnPage(page, textMessage) {
  try {
    // 1. Нажимаем кнопку "Chat with buyer"
    const openChatBtn = page
      .locator('button[aria-label="Chat with buyer"]')
      .first();

    if (await openChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('🔘 Нажимаем "Chat with buyer"...');
      await openChatBtn.click({ force: true });
      await page.waitForTimeout(1500);
    }

    // 2. Подключаемся к первому ВИДИМОМУ iframe чата
    console.log("⏳ Ожидаем загрузку iframe чата...");
    const chatFrame = page
      .frameLocator('iframe[src*="talkjs"], iframe[title*="chat"]')
      .first();

    // 3. Селекторы элементов
    const inputSelector =
      'div.ProseMirror[contenteditable="true"], .test__entry-field, div[role="textbox"]';

    const editorLocator = chatFrame.locator(inputSelector).first();

    await editorLocator.waitFor({ state: "visible", timeout: 12000 });

    // 4. Вводим текст через evaluate
    await editorLocator.evaluate((inputEl, text) => {
      inputEl.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }, textMessage);

    await page.waitForTimeout(500);

    // 5. Ищем кнопку отправки
    const sendBtnLocator = chatFrame
      .locator(
        [
          'button[class*="send-button"]',
          "button.MessageField__send-button",
          "button.test__send-button",
          'button[type="submit"]',
          'button[aria-label*="send" i]',
        ].join(", "),
      )
      .first();

    if (await sendBtnLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sendBtnLocator.click({ force: true });
      console.log(`💬 Чат: Сообщение успешно отправлено (через кнопку)!`);
    } else {
      await editorLocator.press("Enter");
      console.log(`💬 Чат: Сообщение успешно отправлено (через Enter)!`);
    }

    await page.waitForTimeout(1000);
    return true;
  } catch (err) {
    console.error(`⚠️ Не удалось отправить сообщение в чат:`, err.message);
    return false;
  }
}

// 💰 Создание оффера в модальном окне с динамическим выбором времени
async function sendEldoradoOfferAccurate(page, price, stardust) {
  try {
    const openModalBtn = page
      .locator(
        'eld-button[datatestid*="create-boosting-offer-button"], button[aria-label="Create offer"], button:has-text("Create offer")',
      )
      .first();

    if (!(await openModalBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('⚠️ Кнопка "Create offer" не найдена.');
      return false;
    }

    await openModalBtn.click();
    await page.waitForTimeout(1500);

    const modal = page
      .locator('mat-dialog-container, .cdk-overlay-pane, div[role="dialog"]')
      .last();
    await modal.waitFor({ state: "visible", timeout: 5000 });

    // Ввод цены
    const priceInput = modal.locator("input").first();
    await priceInput.click();
    await priceInput.fill("");
    await priceInput.type(price.toString(), { delay: 100 });
    console.log(`📝 Оффер: Введена цена $${price}`);
    await page.waitForTimeout(500);

    // Динамический выбор времени выполнения
    const timeConfig = getDeliveryTimeConfig(stardust);
    const dropdownTrigger = modal
      .locator(
        'mat-select, [role="combobox"], input[readonly], .ng-select, .select-trigger',
      )
      .first();

    if (await dropdownTrigger.isVisible().catch(() => false)) {
      await dropdownTrigger.click();
      await page.waitForTimeout(800);

      const option = page
        .locator('mat-option, [role="option"], .select-option, li')
        .filter({
          hasText: timeConfig.regex,
        })
        .first();

      if (await option.isVisible().catch(() => false)) {
        await option.click();
        console.log(`⏱️ Выбран срок: ${timeConfig.label}`);
      } else {
        console.log(
          `⚠️ Нужная опция (${timeConfig.label}) не найдена, выбираем через клавиатуру...`,
        );
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      }
    }

    await page.waitForTimeout(1000);

    // Отправка оффера
    const submitBtn = modal
      .locator('button:has-text("Create offer"), button[type="submit"]')
      .first();

    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      console.log(
        `🚀 Оффер на $${price} (${timeConfig.label}) успешно отправлен!`,
      );
      await page.waitForTimeout(2500);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`❌ Ошибка отправки оффера:`, err.message);
    return false;
  }
}

async function closeModalOrPanel(page) {
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  } catch (e) {}
}

(async () => {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error("❌ Файл session_data.json не найден!");
    process.exit(1);
  }

  const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  const processedHistory = loadHistory();

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  if (sessionData.cookies) {
    await context.addCookies(sessionData.cookies);
  }

  const page = await context.newPage();

  await page.addInitScript((data) => {
    if (data.localStorage) {
      Object.entries(data.localStorage).forEach(([k, v]) =>
        window.localStorage.setItem(k, v),
      );
    }
  }, sessionData);

  console.log("🔴 БОТ ЗАПУЩЕН В ЛАЙВ-РЕЖИМЕ!");
  console.log("====================================");

  while (true) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n🔍 [${timestamp}] Проверка новых заказов...`);

    try {
      if (!page.url().includes("/dashboard/notifications")) {
        await page.goto("https://www.eldorado.gg/dashboard/notifications", {
          waitUntil: "domcontentloaded",
        });
      } else {
        await page.reload({ waitUntil: "domcontentloaded" });
      }

      await page.waitForTimeout(3000);

      const requestLinks = await page.evaluate(() => {
        const anchors = Array.from(
          document.querySelectorAll('a[href*="/boosting-request/"]'),
        );
        const urls = anchors
          .filter(
            (a) =>
              a.innerText.includes("Stardust Farming") ||
              a.parentElement.innerText.includes("Stardust Farming"),
          )
          .map((a) => a.href);
        return Array.from(new Set(urls));
      });

      console.log(`🎯 Найдено актуальных ссылок: ${requestLinks.length}`);

      for (let i = 0; i < requestLinks.length; i++) {
        const link = requestLinks[i];

        if (processedHistory.has(link)) continue;

        console.log(
          `\n⚡ Обработка заказа (${i + 1}/${requestLinks.length}): ${link}`,
        );

        await page.goto(link, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);

        // Читаем количество Stardust
        const orderInfo = await page.evaluate(() => {
          const fullText = document.body.innerText;
          const lines = fullText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

          for (let idx = 0; idx < lines.length; idx++) {
            if (/Desired amount of stardust/i.test(lines[idx])) {
              const val = lines[idx + 1];
              if (
                val &&
                !val.includes("Chat") &&
                !val.includes("Create offer")
              ) {
                return val;
              }
            }
          }
          return "Not specified";
        });

        const numericStardust = parseStardustValue(orderInfo);

        if (numericStardust === 0 || numericStardust > MAX_STARDUST_LIMIT) {
          console.log(
            `⚠️ Пропуск: ${numericStardust} Stardust (превышает лимит 5M или не распаршено).`,
          );
          processedHistory.add(link);
          saveHistory(processedHistory);
          continue;
        }

        const calculatedPrice = (
          (numericStardust / 1000000) *
          PRICE_PER_MILLION
        ).toFixed(2);
        console.log(
          `📊 Stardust: ${numericStardust.toLocaleString()} | 💰 Расчетная цена: $${calculatedPrice}`,
        );

        // 1. Отправляем сообщение в чат
        const messageText = `Hello! I can complete your request for ${numericStardust.toLocaleString()} Stardust. Sent you an offer!`;
        await sendChatMessageOnPage(page, messageText);

        // 2. Создаем и отправляем оффер с динамическим сроком
        const offerSent = await sendEldoradoOfferAccurate(
          page,
          calculatedPrice,
          numericStardust,
        );

        if (offerSent) {
          console.log(`✅ Обработка заказа завершена успешно!`);
        }

        processedHistory.add(link);
        saveHistory(processedHistory);
        await closeModalOrPanel(page);
      }
    } catch (err) {
      console.error(`⚠️ Ошибка в главном цикле:`, err.message);
      await closeModalOrPanel(page);
    }

    console.log(
      `💤 Ожидание ${CHECK_INTERVAL_MS / 1000} секунд до следующей проверки...`,
    );
    await page.waitForTimeout(CHECK_INTERVAL_MS);
  }
})();
