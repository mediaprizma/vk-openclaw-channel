# Диагностика VK-канала

## Ошибка Code №100: reply_to not integer

### Симптом

Входящее личное сообщение VK корректно создаёт сессию OpenClaw. Агент получает сообщение и вызывает отправку ответа, но VK отвечает:

~~~
Code №100 - One of the parameters specified was missing or invalid: reply_to not integer
~~~

При этом прямой `openclaw message send --channel vk-openclaw-channel --target <VK_USER_ID> ...` работает, новая вручную созданная сессия работает, а ошибка появляется именно в сессии, созданной входящим VK-сообщением.

### Причина

OpenClaw при обработке входящего сообщения сохраняет threading/reply-контекст. Для обычного VK DM этот контекст не нужен: сообщение должно отправляться просто в `peer_id`, без параметра VK API `messages.send.reply_to`.

Не нужно исправлять это добавлением `replyTo` в prompt или конфигурацию. VK `reply_to` принимает только корректный целочисленный ID сообщения.

### Правильное исправление

В `src/channel.ts` VK-адаптер должен явно отключать неявный reply threading для обычных исходящих сообщений:

~~~ts
threading: {
  resolveReplyToMode: () => "off" as const,
  buildToolContext: ({ context, hasRepliedRef }) => ({
    currentChannelId: context.To?.trim() || undefined,
    currentMessageId: undefined,
    replyToMode: "off" as const,
    hasRepliedRef,
  }),
},
~~~

Это сохраняет текущий target канала, но не позволяет OpenClaw автоматически превращать ID входящего сообщения в `replyTo`.

Дополнительно в `src/send.ts` перед вызовом VK API необходимо валидировать `replyTo`: пустое, нечисловое, NaN, отрицательное и нулевое значение не передавать. `reply_to` передаётся только для положительного безопасного целого числа.

~~~ts
const replyToRaw = params.opts?.replyTo?.trim();
const replyToNumber =
  replyToRaw && /^\d+$/.test(replyToRaw) ? Number(replyToRaw) : undefined;

const validReplyTo =
  replyToNumber !== undefined &&
  Number.isSafeInteger(replyToNumber) &&
  replyToNumber > 0
    ? replyToNumber
    : undefined;

...

...(validReplyTo !== undefined ? { reply_to: validReplyTo } : {}),
~~~

При невалидном значении его следует проигнорировать и записать диагностический лог, а не отправлять его в VK API.

### Важное различие

Публичные комментарии не используют обычный `messages.send.reply_to`. Для них используется отдельный VK API-механизм `reply_to_comment` в специализированном пути отправки комментария.

Поэтому защиту в `send.ts` нельзя распространять так, чтобы она ломала существующую отправку ответов на публичные комментарии.

### Проверка после изменения

~~~bash
git pull --ff-only
npm test
npm run build
openclaw gateway restart
~~~

Затем проверить: новое VK ЛС → новая клиентская сессия → агент вызывает message/send → ответ приходит клиенту. Для обычного DM параметр `reply_to` в VK API отсутствует.

Отдельно проверить публичный комментарий: ответ должен остаться публичным ответом именно на текущий комментарий.

### Если ошибка повторится

Сначала проверить, что установленная версия содержит защиту в `src/send.ts` и threading override в `src/channel.ts`, затем проверить собранный `dist` и перезапустить Gateway.

Не следует сразу менять VK ID, session key или добавлять `replyTo` в prompt: это не является причиной этой ошибки.

### История исправления

Основной защитный фикс: `0039e240c7a00d75d65a9469c0961c3e3c2ab5ca`.

Он гарантирует, что malformed `replyTo` не попадёт в VK `messages.send`.