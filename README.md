# tool-vision-followups

Tool externa (inspección visual + automatización de seguimientos) que habla
con la plataforma IsoTools **solo por HTTP**. No vive dentro del repo
IsoTools, no hace push ni PR ahí.

Implementa 2 tools registradas en el catálogo de la plataforma:

- **`inspect_product_quality`** — consume `FRAME_CAPTURED`, compara contra
  el template activo por similitud de imagen, produce `PRODUCT_INSPECTION_PASSED`
  o `DEFECT_FOUND` (o `INSPECTION_TEMPLATE_MISSING` / `INSPECTION_IMAGE_UNAVAILABLE`).
- **`automate_followups`** — consume `8D_REPORT_ISSUED` / `PROJECT_AT_RISK`,
  crea tareas de seguimiento con dueños y vencimientos, produce `FOLLOWUP_SCHEDULED`.

## Setup

1. `npm install`
2. `cp .env.example .env` y completar:
   - `CORE_BASE_URL` — ya viene con la URL real de Railway.
   - `API_KEY` — ver sección "API key" abajo.
   - `DATABASE_URL` — apunta a la base propia de esta tool (no la de la plataforma).
3. `docker compose up -d` — levanta la base propia (bookkeeping: templates,
   inspecciones, seguimientos, cursor de polling). Aplica `db/init.sql` solo.
4. `npm run start` — arranca el polling contra `/events/subscriptions/:toolId`.

## Tests locales (sin HTTP, llaman al handler directo)

```
npm run test:vision
npm run test:followups
```

Requieren la base propia arriba (paso 3).

## API key

Esta tool no trae su propia key: la genera cada programador y el admin
(Carlos) la activa en Railway vía `BOOTSTRAP_API_KEY`. Una sola key sirve
para ambas tools (el scope es por `events:read`/`events:write`, no por tool
individual).

## Nota sobre `defectFound`

El campo `data.defectFound` de `DEFECT_FOUND` se dejó deliberadamente en
camelCase (el resto de `data` es snake_case) porque las reglas
`rule-vision-004` y `rule-pkg-001` en `communication-rules.json` de la
plataforma evalúan literalmente `defectFound == true`. Ver comentario en
[`src/tools/inspect_product_quality.js`](src/tools/inspect_product_quality.js).
