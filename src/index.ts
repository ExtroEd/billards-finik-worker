import mqtt from "mqtt";

export interface Env {
  MQTT_BROKER_URL: string;
  MQTT_USER: string;
  MQTT_PASS: string;
  TG_BOT_TOKEN: string;
  ADMIN_PASSWORD?: string;
  OPERATOR_PASSWORD?: string;
  CLUB_PREFIX: string;
  BILLIARDS_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const rawBody = await request.text();
      const bodyJson = JSON.parse(rawBody);

      // 🤖 1. Входящий Webhook от Telegram Bot
      if (bodyJson.message && bodyJson.message.chat) {
        const chatId = String(bodyJson.message.chat.id);
        const text = (bodyJson.message.text || "").trim();
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase();

        const adminPass = env.ADMIN_PASSWORD || "";
        const operatorPass = env.OPERATOR_PASSWORD || "";

        // 🔑 2. Обработка команды /login
        if (cmd === "/login") {
          const roleArg = (parts[1] || "").toLowerCase();
          const passArg = parts[2] || "";

          if (roleArg === "admin" && adminPass && passArg === adminPass) {
            await env.BILLIARDS_KV.put(`role:${chatId}`, "ADMIN");
            ctx.waitUntil(sendTelegramMessage(env, chatId, "✅ <b>Успешно!</b> Вам предоставлены права <b>Администратора</b>."));
            return new Response("OK", { status: 200 });
          } 
          else if (roleArg === "operator" && operatorPass && passArg === operatorPass) {
            await env.BILLIARDS_KV.put(`role:${chatId}`, "OPERATOR");
            ctx.waitUntil(sendTelegramMessage(env, chatId, "✅ <b>Успешно!</b> Вам предоставлены права <b>Оператора</b> (режим чтения и мониторинга)."));
            return new Response("OK", { status: 200 });
          } 
          else {
            ctx.waitUntil(sendTelegramMessage(env, chatId, "❌ <b>Ошибка!</b> Неверная роль или пароль."));
            return new Response("OK", { status: 200 });
          }
        }

        // 🛡️ 3. Проверка роли пользователя в KV
        const userRole = await env.BILLIARDS_KV.get(`role:${chatId}`);

        if (!userRole) {
          ctx.waitUntil(sendTelegramMessage(env, chatId, "🔒 <b>Доступ ограничен.</b> Пожалуйста, авторизуйтесь у администратора клуба."));
          return new Response("OK", { status: 200 });
        }

        const targetTableNum = parts[1];
        const argValue = parts[2] ? Number(parts[2]) : null;

        // 💳 4. Команда запроса информации о последнем платеже: /last_payment 1
        if (cmd === "/last_payment") {
          if (!targetTableNum) {
            ctx.waitUntil(sendTelegramMessage(env, chatId, "❌ <b>Ошибка:</b> Укажите номер стола!\nПример: <code>/last_payment 1</code>"));
            return new Response("OK", { status: 200 });
          }

          const paymentDataStr = await env.BILLIARDS_KV.get(`last_payment:table_${targetTableNum}`);
          if (!paymentDataStr) {
            ctx.waitUntil(sendTelegramMessage(env, chatId, `ℹ️ Для стола №${targetTableNum} пока нет данных о платежах.`));
            return new Response("OK", { status: 200 });
          }

          const pay = JSON.parse(paymentDataStr);
          const dateStr = new Date(pay.timestamp * 1000).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" });
          const statusText = pay.completed 
            ? "🟢 <b>Успешно завершена</b> (время отыграно полностью)" 
            : "🔴 <b>Не доиграна / Прервана</b> (свет погас или сеанс сброшен)";

          const report = 
            `<b>💳 Последний платеж: Стол №${targetTableNum}</b>\n\n` +
            `💰 <b>Сумма:</b> ${pay.amount} сом\n` +
            `👤 <b>Плательщик:</b> ${pay.payer}\n` +
            `⏱ <b>Дата/Время:</b> ${dateStr}\n` +
            `📌 <b>Статус сессии:</b> ${statusText}`;

          ctx.waitUntil(sendTelegramMessage(env, chatId, report));
          return new Response("OK", { status: 200 });
        }

        // Команды статуса
        if (text.includes("Получить информацию") || cmd === "/status" || cmd === "/start") {
          const topic = cmd === "/status" && parts[1] 
            ? `billiards/${env.CLUB_PREFIX}_table${parts[1]}/cmd` 
            : "billiards/all/cmd";
          ctx.waitUntil(sendMqttWebSocket(env, topic, { event: "REQUEST_STATUS", requestedBy: chatId }));
          return new Response("OK", { status: 200 });
        }

        // 🛑 Управление (Только ADMIN)
        const managementCommands = ["/reset", "/test_light", "/resetcash", "/setprice", "/setmin"];
        if (managementCommands.includes(cmd)) {
          if (userRole !== "ADMIN") {
            ctx.waitUntil(sendTelegramMessage(env, chatId, "⛔ <b>Отказано в доступе:</b> Управление доступно только Администраторам."));
            return new Response("OK", { status: 200 });
          }

          if (!targetTableNum) {
            ctx.waitUntil(sendTelegramMessage(env, chatId, `❌ <b>Ошибка:</b> Не указан номер стола!\nПример: <code>${cmd} 1</code>`));
            return new Response("OK", { status: 200 });
          }

          // Динамический топик с использованием env.CLUB_PREFIX
          const targetTopic = `billiards/${env.CLUB_PREFIX}_table${targetTableNum}/cmd`;

          if (cmd === "/reset") {
            const kvKey = `last_payment:table_${targetTableNum}`;
            const existing = await env.BILLIARDS_KV.get(kvKey);
            if (existing) {
              let payObj = JSON.parse(existing);
              payObj.completed = false;
              await env.BILLIARDS_KV.put(kvKey, JSON.stringify(payObj));
            }

            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, { event: "RESET_SESSION", requestedBy: chatId }));
          } else if (cmd === "/test_light") {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, { event: "TEST_LIGHT", requestedBy: chatId }));
          } else if (cmd === "/resetcash") {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, { event: "RESET_CASH", requestedBy: chatId }));
          } else if (cmd === "/setprice" && argValue !== null) {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, { event: "SET_PRICE_1H", value: argValue, requestedBy: chatId }));
          } else if (cmd === "/setmin" && argValue !== null) {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, { event: "SET_MIN_THRESHOLD", value: argValue, requestedBy: chatId }));
          }
        }
      }

      // 💳 5. Входящий Webhook от Finik (Платежи)
      const { status, amount, transactionId, transactionType, fields } = bodyJson;
      if (status === "SUCCEEDED" && transactionType === "DEBIT") {
        const payerName = fields?.qrComment || "Неизвестный";
        const tableName = fields?.name || "Стол №1";

        let deviceId = fields?.qrId;
        let tableNum = "1";
        if (!deviceId) {
          const tableMatch = tableName.match(/(?:стол|№)\s*(\d+)/i) || tableName.match(/(\d+)(?!.*\d)/);
          tableNum = tableMatch ? tableMatch[1] : "1";
          deviceId = `${env.CLUB_PREFIX}_table${tableNum}`;
        } else {
          const match = deviceId.match(/(\d+)/);
          if (match) tableNum = match[1];
        }

        const paymentInfo = {
          amount: Number(amount),
          txId: transactionId,
          payer: payerName,
          timestamp: Math.floor(Date.now() / 1000),
          completed: false 
        };
        await env.BILLIARDS_KV.put(`last_payment:table_${tableNum}`, JSON.stringify(paymentInfo));

        const targetTopic = `billiards/${deviceId}/cmd`;
        const payload = {
          event: "PAYMENT_SUCCESS",
          amount: Number(amount),
          txId: transactionId,
          payer: payerName,
          deviceId: deviceId,
          tableName: tableName,
          timestamp: paymentInfo.timestamp
        };

        console.log(`🚀 Payment success! Publishing to [${targetTopic}]`);
        ctx.waitUntil(sendMqttWebSocket(env, targetTopic, payload));
      }

      // 📡 6. Входящие сообщения от ESP32 (окончание времени)
      try {
        if (bodyJson.event === "SESSION_EXPIRED" && bodyJson.tableNum) {
          const kvKey = `last_payment:table_${bodyJson.tableNum}`;
          const existing = await env.BILLIARDS_KV.get(kvKey);
          if (existing) {
            let payObj = JSON.parse(existing);
            payObj.completed = true;
            await env.BILLIARDS_KV.put(kvKey, JSON.stringify(payObj));
          }
        }
      } catch (e) {}

      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    } catch (err: any) {
      console.error("Webhook error:", err);
      return new Response(`Server Error: ${err.message}`, { status: 500 });
    }
  }
};

async function sendMqttWebSocket(env: Env, topic: string, payload: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const host = (env.MQTT_BROKER_URL || "")
      .replace(/^wss:\/\//, "")
      .replace(/^mqtts:\/\//, "")
      .replace(/^https:\/\//, "")
      .replace(/:8883$/, "")
      .replace(/:8084$/, "")
      .replace(/\/mqtt$/, "")
      .trim();

    const username = env.MQTT_USER?.trim() || "";
    const password = env.MQTT_PASS?.trim() || "";
    const clientId = `cf_worker_${Math.random().toString(16).substring(2, 8)}`;

    const wsUrl = `wss://${host}:8084/mqtt`;

    const client = mqtt.connect(wsUrl, {
      clientId: clientId,
      username: username,
      password: password,
      connectTimeout: 8000,
      reconnectPeriod: 0,
      clean: true,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      client.end(true);
      reject(new Error("MQTT WebSocket Connection Timeout"));
    }, 9000);

    client.on("connect", () => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        clearTimeout(timeout);
        client.end(true);
        if (err) {
          console.error("❌ Publish Error:", err);
          reject(err);
        } else {
          console.log(`✅ Successfully published to [${topic}] via EMQX WSS!`);
          resolve();
        }
      });
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      client.end(true);
      console.error("❌ MQTT Connection Error:", err);
      reject(err);
    });
  });
}

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    })
  });

  if (!response.ok) {
    console.error("❌ Failed to send Telegram message:", await response.text());
  }
}
