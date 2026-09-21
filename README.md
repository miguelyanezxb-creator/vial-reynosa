# Vial Reynosa — GitHub + Cloudflare Workers + D1

Proyecto único: app pública, `/admin`, API Worker y base D1.

## Configuración inicial
1. Sube esta carpeta a un repositorio de GitHub.
2. En Cloudflare crea una base D1 llamada `vial-reynosa-db`.
3. Copia su Database ID y reemplaza `REEMPLAZAR_CON_ID_D1` en `wrangler.jsonc`.
4. Instala dependencias: `npm install`.
5. Inicializa D1: `npx wrangler d1 migrations apply vial-reynosa-db --remote`.
6. Crea el secreto del administrador: `npx wrangler secret put ADMIN_TOKEN`.
7. Despliega: `npm run deploy`.

También puedes conectar el repositorio de GitHub desde Cloudflare Workers Builds para despliegue automático.

## Importante
La interfaz aprobada está conservada en `public/`. La API real ya está preparada en `/api/*` y D1. En la siguiente integración se sustituyen los datos locales de la interfaz por estas rutas sin rediseñar la app.
