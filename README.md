# local-chat

Продуктовый слой корпоративного чата: JWT + Vue/Chotto UI + BFF, связь с Chat3 **только по gRPC**.

## Структура

```
local-chat/
  apps/server   # Express + WS + JWT + gRPC client
  apps/web      # Vue 3 + @mobilon-dev/chotto
  vendor/       # chat3_user.proto
```

## Локальный запуск через Docker

Из `../run_local` (порты mongo/rmq смещены, чтобы не конфликтовать с другими стеками):

```bash
cd ../run_local
cp -n .env.example .env   # при необходимости
./scripts/up.sh   # или:
docker compose --profile chat3 --profile apps up -d --build
```

Открыть: **http://localhost:5173** (или `LOCAL_CHAT_WEB_PORT` из `.env`)

1. Зарегистрировать двух пользователей (login + имя + пароль)  
2. «Новый DM» → логин второго  
3. Отправить сообщение  

API напрямую: http://localhost:4000/health  

## Dev без Docker (web)

```bash
# стек chat3 уже поднят
cd apps/server && npm i && CHAT3_GRPC_URL=127.0.0.1:50051 \
  CHAT3_API_KEY=... CHAT3_TENANT_ID=tnt_localchat \
  LOCAL_CHAT_MONGO_URI=mongodb://127.0.0.1:27027/local_chat \
  npm run dev

cd apps/web && npm i && npm run dev
```
