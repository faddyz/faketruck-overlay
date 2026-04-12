# FakeTruck Docker VPS Kurulumu (HTTPS + Admin Guvenligi)

Bu dokuman Docker tabanli calisma modelini anlatir.

## 1) VPS hazirlik

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

## 2) Ortam degiskenlerini hazirla

Ornek dosyayi kopyala:

```bash
cp .env.example .env
```

`.env` icinde su alanlari doldur:

- `DOMAIN`
- `ADMIN_USER`
- `ADMIN_PASSWORD_HASH`
- `STATE_WRITE_API_KEY`
- `CORS_ALLOWED_ORIGINS`

`ADMIN_PASSWORD_HASH` uretmek icin:

```bash
docker run --rm caddy:2.8-alpine caddy hash-password --plaintext "guclu-sifre"
```

## 3) DNS ayari

Domain `A` kaydini VPS IP adresine yonlendir.

## 4) Servisleri kaldir

```bash
docker compose up -d --build
```

## 5) Kontrol

```bash
docker compose ps
docker compose logs -f --tail=100
```

Calisma linkleri:

- `https://your-domain.com/road-overlay.html` (public)
- `https://your-domain.com/hud-overlay.html` (public)
- `https://your-domain.com/map-overlay.html` (public)
- `https://your-domain.com/admin.html` (Basic Auth korumali)

## 6) Bug fix deploy akisi

```bash
git pull
docker compose up -d --build
```

## 7) Reboot sonrasi

`restart: unless-stopped` sayesinde containerlar otomatik geri kalkar.
