const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { OpenAI } = require("openai");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

// Рандомизация паузы для симуляции поведения человека
const getRandomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SESSION_FILE = path.join(__dirname, "session_data.json");
const CHECK_INTERVAL_MS = 6000;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are a polite and fast automated support and sales assistant for an Eldorado.gg seller specializing in Pokémon GO Stardust Farming.

Rules:
1. ANSWER ONLY WHAT WAS ASKED. Do not output generic warnings, delivery times, or instructions unless the user specifically requested them in their message.
2. If the user says hello or asks a generic question, respond politely and ask how you can help.
3. IF (and ONLY if) the user asks about start/process/login: Ask for Login Provider (Google/PTC/Facebook) + Email/Pass + 2FA codes for Google.
4. IF (and ONLY if) the user asks about delivery/completion time: Mention that it takes around 4 hours per 1,000,000 Stardust on average.
5. IF (and ONLY if) they ask about safety: Remind them not to log into the game during farming to avoid softbans.
6. IF (and ONLY if) they ask about preparation: Tell them to free up 50-100 Pokemon storage slots.
7. REFUNDS & DISPUTES: If they ask for a refund or have an issue, reply: "I have escalated this issue to the seller. They will review it as soon as possible."
8. Keep all responses strictly under 2 short sentences in customer language.
9. IF THE USER SENDS CREDENTIALS (Username, Email, Password, or 2FA codes):
   - Acknowledge receiving them ("Thank you for the details!").
   - If Password or Provider (Google/PTC/Facebook) is missing, ask for it.
   - If details are complete, confirm farming will start shortly and strictly remind them NOT to log in during the process.
`.trim();

const answeredMessages = new Set();

(async () => {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error("❌ Файл session_data.json не найден!");
    process.exit(1);
  }

  const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

  // Маскировка Chromium от антибот-систем
  const browser = await puppeteer.launch({
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,900",
      "--disable-infobars",
    ],
  });

  const page = await browser.newPage();

  // Удаление следов webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );

  await page.setViewport({ width: 1440, height: 900 });

  if (sessionData.cookies) {
    await page.setCookie(...sessionData.cookies);
  }

  if (sessionData.localStorage) {
    await page.evaluateOnNewDocument((ls) => {
      Object.entries(ls).forEach(([k, v]) => window.localStorage.setItem(k, v));
    }, sessionData.localStorage);
  }

  console.log("🌐 Переходим на страницу сообщений Eldorado...");
  await page.goto("https://www.eldorado.gg/dashboard/messages", {
    waitUntil: "domcontentloaded",
  });
  await sleep(getRandomDelay(5000, 7000));

  console.log(
    "🤖 [AutoBot] Отслеживание активных и фоновых непрочитанных сообщений запущено...",
  );

  let isProcessing = false;

  setInterval(
    async () => {
      if (isProcessing) return;

      try {
        const chatFrame = page
          .frames()
          .find((f) => f.url().includes("talkjs.com"));

        if (!chatFrame) return;

        isProcessing = true;

        const handleCurrentChat = async (label) => {
          const chatData = await chatFrame.evaluate(() => {
            const rows = Array.from(
              document.querySelectorAll('[class*="UserMessage__message-row"]'),
            );
            if (!rows.length) return null;

            const history = rows
              .slice(-6)
              .map((row) => {
                const isBuyer =
                  row.className.includes("by-other") ||
                  !row.className.includes("by-me");
                const textNode = row.querySelector(
                  '[class*="MessageBody__message-text"]',
                );
                return {
                  role: isBuyer ? "user" : "assistant",
                  content: textNode ? textNode.innerText.trim() : "",
                };
              })
              .filter((m) => m.content);

            const lastMsg = history[history.length - 1];

            return {
              history,
              isBuyer: lastMsg ? lastMsg.role === "user" : false,
              lastText: lastMsg ? lastMsg.content : "",
            };
          });

          if (chatData && chatData.isBuyer && chatData.lastText) {
            const msgKey = chatData.lastText;

            if (!answeredMessages.has(msgKey)) {
              console.log(
                `\n💬 [${label}] Покупатель пишет: "${chatData.lastText}"`,
              );
              console.log("🤖 Запрос к OpenAI...");

              const apiMessages = [
                { role: "system", content: SYSTEM_PROMPT },
                ...chatData.history,
              ];

              const aiCompletion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: apiMessages,
                temperature: 0.2,
                max_tokens: 150,
              });

              const replyText = aiCompletion.choices[0].message.content.trim();
              console.log(`✨ AI Ответ: "${replyText}"`);

              const inputSelector = '.ProseMirror[contenteditable="true"]';
              const sendButtonSelector =
                'button[class*="send-button"], button.MessageField__send-button';

              const typedSuccessfully = await chatFrame.evaluate(
                ({ sel, text }) => {
                  const inputEl = document.querySelector(sel);
                  if (!inputEl) return false;

                  inputEl.focus();
                  document.execCommand("selectAll", false, null);
                  document.execCommand("insertText", false, text);
                  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
                  return true;
                },
                { sel: inputSelector, text: replyText },
              );

              if (typedSuccessfully) {
                await sleep(getRandomDelay(400, 800));

                const sentByBtn = await chatFrame.evaluate((sel) => {
                  const btn = document.querySelector(sel);
                  if (btn) {
                    btn.click();
                    return true;
                  }
                  return false;
                }, sendButtonSelector);

                if (sentByBtn) {
                  console.log("✅ Ответ успешно отправлен!");
                  answeredMessages.add(msgKey);
                } else {
                  console.error("❌ Кнопка отправки не найдена.");
                }
              } else {
                console.error("❌ Поле ввода не найдено.");
              }
            }
          }
        };

        // 1. Проверяем текущий открытый чат
        await handleCurrentChat("Открытый чат");

        // 2. Ищем фоновые не прочтенные чаты
        const unreadIndexes = await chatFrame.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll('a[class*="ConversationListItem"]'),
          );
          const unreadList = [];

          items.forEach((item, index) => {
            const hasUnreadMarker = item.querySelector(
              '[class*="unread" i], [class*="Unread" i], [class*="badge" i], [class*="dot" i], [class*="Count" i]',
            );
            if (hasUnreadMarker) {
              unreadList.push(index);
            }
          });

          return unreadList;
        });

        // 3. Переходим по фоновым чатам
        for (let i = 0; i < unreadIndexes.length; i++) {
          const chatIndex = unreadIndexes[i];
          const currentChatLinks = await chatFrame.$$(
            'a[class*="ConversationListItem"]',
          );

          if (!currentChatLinks[chatIndex]) continue;

          await currentChatLinks[chatIndex].click();
          await sleep(getRandomDelay(1200, 2000));

          await handleCurrentChat(
            `Фоновый чат ${i + 1}/${unreadIndexes.length}`,
          );
          await sleep(getRandomDelay(800, 1500));
        }
      } catch (err) {
        console.error("⚠️ Ошибка в цикле:", err.message);
      } finally {
        isProcessing = false;
      }
    },
    CHECK_INTERVAL_MS + getRandomDelay(500, 1500),
  );
})();
