# Kick Chat WebSocket Setup (OAuth Yok)

## Quick Start (ID ile baslangic)

1. `.env.example` dosyasini `.env` olarak kopyala.
2. `.env` icinde mutlaka su iki degeri doldur:
   - `KICK_BROADCASTER_USER_ID`
   - `KICK_CHATROOM_ID`
3. Sunucuyu baslat: `docker compose up -d --build`
4. Durumu kontrol et: `http://localhost/api/kick/status`

## Gerekli Environment Degiskenleri

- `KICK_BROADCASTER_USER_ID` (zorunlu)
- `KICK_CHATROOM_ID` (zorunlu)

Opsiyonel:

- `KICK_WHITELIST` (virgulle ayrilmis username listesi)
- `KICK_WS_APP_KEY`, `KICK_WS_CLUSTER`, `KICK_WS_PROTOCOL`, `KICK_WS_CLIENT`, `KICK_WS_VERSION`
- `KICK_WS_RECONNECT_BASE_MS`, `KICK_WS_RECONNECT_MAX_MS`, `KICK_WS_PING_INTERVAL_MS`

Not:

- `KICK_BROADCASTER_SLUG` akisi kullanilmadan da sistem calisir.
- Global `KICK_COMMAND_PREFIX` yerine komut/prefix ayarlari panelden yonetilir.

## Komut ve Prefix Yonetimi

- Admin panelde `Komutlar` sekmesine gir.
- Her komut icin `prefix` ve `keyword` ayarini panelden degistir.
- Tek tek veya toplu kaydet:
  - `Bolumu Kaydet`
  - `Hepsini Kaydet`
- Varsayilana donmek icin:
  - `Varsayilana Don`

Kullanim kurali:

- Prefix `!` gibi tek karakterse komut: `!komut`
- Prefix `!ft` gibi uzunsa komut: `!ft komut`

## Endpoint

- `GET /api/kick/status`

## Notlar

- Bu modda chat'e bot cevabi gonderilmez.
- Komut sonucu ve hatalar server log'u ve `/api/kick/status` uzerinden takip edilir.
- Log izleme: `docker compose logs -f app`
