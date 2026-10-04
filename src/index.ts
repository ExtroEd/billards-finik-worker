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
        const text = bodyJson.message.text || "";

        const isChef = chatId === env.TG_CHEF_CHAT_ID;
        const isDev = chatId === env.TG_DEV_CHAT_ID;

        if (isChef || isDev) {
          if (text.includes("Получить информацию") || text.includes("/status") || text.includes("/start")) {
            console.log(`🤖 Telegram command from ${isChef ? "Chef" : "Dev"}: ${text}`);

            const targetTopic = "billiards/all/cmd";
            const payload = {
              event: "REQUEST_STATUS",
              requestedBy: chatId
            };

            ctx.waitUntil(sendMqttWebSocket(env, targetTopic, payload));
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

/**
 * Публикация через WebSocket MQTT для EMQX
 */
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
      rejectUnauthorized: false // Предотвращает ошибки сертификатов со стороны Worker
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
