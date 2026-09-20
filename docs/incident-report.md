# Incident report — KavkazMsk

Дата проверки: 2026-09-20.

Причина: в Worker доменные записи не имели отдельного глобального durable-хранилища и при отсутствии/ошибке `ADMIN_CHAT_ID` уведомление о pending listing терялось. В blueprint нет платёжной интеграции, payment record или subscription flag, поэтому платёжное состояние этим приложением не управлялось.

Исправление: домен нормализуется и хранится через глобальный `CHAT_DO` на Workers (с harness/Node fallback через toolkit session storage); записи профиля и очередь не доставленных уведомлений сохраняются вместе с доменом. Owner id читается через toolkit `adminChatId(ctx)` с Worker bindings; уведомления pending/report не теряют объявление при временной недоступности admin chat. Добавлены проверка телефона, редактирование собственных объявлений и безопасные проверки report/moderation.

Проверка: `npm run build` — успешно; `npm test` — 12 test files, 69 tests passed. Live Telegram token, webhook, payment database и CPU/memory/disk не доступны из этого workspace и намеренно не имитировались.
