import mqtt from "mqtt";

export interface Env {
  MQTT_BROKER_URL: string;
  MQTT_USER: string;
  MQTT_PASS: string;
  TG_CHEF_CHAT_ID: string;
  TG_DEV_CHAT_ID: string;
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

        const isChef = chatId === env.TG_CHEF_CHAT_ID;
        const isDev = chatId === env.TG_DEV_CHAT_ID;

        if (isChef || isDev) {
          const parts = text.split(" ");
          const cmd = parts[0].toLowerCase();
          const targetTableNum = parts[1] || "4"; // По умолчанию стол №4, если не указан
          const argValue = parts[2] ? Number(parts[2]) : null;

          const targetTopic = `billiards/klubnyy15_table${targetTableNum}/cmd`;

          // 📊 Запрос отчёта
          if (text.includes("Получить информацию") || cmd === "/status" || cmd === "/start") {
            // Если надали кнопку "Получить информацию", шлем запрос во все столы или в конкретный
            const topic = cmd === "/status" && parts[1] ? targetTopic : "billiards/all/cmd";
            ctx.waitUntil(sendMqttWebSocket(env, topic, {
              event: "REQUEST_STATUS",
              requestedBy: chatId
            }));
          } 
          // 🧹 Сброс времени/сессии стола (/reset 4)
          else if (cmd === "/reset") {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, {
              event: "RESET_SESSION",
              requestedBy: chatId
            }));
          } 
          // 💰 Инкассация/Сброс кассы (/resetcash 4)
          else if (cmd === "/resetcash") {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, {
              event: "RESET_CASH",
              requestedBy: chatId
            }));
          } 
          // ⚙️ Смена цены за 1 час (/setprice 4 200)
          else if (cmd === "/setprice" && argValue) {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, {
              event: "SET_PRICE_1H",
              value: argValue,
              requestedBy: chatId
            }));
          } 
          // 🎯 Смена минимального старта (/setmin 4 50)
          else if (cmd === "/setmin" && argValue) {
            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, {
              event: "SET_MIN_THRESHOLD",
              value: argValue,
              requestedBy: chatId
            }));
          }
        }
        return new Response("OK", { status: 200 });
      }

      // 💳 2. Входящий Webhook от Finik (Платежи)
      const { status, amount, transactionId, transactionType, fields } = bodyJson;
      if (status === "SUCCEEDED" && transactionType === "DEBIT") {
        const payerName = fields?.qrComment || "Неизвестный";
        const tableName = fields?.name || "Стол №1";

        let deviceId = fields?.qrId;
        if (!deviceId) {
          const tableMatch = tableName.match(/(?:стол|№)\s*(\d+)/i) || tableName.match(/(\d+)(?!.*\d)/);
          const tableNum = tableMatch ? tableMatch[1] : "4";
          deviceId = `klubnyy15_table${tableNum}`;
        } else if (deviceId === "table_4") {
          deviceId = "klubnyy15_table4";
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

        console.log(`🚀 Payment success! Publishing to [${targetTopic}]`);
        ctx.waitUntil(sendMqttWebSocket(env, targetTopic, payload));
      }

      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });

    } catch (err: any) {
      console.error("Webhook processing error:", err);
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
