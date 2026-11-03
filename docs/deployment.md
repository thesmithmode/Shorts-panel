# Развёртывание рядом со Stream Panel

## Разрешённая цель

Только VPS Stream Panel **23.95.166.119**. Aeza и RackNerd 120 владелец объявил недоступными; не использовать их, даже если ключи есть в архиве.

Предлагаемый адрес без покупки домена: `https://shorts-panel.23-95-166-119.sslip.io`. HTTPS через существующий Traefik. DNS, имя certificate resolver и entrypoint требуют живой проверки.

## Фактическое состояние (2026-11-03)

VPS проверен по SSH (Ubuntu 24.04, 2 vCPU, 3.3 GiB RAM, ~17 GiB свободно). Выполнен изолированный bootstrap, соседние службы не менялись:

- пользователи `shorts-panel` (служба, nologin) и `shorts-deploy` (только forced command);
- `/opt/shorts-panel/{releases,checkpoints}`, `/var/lib/shorts-panel` (0700), `/etc/shorts-panel/{server.env,health-host}`;
- receiver `/usr/local/lib/shorts-panel/{release.py,receive.sh}`, sudoers `/etc/sudoers.d/shorts-panel` только на receiver;
- `shorts-panel.service` установлена и включена, но не запущена до первого релиза из main;
- служба слушает `172.21.0.1:47921` (шлюз сети traefik-proxy, как Stream Panel); правило ufw только 172.21.0.2 → 172.21.0.1:47921;
- отдельный файл Traefik `/root/traefik/config/shorts-panel.yml` (router/service/middleware с префиксом shorts-panel).

GitHub: secrets `SHORTS_DEPLOY_KEY`, `SHORTS_DEPLOY_KNOWN_HOSTS`; variables `SHORTS_DEPLOY_HOST`, `SHORTS_DEPLOY_PORT`, `SHORTS_PUBLIC_ORIGIN`, `SHORTS_PRODUCTION_ENABLED=true`.

Релиз содержит собственный Node.js (`bin/node`) из CI: системный Node на VPS — 22. Receiver хранит 3 релиза и 3 checkpoint состояния, удаляет неудачный релиз и staging, первый релиз ставится без предыдущего current, повтор активного SHA идемпотентен.

Смена домена (например, DuckDNS для Google OAuth) требует согласованно поменять `SHORTS_PUBLIC_ORIGIN` в `/etc/shorts-panel/server.env`, Host в route-файле Traefik и variable репозитория.

## Последовательность после восстановления доступа

1. Сверить host key с предоставленным known_hosts, использовать только ключ нужного сервера. Не отключать StrictHostKeyChecking.
2. Выполнить `ops/preflight.sh`: только чтение. Проверить свободный диск, память, текущую Stream Panel, занятые порты и фактическую bridge-сеть/Traefik.
3. Прочитать нужные публичные параметры маршрутизации (entrypoints, resolver, mount/file provider), не печатая секреты и конфигурации OAuth. Сохранить состояние соседних служб для сравнения.
4. Проверить успешный CI точного коммита. Создать **нового** системного пользователя `shorts-panel`, каталоги `/opt/shorts-panel`, `/etc/shorts-panel`, `/var/lib/shorts-panel` с минимальным доступом.
5. Установить отдельную неизменяемую версию приложения и зависимости Node.js 24.19+/ffprobe. Не обновлять системные зависимости работающих соседних приложений вслепую.
6. Заполнить закрытый `/etc/shorts-panel/server.env` по примеру, используя проверенный адрес bridge и свободный порт 47921. Выбрать реальный бюджет видео после preflight, оставив резерв Stream Panel.
7. Задать отдельный пароль через stdin от пользователя новой службы. Не переиспользовать SSH/root-пароль и не записывать его в Git, команды или логи.
8. Установить **отдельную** `shorts-panel.service`. Проверить локальный healthz, парольный вход, запрет чужого Origin, загрузку и перезапуск с сохранением очереди.
9. Добавить **новый** route-файл Traefik по `ops/traefik.yml.example`; не менять глобальный Traefik, чужие routers, сертификаты и firewall без доказанной необходимости. Файл должен использовать фактические имена resolver/entrypoint.
10. Проверить DNS/TLS и весь путь браузер → API → локальный файл → SQLite. Повторить healthz и состояние Stream Panel и других служб.
11. При проблеме остановить только новую службу и убрать только её route. Исходники/базу сохранить; соседние службы не перезапускать.

Добавлен workflow `.github/workflows/deploy.yml`, допускающий только успешный CI точного main SHA; до настройки production receiver и явного включения переменной он выключен. Автоматическая установка неизвестной инфраструктуры не реализована: нельзя безопасно закодировать изменения неизвестной инфраструктуры по историческим данным. В репозитории есть CI и отдельные шаблоны службы/маршрута, но это не заявление о выполненном deployment.

## Эксплуатация

- Копировать SQLite согласованным snapshot/backup и отдельно сохранять `secret.key`; без ключа токены не восстановить.
- Не включать видео в многократные копии БД. Политику off-server копий исходников владелец пока не определил.
- Контролировать диск: неподключённый TikTok удерживает исходники, поэтому нельзя считать все файлы удаляемыми через сутки после загрузки.
- При неопределённом результате отправки проверить соцсеть, прежде чем разрешать повтор. Внешний успех не имитировать отметкой в UI.

## Подготовленный изолированный receiver

В dev добавлен `ops/release.py`: exact SHA, ограничение архива/распаковки, запрет ссылок и специальных файлов, lock, новая версия в отдельном каталоге, checkpoint только состояния Shorts Panel, переключение current и откат при провале health. Архив содержит runtime-зависимости из CI; на VPS не выполняется `npm install` от root. Receiver не меняет firewall, Traefik и чужие службы.

После живого preflight требуется root-owned установка receiver и `ops/receive.sh` в `/usr/local/lib/shorts-panel/`. Отдельный пользователь `shorts-deploy` должен иметь отдельный deploy key с forced command `/usr/local/lib/shorts-panel/receive.sh`, запретом PTY/forwarding и sudo-разрешением только на receiver. Это не root-ключ из присланного архива. Пользователь процесса `shorts-panel` не получает sudo и не может менять releases/receiver.

Проверенный IPv4 bridge или loopback для health записывается администратором в root-owned `/etc/shorts-panel/health-host`; health подтверждает exact SHA из release-sha. Перед включением production нужно выполнить пробный успешный релиз и аварийный откат на VPS. Локальные тесты проверяют архивы и восстановление предыдущего состояния, но не заменяют эту проверку.

Шаблон службы ограничивает CPU до 50%, память high/max 384/512 MiB, V8 heap 256 MiB, процессы 96, снижает CPU/IO priority. Фактическую совместимость cgroup и достаточность резерва диска проверить на VPS. Шаблон не применялся к серверу: SSH пока недоступен.
