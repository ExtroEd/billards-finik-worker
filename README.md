# ⚡ Billiards Club Cloudflare Worker (Backend & Bot)

<div align="center">

  <p><b>Serverless backend, payment webhook processor, and Telegram bot router for automated billiard clubs.</b></p>
  
  <p>
    <img src="https://img.shields.io/badge/Runtime-Cloudflare%20Workers-f38020?style=for-the-badge&logo=cloudflare" alt="Cloudflare Workers">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178c6?style=for-the-badge&logo=typescript" alt="TypeScript">
    <img src="https://img.shields.io/badge/Protocol-MQTT%20over%20WSS-0066cc?style=for-the-badge&logo=mqtt" alt="MQTT">
    <img src="https://img.shields.io/badge/Interface-Telegram%20Bot-2ca5e0?style=for-the-badge&logo=telegram" alt="Telegram">
    <img src="https://img.shields.io/badge/License-GNU%20GPLv3-blue.svg?style=for-the-badge" alt="License">
  </p>
</div>

---

## 🌟 Overview

This repository contains the cloud backend service for the **IoT Billiards Club Management System**. Built on **Cloudflare Workers** using **TypeScript**, it acts as the secure bridge between external payment gateways (Finik), administrators via Telegram, and the physical ESP32 table hardware connected through an **EMQX MQTT broker**.

---

## 🔄 Core Features & Workflow

1. **Payment Processing (Finik Webhooks):**
   - Receives real-time debit transaction webhooks (`SUCCEEDED`).
   - Automatically parses table numbers and client names.
   - Publishes a secure `PAYMENT_SUCCESS` command via MQTT (WebSockets) to the specific hardware node.

2. **Telegram Bot Integration & Command Router:**
   - Handles incoming requests from the club's Telegram bot.
   - Supports role-based authentication (`/login admin` / `/login operator`) backed by **Cloudflare KV**.
   - Dispatches remote management commands (`/reset`, `/test_light`, `/resetcash`, `/setprice`, `/setmin`) to individual tables using dynamic club prefixes.

---

## 🛠️ Tech Stack

* **Core Runtime:** Cloudflare Workers (V8 Serverless JavaScript/TypeScript environment)
* **Storage:** Cloudflare KV (for role-based access control binding)
* **Messaging:** `mqtt` npm package over Secure WebSockets (`WSS` via port 8084)
* **Tooling:** Wrangler CLI, Vitest, Prettier

---

## 📂 Project Structure

```text
├── src/
│   └── index.ts            # Main worker script (Webhook & Telegram router)
├── .editorconfig           # Coding style configurations
├── .prettierrc             # Code formatter rules
├── package.json            # Dependencies & scripts
├── tsconfig.json           # TypeScript configuration
├── vitest.config.mts       # Unit testing configuration
├── wrangler.jsonc          # Cloudflare Worker configuration & environment bindings
└── wrangler.jsonc.example  # Template for environment configuration

```

---

## 🚀 Getting Started & Deployment

### Prerequisites

* Node.js & npm installed
* [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) authenticated with your Cloudflare account

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone [https://github.com/your-username/billiards-finik-worker.git](https://github.com/your-username/billiards-finik-worker.git)
cd billiards-finik-worker
npm install

```

### 2. Configuration

Copy the configuration template and fill in your secrets, broker URLs, and Telegram tokens:

```bash
cp wrangler.jsonc.example wrangler.jsonc

```

*(Make sure to configure your `MQTT_BROKER_URL`, `TG_BOT_TOKEN`, passwords, and KV namespace ID inside `wrangler.jsonc`)*

### 3. Local Development

Run the worker locally for testing:

```bash
npx wrangler dev

```

### 4. Deployment to Cloudflare

Deploy your worker to the edge network:

```bash
npx wrangler deploy

```

---

## 📄 License

This project is open-source and available under the terms of the [GNU General Public License v3.0](https://www.google.com/search?q=LICENSE).
