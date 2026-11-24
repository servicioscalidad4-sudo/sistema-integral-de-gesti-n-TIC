# Sistema Integral de Activos – Jardines del Renacer

Frontend estático (`index.html`, `css/`, `js/`) + API serverless en `api/` (Node 20, sin dependencias).

## Por qué fallaba el login (404)
El repositorio solo tenía el frontend. `POST /api/auth/login` no existía en Vercel y devolvía 404.
Ahora `vercel.json` reescribe `/api/*` hacia `api/index.js`, que implementa todos los endpoints que usa `js/app.js`.

## Despliegue
1. Suba TODO el contenido de esta carpeta a la raíz del repositorio de GitHub (incluye `api/`, `vercel.json`, `package.json`).
2. En Vercel: Framework Preset **Other**, sin Build Command ni Output Directory. Vercel redepliega solo.
3. Variables de entorno (Settings → Environment Variables):
   - `JWT_SECRET` → cadena larga y aleatoria (obligatorio en producción).
   - `ALLOWED_EMAIL_DOMAIN` → opcional; por defecto `jardinesdelrenacer.com` (use `*` para permitir cualquier correo).
4. Prueba rápida: abra `https://SU-APP.vercel.app/api/health` → debe responder `{"ok":true,...}`.

## Persistencia de datos (importante)
- Sin configurar nada, los datos viven en memoria: se reinician en cada nuevo arranque de la función.
- Para guardar datos de forma permanente: Vercel → Storage → **Upstash Redis** → conectar al proyecto.
  Se crean solas `KV_REST_API_URL` / `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_*`) y la API las usa automáticamente. Vuelva a desplegar.

## Credenciales de prueba
| Usuario | Contraseña | Rol |
|---|---|---|
| admin@jardinesdelrenacer.com | admin123 | Administrador |
| coordinador.risaralda@jardinesdelrenacer.com | coord123 | Coordinador (Risaralda) |
| calidad@jardinesdelrenacer.com | calidad123 | Calidad / Auditor |

**Cambie estas contraseñas antes de usar datos reales.**

## Desarrollo local
`npx vercel dev` (sirve el frontend y la API juntos).
