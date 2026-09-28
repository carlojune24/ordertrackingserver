# Production Order Tracking System

Fastify + TypeScript + Prisma API for RasCorp's QR-supported station workflow. See `Project Flow Phase 1.md` for the business spec.

## Local development

1. Copy `.env.example` to `.env` and fill in `DATABASE_URL` / `JWT_SECRET`.
2. `npm install`
3. `npx prisma migrate dev` — applies migrations to your local Postgres.
4. `npx prisma db seed` — creates one dev user per role (`staff@rascorp.test`, `supervisor@rascorp.test`, `management@rascorp.test`, password `DevPass123!`) plus a demo order.
5. `npm run dev` — starts the API on `http://localhost:3000/api/v1`.

## Roles

`PRODUCTION_STAFF` < `SUPERVISOR` < `MANAGEMENT`. Intake, scanning, QC decisions, and delivery outcomes are Staff+; order edits, QR regeneration, and reports are Supervisor+; user management is Management-only.

## Workflow

Order flows: Intake → Cutting → Sewing → Embroidery → QC → Packaging → Courier/Pick-up → Delivered/Returned. Every station move is a `POST /api/v1/scan/receive` then `POST /api/v1/scan/outgoing`, both validated server-side against the order's current stage (`src/lib/workflow.ts`). QC exits via `POST /api/v1/orders/:id/qc-decision` (approve → Packaging, or rework → Cutting/Sewing). Delivery result via `POST /api/v1/orders/:id/delivery-outcome` (Delivered, or Returned with a reason + responsible station, which reopens a visit there).

## Deployment (VPS, PM2 + Nginx, raw IP)

```bash
# On the VPS, first time only:
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx postgresql
sudo npm install -g pm2

# Create a dedicated DB role + database (first time only; don't reuse the postgres superuser)
sudo -u postgres psql -c "CREATE ROLE order_tracking_app WITH LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE order_tracking OWNER order_tracking_app;"

# Deploy
git clone <repo> /home/ubuntu/apps/order-tracking-server
cd /home/ubuntu/apps/order-tracking-server
cp .env.example .env   # DATABASE_URL uses the order_tracking_app role above; generate a fresh JWT_SECRET
npm ci
npm run build
npx prisma migrate deploy
npx prisma db seed      # first deploy only, to bootstrap accounts — then immediately change
                         # the seeded DevPass123! passwords via PATCH /users/:id (see Roles below)

pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup             # run the printed command once

sudo cp deploy/nginx-order-tracking.conf /etc/nginx/sites-available/order-tracking
sudo ln -s /etc/nginx/sites-available/order-tracking /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo ufw allow 8080/tcp

chmod +x deploy/backup-db.sh
mkdir -p /home/ubuntu/backups
crontab -l 2>/dev/null | { cat; echo "0 2 * * * /home/ubuntu/apps/order-tracking-server/deploy/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1"; } | crontab -
```

The API is then reachable at `http://51.79.159.222:8080/api/v1`. This VPS already hosts another site (washsuite, on port 80/443 with its own domain) — order-tracking runs on port 8080 instead of taking over port 80, so it never touches that site's routing. No domain/HTTPS yet for this app; add Let's Encrypt once a domain points here.

## Redeploying

```bash
git pull
npm ci
npm run build
npx prisma migrate deploy
pm2 restart order-tracking-server
```
