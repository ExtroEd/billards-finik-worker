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
            ctx.waitUntil(sendTelegramMessage(env, chatId, "✅ <b>Успешно!</b> Вам предоставлены права <b>Оператора</b>."));
            return new Response("OK", { status: 200 });
          } 
          else {
            ctx.waitUntil(sendTelegramMessage(env, chatId, "❌ <b>Ошибка!</b> Неверная роль или пароль."));
            return new Response("OK", { status: 200 });
          }
        }

        const userRole = await env.BILLIARDS_KV.get(`role:${chatId}`);
        if (!userRole) {
          ctx.waitUntil(sendTelegramMessage(env, chatId, "🔒 <b>Доступ ограничен.</b> Авторизуйтесь у администратора."));
          return new Response("OK", { status: 200 });
        }

        const targetTableNum = parts[1];
        const argValue = parts[2] ? Number(parts[2]) : null;

        if (text.includes("Получить информацию") || cmd === "/status" || cmd === "/start") {
          const topic = cmd === "/status" && parts[1] 
            ? `billiards/${env.CLUB_PREFIX}_table${parts[1]}/cmd` 
            : "billiards/all/cmd";
          ctx.waitUntil(publishOrQueue(env, topic, { event: "REQUEST_STATUS", requestedBy: chatId }, `cmd_${Date.now()}`));
          return new Response("OK", { status: 200 });
        }

        const managementCommands = ["/reset", "/test_light", "/resetcash", "/setprice", "/setmin"];
        if (managementCommands.includes(cmd)) {
          if (userRole !== "ADMIN") {
            ctx.waitUntil(sendTelegramMessage(env, chatId, "⛔ <b>Отказано в доступе.</b>"));
            return new Response("OK", { status: 200 });
          }

          if (!targetTableNum) {
            ctx.waitUntil(sendTelegramMessage(env, chatId, `❌ <b>Ошибка:</b> Не указан номер стола!`));
            return new Response("OK", { status: 200 });
          }

          const targetTopic = `billiards/${env.CLUB_PREFIX}_table${targetTableNum}/cmd`;
          const actionId = `mgmt_${cmd}_${Date.now()}`;

          if (cmd === "/reset") {
            ctx.waitUntil(publishOrQueue(env, targetTopic, { event: "RESET_SESSION", requestedBy: chatId }, actionId));
          } else if (cmd === "/test_light") {
            ctx.waitUntil(publishOrQueue(env, targetTopic, { event: "TEST_LIGHT", requestedBy: chatId }, actionId));
          } else if (cmd === "/resetcash") {
            ctx.waitUntil(publishOrQueue(env, targetTopic, { event: "RESET_CASH", requestedBy: chatId }, actionId));
          } else if (cmd === "/setprice" && argValue !== null) {
            ctx.waitUntil(publishOrQueue(env, targetTopic, { event: "SET_PRICE_1H", value: argValue, requestedBy: chatId }, actionId));
          } else if (cmd === "/setmin" && argValue !== null) {
            ctx.waitUntil(publishOrQueue(env, targetTopic, { event: "SET_MIN_THRESHOLD", value: argValue, requestedBy: chatId }, actionId));
          }
        }
      }

      // 💳 4. Входящий Webhook от Finik (Платежи) с защитой от дублей
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

        const targetTopic = `billiards/${deviceId}/cmd`;
        const payload = {
          event: "PAYMENT_SUCCESS",
          amount: Number(amount),
          txId: transactionId,
          payer: payerName,
          deviceId: deviceId,
          tableName: tableName,
          timestamp: Math.floor(Date.now() / 1000)
        };

        // Уникальный ID платежа для предотвращения дублирования
        const uniqueTxKey = `pay_tx_${transactionId}`;
        
        console.log(`🚀 Payment success for TX: ${transactionId}. Publishing to [${targetTopic}]`);
        
        // Отправляем с защитой через очередь и проверкой дубликатов
        ctx.waitUntil(publishOrQueue(env, targetTopic, payload, uniqueTxKey));
      }

      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    } catch (err: any) {
      console.error("Webhook error:", err);
      return new Response(`Server Error: ${err.message}`, { status: 500 });
    }
  }
};

/**
 * Безопасная публикация в MQTT. Если связь упала — сохраняет в KV под уникальным ID (без дублей).
 */
async function publishOrQueue(env: Env, topic: string, payload: any, uniqueId: string): Promise<void> {
  try {
    // Пытаемся отправить сразу
    await sendMqttWebSocket(env, topic, payload);
    
    // Если успешно ушло, пробуем попутно прочистить старые зависшие задачи из очереди
    ctx_processQueueAsync(env);
  } catch (err) {
    console.warn(`⚠️ MQTT недоступен для [${uniqueId}], сохраняем в KV очередь:`, err);
    // Сохраняем в KV с префиксом queue:, чтобы защититься от дубликатов по uniqueId
    await env.BILLIARDS_KV.put(`queue:${uniqueId}`, JSON.stringify({ topic, payload }), {
      expirationTtl: 86400 // Хранить до 24 часов
    });
  }
}

// Фоновый прогон очереди без блокировки основного ответа
function ctx_processQueueAsync(env: Env) {
  // Запускаем асинхронно без await, чтобы не задерживать ответ
  processKvQueue(env).catch(e => console.error("Queue process error:", e));
}

async function processKvQueue(env: Env): Promise<void> {
  const list = await env.BILLIARDS_KV.list({ prefix: "queue:" });
  if (!list || list.keys.length === 0) return;

  for (const keyInfo of list.keys) {
    const dataStr = await env.BILLIARDS_KV.get(keyInfo.name);
    if (!dataStr) {
      await env.BILLIARDS_KV.delete(keyInfo.name);
      continue;
    }

    try {
      const { topic, payload } = JSON.parse(dataStr);
      await sendMqttWebSocket(env, topic, payload);
      // Успешно ушло — удаляем из очереди
      await env.BILLIARDS_KV.delete(keyInfo.name);
      console.log(`✅ Восстановлено из очереди KV: ${keyInfo.name}`);
    } catch (e) {
      // Брокер снова недоступен — прерываем цикл, попробуем в следующий раз
      break;
    }
  }
}

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
      connectTimeout: 6000,
      reconnectPeriod: 0,
      clean: true,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      client.end(true);
      reject(new Error("MQTT WebSocket Connection Timeout"));
    }, 7000);

    client.on("connect", () => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        clearTimeout(timeout);
        client.end(true);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      client.end(true);
      reject(err);
    });
  });
}

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML" })
  });
}
